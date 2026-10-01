/**
 * LOCALIZATION stage (spec §7 Phase 5): adapt a neutral translation (or, for ADAPT_ONLY, the source itself) to the conventions of the
 * target market. The model only makes edits that a rule, the glossary, a market-claim decision or the brand voice requires, and logs
 * every one of them with a rule id (R4).
 */
import { glossaryHitsForPrompt } from '../config/glossary.js';
import { languageOf } from '../schemas/common.js';
import type { Change } from '../schemas/findings.js';
import { LocalizeBatchWireSchema } from '../schemas/llm.js';
import type { LocalizationWireItem, LocalizeBatchWire } from '../schemas/llm.js';
import { mapLimitSettled } from '../util/concurrency.js';
import { EngineError, errorMessage } from '../util/errors.js';
import { plainText } from '../util/inline.js';
import { makeBatches } from './batching.js';
import { ensureTagged } from './evidence.js';
import type { LocalizePayload } from './payloads.js';
import {
  languageName,
  loadGolden,
  loadTemplate,
  renderEdgeExemplars,
  renderGlossaryHits,
  renderGolden,
  renderLocaleProfile,
  renderMarketFacts,
  renderOutputContract,
  renderTemplate,
} from './prompt.js';
import type { OutputMode } from './prompt.js';
import type { LocaleContext, SegState } from './state.js';

export function needsLocalization(lc: LocaleContext, s: SegState): boolean {
  return (
    lc.pageType === 'CONTENT' &&
    s.status === 'OK' &&
    s.seg.translatable &&
    (s.operation === 'TRANSLATE_LOCALIZE' || s.operation === 'ADAPT_ONLY') &&
    s.localized === null
  );
}

/** What the localization stage works on: the translation, or the source text when source and target share a language. */
export function inputTextOf(s: SegState): string {
  return s.translation ?? s.seg.text;
}

export function buildLocalizationSystem(lc: LocaleContext, batch: SegState[], mode: OutputMode): string {
  const dir = lc.run.kit.promptsDir;
  const entries = glossaryHitsForPrompt(
    batch.flatMap((s) => s.glossaryHits),
    lc.target,
  );
  return renderTemplate(loadTemplate(dir, 'localize'), {
    source_locale: lc.doc.source_locale,
    source_language_name: languageName(lc.doc.source_language),
    target_locale: lc.target,
    target_language_name: languageName(languageOf(lc.target)),
    operation: batch[0]?.operation ?? 'TRANSLATE_LOCALIZE',
    locale_profile: renderLocaleProfile(lc.profile, 'localize'),
    brand_voice_section: lc.run.kit.brandVoice,
    market_facts_section: renderMarketFacts(lc.facts, lc.target),
    glossary_hits: renderGlossaryHits(entries, lc.target, 'other'),
    golden_exemplar: renderGolden(loadGolden(dir, 'localization'), mode),
    edge_exemplars: renderEdgeExemplars(lc.run.kit.edge, 'localization', lc.profile),
    output_contract: renderOutputContract(dir, mode, LocalizeBatchWireSchema),
  });
}

function buildPayload(lc: LocaleContext, batch: SegState[]): LocalizePayload {
  const title = lc.doc.segments.find((s) => s.meta_kind === 'title');
  const h1 = lc.doc.segments.find((s) => s.block_type === 'heading' && s.level === 1);
  return {
    stage: 'localization',
    source_locale: lc.doc.source_locale,
    target_locale: lc.target,
    operation: batch[0]?.operation ?? 'TRANSLATE_LOCALIZE',
    document: { title: title ? plainText(title.text) : null, h1: h1 ? plainText(h1.text) : null, page_type: lc.pageType },
    segments: batch.map((s) => ({
      segment_id: s.seg.segment_id,
      block_type: s.seg.block_type,
      meta_kind: s.seg.meta_kind ?? null,
      source_text: s.seg.text,
      input_text: inputTextOf(s),
      glossary_term_ids: [...new Set(s.glossaryHits.map((h) => h.term_id))],
      market_claims: s.claimActions,
    })),
  };
}

