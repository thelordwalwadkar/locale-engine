/**
 * Ingestion entry point: URL, file or raw text -> `SourceDocument`.
 *
 * The language of every segment and the document's `source_language` are filled in afterwards by `src/detect`; until then
 * `source_language` is the declared / attribute language (or `und`) and `source_locale` rests on the same attributes.
 */
import path from 'node:path';
import type { InputSpec, PageType, SourceDocument, SourceOrigin, StagesConfig } from '../schemas/index.js';
import { EngineError } from '../util/errors.js';
import { classifyPage } from './classify.js';
import { parseHtml, type ParsedHtml } from './html_parser.js';
import { determineSourceLocale, languageOfTag } from './locale.js';
import { buildDocument, type BuildDocumentArgs } from './segmenter.js';
import { loadFile, loadText } from './text_loader.js';
import { fetchPage, type HostLookup } from './url_fetcher.js';

export interface IngestDeps {
  ingest: StagesConfig['ingest'];
  classification: StagesConfig['page_classification'];
  /** `entities.symbol_units` of `config/locales/_common.yaml`. */
  symbolUnits: readonly string[];
  /** HTTP client for URL inputs (tests). */
  fetch?: typeof fetch;
  lookup?: HostLookup;
  contact?: string;
  allowPrivateNetworks?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Caller override of the source locale. */
  sourceLocale?: string;
  /** Caller-provided primary keyword (source language). */
  primaryKeyword?: string;
  /** Caller override of the CONTENT / LEGAL classification. */
  pageType?: PageType;
}

interface Loaded {
  origin: SourceOrigin;
  parsed: ParsedHtml;
  /** What the classifier tests: the URL, the file name or the caller's label. */
  location: string | undefined;
  /** Address used for the ccTLD region hint. */
  url: string | undefined;
  slugSource: NonNullable<BuildDocumentArgs['slugSource']>;
  warnings: string[];
}

async function load(spec: InputSpec, deps: IngestDeps): Promise<Loaded> {
  switch (spec.kind) {
    case 'url': {
      const page = await fetchPage(spec.url, {
        ingest: deps.ingest,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.lookup ? { lookup: deps.lookup } : {}),
        ...(deps.contact !== undefined ? { contact: deps.contact } : {}),
        ...(deps.allowPrivateNetworks !== undefined ? { allowPrivateNetworks: deps.allowPrivateNetworks } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
      const parsed = page.format === 'html' ? parseHtml(page.body, { baseUrl: page.final_url }) : loadText(page.body, page.format, page.final_url);
      const origin: SourceOrigin = {
        kind: 'url',
        ref: spec.url,
        final_url: page.final_url,
        fetched_at: page.fetched_at,
        http_status: page.status,
        robots: page.robots,
      };
      if (page.content_type !== undefined) origin.content_type = page.content_type;
      return { origin, parsed, location: page.final_url, url: page.final_url, slugSource: { url: page.final_url }, warnings: page.warnings };
    }
    case 'file':
      return {
        origin: { kind: 'file', ref: spec.path },
        parsed: await loadFile(spec.path),
        location: path.basename(spec.path),
        url: undefined,
        slugSource: {},
        warnings: [],
      };
    case 'text': {
      const name = spec.name;
      return {
        origin: { kind: 'text', ref: name ?? 'inline text' },
        parsed: loadText(spec.text, spec.format, name),
        location: name,
        url: name !== undefined && /^https?:\/\//i.test(name) ? name : undefined,
        slugSource: name !== undefined ? { name } : {},
        warnings: [],
      };
    }
    case 'page_json':
      throw new EngineError('INPUT_INVALID', 'page_json inputs are loaded by the pipeline, not by ingest');
  }
}

export async function ingestInput(spec: InputSpec, deps: IngestDeps): Promise<SourceDocument> {
  const { origin, parsed, location, url, slugSource, warnings } = await load(spec, deps);

  const classification = classifyPage(
    {
      ...(location !== undefined ? { urlOrPath: location } : {}),
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.h1 !== undefined ? { h1: parsed.h1 } : {}),
      ...(deps.pageType !== undefined ? { override: deps.pageType } : {}),
    },
    deps.classification,
  );

  const attributeLanguage = languageOfTag(deps.sourceLocale) ?? languageOfTag(parsed.html_lang) ?? languageOfTag(parsed.og_locale) ?? 'und';
  const locale = determineSourceLocale({
    ...(deps.sourceLocale !== undefined ? { declared: deps.sourceLocale } : {}),
    ...(parsed.html_lang !== undefined ? { html_lang: parsed.html_lang } : {}),
    ...(parsed.og_locale !== undefined ? { og_locale: parsed.og_locale } : {}),
    ...(url !== undefined ? { url } : {}),
    language: attributeLanguage,
  });

  const doc = buildDocument({
    origin,
    parsed,
    symbolUnits: deps.symbolUnits,
    page_type: classification.page_type,
    page_type_evidence: classification.evidence,
    source_locale: locale.source_locale,
    source_locale_evidence: locale.evidence,
    source_language: attributeLanguage,
    slugSource,
    ...(deps.primaryKeyword !== undefined ? { primaryKeyword: deps.primaryKeyword } : {}),
    warnings,
  });

  if (!doc.segments.some((s) => s.block_type !== 'meta' && s.translatable)) {
    throw new EngineError('INPUT_INVALID', 'no translatable content found', { origin: origin.ref, segments: doc.segments.length });
  }
  return doc;
}

export { classifyPage, type Classification, type ClassifyInput } from './classify.js';
export { parseHtml, isUnsafeUrl, type ParsedHtml, type RawBlock, type ParseHtmlOptions } from './html_parser.js';
export { determineSourceLocale, languageOfTag, parseLocaleTag, type SourceLocaleInput, type SourceLocaleResult } from './locale.js';
export { buildDocument, type BuildDocumentArgs } from './segmenter.js';
export { loadFile, loadText, type TextFormat } from './text_loader.js';
export {
  assertFetchableUrl,
  assertPublicUrl,
  blockedReason,
  fetchPage,
  userAgentFor,
  type FetchOptions,
  type FetchedPage,
  type HostLookup,
} from './url_fetcher.js';
