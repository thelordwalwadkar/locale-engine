/** TRANSLATION stage (spec §7 Phase 5): neutral, faithful translation; locale adaptation is the next stage. */
import { glossaryHitsForPrompt } from '../config/glossary.js';
import { languageOf } from '../schemas/common.js';
import type { LocaleCode } from '../schemas/common.js';
import { TranslateBatchWireSchema } from '../schemas/llm.js';
import type { TranslateBatchWire, TranslationWireItem } from '../schemas/llm.js';
import { EngineError, errorMessage } from '../util/errors.js';
import { mapLimitSettled } from '../util/concurrency.js';
import { plainText } from '../util/inline.js';
import { makeBatches } from './batching.js';
import type { TranslatePayload } from './payloads.js';
import {
  languageName,
  loadGolden,
  loadTemplate,
  renderEdgeExemplars,
  renderGlossaryHits,
  renderGolden,
  renderLocaleProfile,
  renderOutputContract,
  renderTemplate,
} from './prompt.js';
import type { OutputMode } from './prompt.js';
import type { LocaleContext, SegState } from './state.js';

/** The language-level base locale used for glossary targets in the neutral translation stage (locale-specific forms come with localization). */
export function neutralLocale(target: LocaleCode): LocaleCode {
  switch (languageOf(target)) {
    case 'de':
      return 'de-DE';
    case 'en':
      return 'en-GB';
    case 'it':
      return 'it-IT';
    default:
      return 'nl-NL';
  }
}

export function needsTranslation(s: SegState): boolean {
  return s.status === 'OK' && s.seg.translatable && (s.operation === 'TRANSLATE_LOCALIZE' || s.operation === 'TRANSLATE_ONLY');
}

export function buildTranslationSystem(lc: LocaleContext, batch: SegState[], sourceLang: string, mode: OutputMode): string {
  const dir = lc.run.kit.promptsDir;
  const neutral = neutralLocale(lc.target);
  const entries = glossaryHitsForPrompt(
    batch.flatMap((s) => s.glossaryHits),
    neutral,
  );
  return renderTemplate(loadTemplate(dir, 'translate'), {
    source_locale: lc.doc.source_locale,
    source_language_name: languageName(sourceLang),
    target_locale: lc.target,
    target_language_name: languageName(languageOf(lc.target)),
    operation: batch[0]?.operation ?? 'TRANSLATE_LOCALIZE',
    locale_profile: renderLocaleProfile(lc.profile, 'translate'),
    glossary_hits: renderGlossaryHits(entries, neutral, 'translate'),
    golden_exemplar: renderGolden(loadGolden(dir, 'translation'), mode),
    edge_exemplars: renderEdgeExemplars(lc.run.kit.edge, 'translation', lc.profile),
    output_contract: renderOutputContract(dir, mode, TranslateBatchWireSchema),
  });
}

function buildPayload(lc: LocaleContext, batch: SegState[]): TranslatePayload {
  const first = lc.doc.segments.find((s) => s.meta_kind === 'title');
  const h1 = lc.doc.segments.find((s) => s.block_type === 'heading' && s.level === 1);
  return {
    stage: 'translation',
    source_locale: lc.doc.source_locale,
    target_locale: lc.target,
    operation: batch[0]?.operation ?? 'TRANSLATE_LOCALIZE',
    document: { title: first ? plainText(first.text) : null, h1: h1 ? plainText(h1.text) : null, page_type: lc.pageType },
    segments: batch.map((s) => ({
      segment_id: s.seg.segment_id,
      block_type: s.seg.block_type,
      meta_kind: s.seg.meta_kind ?? null,
      source_language: s.lang,
      text: s.seg.text,
      glossary_term_ids: [...new Set(s.glossaryHits.map((h) => h.term_id))],
    })),
  };
}

function apply(s: SegState, r: TranslationWireItem): void {
  s.translation = r.translation;
  s.text = r.translation;
  s.dirty = true;
  s.entitiesPreserved = r.entities_preserved;
  const ids = new Set(s.glossaryHits.map((h) => h.term_id));
  s.terminology = r.terminology_applied.filter((t) => ids.has(t.rule));
}

function fail(lc: LocaleContext, s: SegState, why: string): void {
  s.status = 'PROVIDER_ERROR';
  s.notes.push(`[EVIDENCE: ${s.seg.segment_id}] translation failed: ${why}`);
  lc.run.log.error({ code: 'PROVIDER_ERROR', message: `translation failed for ${s.seg.segment_id}: ${why}`, stage: 'translation', locale: lc.target, segment_id: s.seg.segment_id });
}

async function translateBatch(lc: LocaleContext, batch: SegState[], sourceLang: string, single: boolean): Promise<void> {
  if (lc.halted) return;
  let out: TranslateBatchWire;
  try {
    out = await lc.run.runner.call({
      stage: 'translation',
      locale: lc.target,
      segments: batch.length,
      segmentIds: batch.map((s) => s.seg.segment_id),
      system: (mode) => buildTranslationSystem(lc, batch, sourceLang, mode),
      payload: buildPayload(lc, batch),
      schema: TranslateBatchWireSchema,
    });
  } catch (e) {
    if (e instanceof EngineError && e.code === 'COST_CEILING') {
      lc.halted = true;
      return;
    }
    if (!single && batch.length > 1) return splitAndRetry(lc, batch, sourceLang);
    for (const s of batch) fail(lc, s, errorMessage(e));
    return;
  }
  const byId = new Map(out.results.map((r) => [r.segment_id, r]));
  const missing: SegState[] = [];
  for (const s of batch) {
    const r = byId.get(s.seg.segment_id);
    if (r && r.translation.trim() !== '') apply(s, r);
    else missing.push(s);
  }
  if (!missing.length) return;
  if (!single) return splitAndRetry(lc, missing, sourceLang);
  for (const s of missing) fail(lc, s, 'the model returned no usable translation for this segment');
}

/** A failed or incomplete batch is retried once, segment by segment (smaller answers break less often). */
async function splitAndRetry(lc: LocaleContext, batch: SegState[], sourceLang: string): Promise<void> {
  lc.run.log.warn({ code: 'BATCH_SPLIT', message: `retrying ${batch.length} segment(s) one by one`, stage: 'translation', locale: lc.target });
  await mapLimitSettled(batch, lc.run.config.stages.concurrency.calls_per_locale, (s) => translateBatch(lc, [s], sourceLang, true));
}

export async function runTranslation(lc: LocaleContext, states: SegState[]): Promise<void> {
  const todo = states.filter((s) => needsTranslation(s) && s.translation === null);
  if (!todo.length) return;
  const { batching, concurrency } = lc.run.config.stages;
  const groups = new Map<string, SegState[]>();
  for (const s of todo) {
    const key = `${s.lang}|${s.operation}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const jobs: Array<{ batch: SegState[]; lang: string }> = [];
  for (const group of groups.values()) {
    for (const batch of makeBatches(group, { maxSegments: batching.max_segments, maxChars: batching.max_input_chars }, (s) => s.seg.text.length + 80)) {
      jobs.push({ batch, lang: group[0]?.lang ?? lc.doc.source_language });
    }
  }
  lc.run.log.info({ code: 'STAGE_START', message: `translation: ${todo.length} segment(s) in ${jobs.length} call(s)`, stage: 'translation', locale: lc.target });
  await mapLimitSettled(jobs, concurrency.calls_per_locale, (j) => translateBatch(lc, j.batch, j.lang, false));
}
