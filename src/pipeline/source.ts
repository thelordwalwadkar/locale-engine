/**
 * From an input specification to a `SourceDocument`: ingest → language detection → source locale; plus documents rebuilt from earlier
 * outputs (`page.json`) or from a single source/target pair (validate mode).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedConfig } from '../config/load.js';
import { detectDocument, finalizeSourceLocale } from '../detect/index.js';
import { ingestInput } from '../ingest/index.js';
import { languageOf } from '../schemas/common.js';
import { LangDetectBatchWireSchema } from '../schemas/llm.js';
import type { InputSpec, PageJson, PipelineOptions, Segment, SourceDocument } from '../schemas/index.js';
import { PageJsonSchema } from '../schemas/report.js';
import { EngineError } from '../util/errors.js';
import { plainText } from '../util/inline.js';
import { hasNaturalLanguage, hashText } from '../util/text.js';
import type { DetectPayload } from './payloads.js';
import { loadGolden, loadTemplate, renderGolden, renderOutputContract, renderTemplate } from './prompt.js';
import type { RunContext } from './state.js';

export interface SourceDeps {
  config: LoadedConfig;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  allowPrivateNetworks?: boolean;
  documentLoader?: (spec: InputSpec) => Promise<SourceDocument>;
}

export type ContentInput = Exclude<InputSpec, { kind: 'page_json' }>;

export async function readPageJson(input: { path?: string | undefined; page?: PageJson | undefined }): Promise<PageJson> {
  if (input.page) return input.page;
  if (!input.path) throw new EngineError('INPUT_INVALID', 'page_json input needs either "path" or "page"');
  let raw: string;
  try {
    raw = await readFile(path.resolve(input.path), 'utf8');
  } catch {
    throw new EngineError('INPUT_INVALID', `cannot read page.json at ${input.path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new EngineError('INPUT_INVALID', `${input.path} is not valid JSON`);
  }
  const parsed = PageJsonSchema.safeParse(json);
  if (!parsed.success) {
    throw new EngineError('INPUT_INVALID', `${input.path} is not a page.json written by locale-engine: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

/** The source side of a page.json as a document (segments keep their ids, block types, order and inline tables). */
export function documentFromPage(page: PageJson, config: LoadedConfig): SourceDocument {
  const units = config.common.entities.symbol_units;
  const segments: Segment[] = page.locale.segments.map((r) => ({
    segment_id: r.segment_id,
    block_type: r.block_type,
    order: r.order,
    text: r.source_text,
    inline: r.inline,
    ...(r.level !== undefined ? { level: r.level } : {}),
    ...(r.meta_kind ? { meta_kind: r.meta_kind } : {}),
    ...(r.group ? { group: r.group } : {}),
    ...(r.href ? { href: r.href } : {}),
    ...(r.src ? { src: r.src } : {}),
    hash: hashText(r.source_text),
    translatable: hasNaturalLanguage(plainText(r.source_text), units),
    lang: { lang: r.source_lang, confidence: r.source_lang_confidence, method: 'inherited' },
  }));
  const kw = page.locale.seo_meta.primary_keyword;
  return {
    doc_id: page.source.doc_id,
    origin: { kind: 'page_json', ref: page.run_id },
    page_type: page.source.page_type,
    page_type_evidence: page.source.page_type_evidence,
    source_locale: page.source.source_locale,
    source_locale_evidence: `taken from page.json of run ${page.run_id}`,
    source_language: page.source.source_language,
    head: {},
    seo: kw ? { primary_keyword: { text: kw.source, origin: kw.source_origin } } : {},
    segments,
    warnings: [],
  };
}

export interface PairInput {
  source_text: string;
  source_locale: string;
  block_type: 'heading' | 'paragraph' | 'list_item' | 'table_cell' | 'alt' | 'anchor';
}

/** One source segment for `validate_content` with a source/target pair. */
export function documentFromPair(input: PairInput, config: LoadedConfig): SourceDocument {
  const lang = languageOf(input.source_locale);
  const prefix = { heading: 'h', paragraph: 'p', list_item: 'li', table_cell: 'td', alt: 'alt', anchor: 'a' }[input.block_type];
  const seg: Segment = {
    segment_id: `${prefix}-001`,
    block_type: input.block_type,
    order: 1,
    text: input.source_text,
    inline: {},
    hash: hashText(input.source_text),
    translatable: hasNaturalLanguage(plainText(input.source_text), config.common.entities.symbol_units),
    lang: { lang: lang, confidence: 1, method: 'declared' },
  };
  return {
    doc_id: `pair-${seg.hash}`,
    origin: { kind: 'text', ref: 'source/target pair' },
    page_type: 'CONTENT',
    page_type_evidence: 'single source/target pair',
    source_locale: input.source_locale,
    source_locale_evidence: 'declared by the caller',
    source_language: lang,
    head: {},
    seo: {},
    segments: [seg],
    warnings: [],
  };
}

/** URL / file / text → ingested, language-detected document. */
export async function loadSource(spec: ContentInput, run: RunContext, deps: SourceDeps, options: PipelineOptions): Promise<SourceDocument> {
  if (deps.documentLoader) return deps.documentLoader(spec);
  const { config } = deps;
  const contact = deps.env['LOCALE_CONTACT']?.trim();
  let doc = await ingestInput(spec, {
    ingest: config.stages.ingest,
    classification: config.stages.page_classification,
    symbolUnits: config.common.entities.symbol_units,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(contact ? { contact } : {}),
    ...(deps.allowPrivateNetworks ? { allowPrivateNetworks: true } : {}),
    ...(options.source_locale ? { sourceLocale: options.source_locale } : {}),
    ...(options.primary_keyword ? { primaryKeyword: options.primary_keyword } : {}),
    ...(options.page_type ? { pageType: options.page_type } : {}),
  });

  const dir = run.kit.promptsDir;
  const classify = async (items: Array<{ segment_id: string; text: string }>) => {
    const payload: DetectPayload = { stage: 'language_detection', candidates: ['nl', 'en', 'de', 'it'], segments: items };
    const out = await run.runner.call({
      stage: 'language_detection',
      locale: null,
      segments: items.length,
      segmentIds: items.map((i) => i.segment_id),
      system: (mode) =>
        renderTemplate(loadTemplate(dir, 'detect'), {
          candidates: 'nl, en, de, it',
          golden_exemplar: renderGolden(loadGolden(dir, 'language_detection'), mode),
          output_contract: renderOutputContract(dir, mode, LangDetectBatchWireSchema),
        }),
      payload,
      schema: LangDetectBatchWireSchema,
    });
    return out.results;
  };

  doc = await detectDocument(doc, {
    thresholds: { detection_confidence_min: config.stages.thresholds.detection_confidence_min, detection_min_words: config.stages.thresholds.detection_min_words },
    classify,
    ...(options.source_locale ? { declaredLanguage: languageOf(options.source_locale) } : {}),
  });
  return finalizeSourceLocale(doc, options.source_locale);
}