function toChange(lc: LocaleContext, s: SegState, c: LocalizationWireItem['changes'][number]): Change {
  const tagged = ensureTagged(c.reason);
  if (tagged.amended) {
    lc.run.log.warn({ code: 'EVIDENCE_TAG_ADDED', message: `change reason without evidence tag marked [HYPOTHESIS]`, stage: 'localization', locale: lc.target, segment_id: s.seg.segment_id });
  }
  return { from: c.from, to: c.to, rule: c.rule.trim() || 'UNSPECIFIED', reason: tagged.text, origin: 'llm' };
}

function apply(lc: LocaleContext, s: SegState, r: LocalizationWireItem): void {
  s.localized = r.localized_text;
  s.text = r.localized_text;
  s.dirty = true;
  s.changes.push(...r.changes.map((c) => toChange(lc, s, c)));
  if (r.requires_human_review) {
    s.llmReview = true;
    s.reviewReasons.push('LOCALIZATION_FLAG: the localization stage asked for human review');
  }
}

function fail(lc: LocaleContext, s: SegState, why: string): void {
  s.status = 'PROVIDER_ERROR';
  s.notes.push(`[EVIDENCE: ${s.seg.segment_id}] localization failed: ${why}`);
  lc.run.log.error({ code: 'PROVIDER_ERROR', message: `localization failed for ${s.seg.segment_id}: ${why}`, stage: 'localization', locale: lc.target, segment_id: s.seg.segment_id });
}

async function localizeBatch(lc: LocaleContext, batch: SegState[], single: boolean): Promise<void> {
  if (lc.halted) return;
  let out: LocalizeBatchWire;
  try {
    out = await lc.run.runner.call({
      stage: 'localization',
      locale: lc.target,
      segments: batch.length,
      segmentIds: batch.map((s) => s.seg.segment_id),
      system: (mode) => buildLocalizationSystem(lc, batch, mode),
      payload: buildPayload(lc, batch),
      schema: LocalizeBatchWireSchema,
    });
  } catch (e) {
    if (e instanceof EngineError && e.code === 'COST_CEILING') {
      lc.halted = true;
      return;
    }
    if (!single && batch.length > 1) return splitAndRetry(lc, batch);
    for (const s of batch) fail(lc, s, errorMessage(e));
    return;
  }
  const byId = new Map(out.results.map((r) => [r.segment_id, r]));
  const missing: SegState[] = [];
  for (const s of batch) {
    const r = byId.get(s.seg.segment_id);
    if (r && r.localized_text.trim() !== '') apply(lc, s, r);
    else missing.push(s);
  }
  if (!missing.length) return;
  if (!single) return splitAndRetry(lc, missing);
  for (const s of missing) fail(lc, s, 'the model returned no usable localized text for this segment');
}

async function splitAndRetry(lc: LocaleContext, batch: SegState[]): Promise<void> {
  lc.run.log.warn({ code: 'BATCH_SPLIT', message: `retrying ${batch.length} segment(s) one by one`, stage: 'localization', locale: lc.target });
  await mapLimitSettled(batch, lc.run.config.stages.concurrency.calls_per_locale, (s) => localizeBatch(lc, [s], true));
}

export async function runLocalization(lc: LocaleContext, states: SegState[]): Promise<void> {
  const todo = states.filter((s) => needsLocalization(lc, s));
  if (!todo.length) return;
  const { batching, concurrency } = lc.run.config.stages;
  const groups = new Map<string, SegState[]>();
  for (const s of todo) groups.set(s.operation, [...(groups.get(s.operation) ?? []), s]);
  const jobs: SegState[][] = [];
  for (const group of groups.values()) {
    jobs.push(...makeBatches(group, { maxSegments: batching.max_segments, maxChars: batching.max_input_chars }, (s) => inputTextOf(s).length + s.seg.text.length + 120));
  }
  lc.run.log.info({ code: 'STAGE_START', message: `localization: ${todo.length} segment(s) in ${jobs.length} call(s)`, stage: 'localization', locale: lc.target });
  await mapLimitSettled(jobs, concurrency.calls_per_locale, (b) => localizeBatch(lc, b, false));
}
