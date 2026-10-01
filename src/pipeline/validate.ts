/**
 * VALIDATION stage (spec §7 Phase 5, ARCHITECTURE P4/P9): deterministic lint first, then a literal back-translation, then the independent
 * LLM judge. Findings from all three sources are merged without double counting; scores and verdicts are computed from them (scoring.ts).
 */
import { glossaryHitsForPrompt } from '../config/glossary.js';
import { lintDocument, lintSegment } from '../lint/index.js';
import type { LintResult, LintSegmentInput } from '../lint/types.js';
import { EVIDENCE_TAG_RE, languageOf } from '../schemas/common.js';
import type { Finding, FindingDraft } from '../schemas/findings.js';
import { BackTranslateBatchWireSchema, JudgeBatchWireSchema } from '../schemas/llm.js';
import type { JudgeWireItem } from '../schemas/llm.js';
import { mapLimitSettled } from '../util/concurrency.js';
import { EngineError, errorMessage } from '../util/errors.js';
import { mapPlainSpan, plainText, plainTextWithMap } from '../util/inline.js';
import { makeBatches } from './batching.js';
import { ensureTagged } from './evidence.js';
import type { BackTranslatePayload, JudgePayload } from './payloads.js';
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
import type { LocaleContext, SegState, SegValidationState } from './state.js';

// ---------------------------------------------------------------------------------------------------------------
// Lint glue
// ---------------------------------------------------------------------------------------------------------------

export function lintInputOf(s: SegState): LintSegmentInput {
  return {
    segment_id: s.seg.segment_id,
    block_type: s.seg.block_type,
    ...(s.seg.meta_kind ? { meta_kind: s.seg.meta_kind } : {}),
    operation: s.operation,
    source_text: s.seg.text,
    source_lang: s.lang,
    source_locale: s.segmentLocale,
    target_text: s.text ?? '',
    translatable: s.seg.translatable,
    back_translation: s.backTranslation,
    changes: s.changes,
  };
}

export function toFinding(lc: LocaleContext, d: FindingDraft): Finding {
  return { finding_id: '', locale: lc.target, status: 'open', ...d };
}

/** Whether the segment takes part in validation at all. */
export function isValidatable(s: SegState): boolean {
  return s.status === 'OK' && s.text !== null;
}

/** Translation drift only exists when a translation step ran; entity-only and skipped segments are checked by the linter alone. */
function needsJudge(s: SegState): boolean {
  return s.seg.translatable && s.operation !== 'SKIP_IDENTICAL';
}

function needsBackTranslation(lc: LocaleContext, s: SegState): boolean {
  return lc.run.settings.stages.backtranslate && s.seg.translatable && (s.operation === 'TRANSLATE_LOCALIZE' || s.operation === 'TRANSLATE_ONLY');
}

// ---------------------------------------------------------------------------------------------------------------
// Back-translation
// ---------------------------------------------------------------------------------------------------------------

/** English for every non-English target; for English targets the segment's own (non-English) source language. */
function backTranslationLanguage(lc: LocaleContext, s: SegState): string | null {
  const targetLang = languageOf(lc.target);
  if (targetLang !== 'en') return 'en';
  return s.lang !== 'en' && s.lang !== 'und' ? s.lang : null;
}

export function btSystem(lc: LocaleContext, lang: string, mode: OutputMode): string {
  const dir = lc.run.kit.promptsDir;
  return renderTemplate(loadTemplate(dir, 'backtranslate'), {
    target_locale: lc.target,
    target_language_name: languageName(languageOf(lc.target)),
    back_translation_language_name: languageName(lang),
    golden_exemplar: renderGolden(loadGolden(dir, 'backtranslation'), mode),
    output_contract: renderOutputContract(dir, mode, BackTranslateBatchWireSchema),
  });
}

async function runBackTranslation(lc: LocaleContext, states: SegState[]): Promise<void> {
  if (lc.halted) return;
  const todo = states.filter((s) => needsBackTranslation(lc, s) && (s.dirty || s.backTranslation === null));
  if (!todo.length) return;
  const groups = new Map<string, SegState[]>();
  for (const s of todo) {
    const lang = backTranslationLanguage(lc, s);
    if (!lang) continue;
    groups.set(lang, [...(groups.get(lang) ?? []), s]);
  }
  const { batching, concurrency } = lc.run.config.stages;
  const jobs: Array<{ lang: string; batch: SegState[] }> = [];
  for (const [lang, group] of groups) {
    for (const batch of makeBatches(group, { maxSegments: batching.max_segments, maxChars: batching.max_input_chars }, (s) => (s.text ?? '').length + 60)) {
      jobs.push({ lang, batch });
    }
  }
  await mapLimitSettled(jobs, concurrency.calls_per_locale, async ({ lang, batch }) => {
    if (lc.halted) return;
    const payload: BackTranslatePayload = {
      stage: 'backtranslation',
      target_locale: lc.target,
      back_translation_language: lang,
      segments: batch.map((s) => ({ segment_id: s.seg.segment_id, text: s.text ?? '' })),
    };
    try {
      const out = await lc.run.runner.call({
        stage: 'backtranslation',
        locale: lc.target,
        segments: batch.length,
        segmentIds: batch.map((s) => s.seg.segment_id),
        system: (mode) => btSystem(lc, lang, mode),
        payload,
        schema: BackTranslateBatchWireSchema,
      });
      const byId = new Map(out.results.map((r) => [r.segment_id, r.back_translation]));
      for (const s of batch) {
        const bt = byId.get(s.seg.segment_id);
        if (bt !== undefined && bt.trim() !== '') s.backTranslation = { text: bt, lang };
      }
    } catch (e) {
      if (e instanceof EngineError && e.code === 'COST_CEILING') lc.halted = true;
      else lc.run.log.warn({ code: 'BACKTRANSLATION_SKIPPED', message: `back-translation failed, drift check skipped: ${errorMessage(e)}`, stage: 'backtranslation', locale: lc.target });
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------------------------------------------

export function judgeSystem(lc: LocaleContext, batch: SegState[], mode: OutputMode): string {
  const dir = lc.run.kit.promptsDir;
  const entries = glossaryHitsForPrompt(
    batch.flatMap((s) => s.glossaryHits),
    lc.target,
  );
  return renderTemplate(loadTemplate(dir, 'validate'), {
    source_locale: lc.doc.source_locale,
    source_language_name: languageName(lc.doc.source_language),
    target_locale: lc.target,
    target_language_name: languageName(languageOf(lc.target)),
    operation: batch[0]?.operation ?? 'TRANSLATE_LOCALIZE',
    locale_profile: renderLocaleProfile(lc.profile, 'validate'),
    brand_voice_section: lc.run.kit.brandVoice,
    glossary_hits: renderGlossaryHits(entries, lc.target, 'other'),
    golden_exemplar: renderGolden(loadGolden(dir, 'validation'), mode),
    edge_exemplars: renderEdgeExemplars(lc.run.kit.edge, 'validation', lc.profile),
    output_contract: renderOutputContract(dir, mode, JudgeBatchWireSchema),
  });
}

function judgePayload(lc: LocaleContext, batch: SegState[], lint: Map<string, LintResult>): JudgePayload {
  const title = lc.doc.segments.find((s) => s.meta_kind === 'title');
  const h1 = lc.doc.segments.find((s) => s.block_type === 'heading' && s.level === 1);
  return {
    stage: 'validation',
    source_locale: lc.doc.source_locale,
    target_locale: lc.target,
    operation: batch[0]?.operation ?? 'TRANSLATE_LOCALIZE',
    document: { title: title ? plainText(title.text) : null, h1: h1 ? plainText(h1.text) : null, page_type: lc.pageType },
    segments: batch.map((s) => ({
      segment_id: s.seg.segment_id,
      block_type: s.seg.block_type,
      meta_kind: s.seg.meta_kind ?? null,
      source_text: s.seg.text,
      target_text: s.text ?? '',
      changes: s.changes.map((c) => ({ from: c.from, to: c.to, rule: c.rule })),
      deterministic_findings: (lint.get(s.seg.segment_id)?.findings ?? []).map((f) => ({
        rule: f.rule_or_category,
        severity: f.severity,
        target_span: f.target_span,
        note: f.explanation,
      })),
      back_translation: s.backTranslation?.text ?? null,
      glossary_term_ids: [...new Set(s.glossaryHits.map((h) => h.term_id))],
      market_claims: s.claimActions,
    })),
  };
}

async function runJudge(lc: LocaleContext, states: SegState[], lint: Map<string, LintResult>): Promise<Map<string, JudgeWireItem>> {
  const results = new Map<string, JudgeWireItem>();
  if (lc.halted) return results;
  const todo = states.filter(needsJudge);
  if (!todo.length) return results;
  const { batching, concurrency } = lc.run.config.stages;
  const groups = new Map<string, SegState[]>();
  for (const s of todo) groups.set(s.operation, [...(groups.get(s.operation) ?? []), s]);
  const jobs: SegState[][] = [];
  for (const group of groups.values()) {
    jobs.push(...makeBatches(group, { maxSegments: batching.max_segments, maxChars: batching.max_input_chars }, (s) => s.seg.text.length + (s.text ?? '').length + (s.backTranslation?.text.length ?? 0) + 200));
  }
  await mapLimitSettled(jobs, concurrency.calls_per_locale, async (batch) => {
    if (lc.halted) return;
    try {
      const out = await lc.run.runner.call({
        stage: 'validation',
        locale: lc.target,
        segments: batch.length,
        segmentIds: batch.map((s) => s.seg.segment_id),
        system: (mode) => judgeSystem(lc, batch, mode),
        payload: judgePayload(lc, batch, lint),
        schema: JudgeBatchWireSchema,
      });
      for (const r of out.results) results.set(r.segment_id, r);
    } catch (e) {
      if (e instanceof EngineError && e.code === 'COST_CEILING') lc.halted = true;
      else lc.run.log.warn({ code: 'JUDGE_UNAVAILABLE', message: `LLM judge failed for ${batch.length} segment(s): ${errorMessage(e)}`, stage: 'validation', locale: lc.target });
    }
  });
  return results;
}

// ---------------------------------------------------------------------------------------------------------------
// Findings assembly
// ---------------------------------------------------------------------------------------------------------------

const RULE_ID_RE = /[A-Z0-9]+(?:-[A-Z0-9]+)+/g;

function judgeFindings(lc: LocaleContext, s: SegState, judge: JudgeWireItem, lintRules: Set<string>): Finding[] {
  const map = plainTextWithMap(s.text ?? '');
  const out: Finding[] = [];
  for (const e of judge.mqm_errors) {
    const tagged = ensureTagged(e.explanation);
    if (tagged.amended) {
      lc.run.log.warn({ code: 'EVIDENCE_TAG_ADDED', message: 'judge explanation without evidence tag marked [HYPOTHESIS]', stage: 'validation', locale: lc.target, segment_id: s.seg.segment_id });
    }
    const cited = [...tagged.text.matchAll(RULE_ID_RE)].map((m) => m[0]);
    if (cited.some((id) => lintRules.has(id))) continue; // the deterministic layer already reports it
    const isClaim = cited.includes('INTEGRITY-MARKET-CLAIM');
    let span: { start: number; end: number } | null = null;
    if (e.target_span) {
      const i = map.plain.indexOf(e.target_span);
      if (i >= 0) span = mapPlainSpan(map, i, i + e.target_span.length);
    }
    out.push({
      finding_id: '',
      locale: lc.target,
      segment_id: s.seg.segment_id,
      origin: 'llm_judge',
      rule_or_category: e.category,
      severity: e.severity,
      evidence: EVIDENCE_TAG_RE.exec(tagged.text)?.[0] ?? '[HYPOTHESIS]',
      explanation: tagged.text,
      source_span: e.source_span || null,
      target_span: e.target_span || null,
      span,
      suggested_fix: e.suggested_fix || null,
      autofix: null,
      requires_human_review: isClaim,
      repair_trigger: e.severity !== 'minor' && !isClaim,
      status: 'open',
    });
  }
  return out;
}

/** A deliberately neutralised / replaced claim is always a finding (golden: accuracy/omission, major) unless the judge or the linter already reports it. */
function claimFinding(lc: LocaleContext, s: SegState): Finding | null {
  const acts = s.claimActions.filter((a) => a.action !== 'KEEP');
  if (!acts.length) return null;
  const phrases = acts.map((a) => `"${a.source_phrase}"`).join(', ');
  const tag = '[EVIDENCE: INTEGRITY-MARKET-CLAIM]';
  return {
    finding_id: '',
    locale: lc.target,
    segment_id: s.seg.segment_id,
    origin: 'pipeline',
    rule_or_category: 'accuracy/omission',
    severity: 'major',
    evidence: tag,
    explanation: `${tag} The geographic claim ${phrases} was ${acts.some((a) => a.action === 'REPLACE_WITH_FACT') ? 'replaced by the supplied market fact' : 'neutralised'} on purpose; the business must confirm the ${lc.target} delivery scope.`,
    source_span: acts[0]?.source_phrase ?? null,
    target_span: null,
    span: null,
    suggested_fix: `Add ${lc.target}.delivery (and the confirmed lead time) to market_facts.yaml.`,
    autofix: null,
    requires_human_review: true,
    repair_trigger: false,
    status: 'open',
  };
}

function assemble(lc: LocaleContext, s: SegState, lint: LintResult, judge: JudgeWireItem | null, previous: SegValidationState | null): SegValidationState {
  const drafts = lint.findings.map((d) => toFinding(lc, d));
  const lintRules = new Set(drafts.map((f) => f.rule_or_category));
  const judged = judge ? judgeFindings(lc, s, judge, lintRules) : [];
  const claimReported =
    drafts.some((f) => f.rule_or_category === 'INTEGRITY-MARKET-CLAIM') ||
    (judge?.mqm_errors ?? []).some((e) => e.explanation.includes('INTEGRITY-MARKET-CLAIM'));
  const claim = claimReported ? null : claimFinding(lc, s);
  const findings = [...drafts, ...judged, ...(claim ? [claim] : [])];
  const recs = (judge?.localization_recommendations ?? []).map((r) => ensureTagged(r).text);
  return {
    lint,
    judge,
    findings,
    docFindings: [],
    history: previous?.history ?? [],
    confidence: judge ? Math.min(1, Math.max(0, judge.confidence)) : null,
    recommendations: recs,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------------------------

/** Validate the given segments (full pass: back-translation → lint → judge) and store the outcome in `s.validation`. */
export async function validateStates(lc: LocaleContext, states: SegState[]): Promise<void> {
  const eligible = states.filter(isValidatable);
  if (!eligible.length) return;
  lc.run.log.info({ code: 'STAGE_START', message: `validation: ${eligible.length} segment(s)`, stage: 'validation', locale: lc.target });

  await runBackTranslation(lc, eligible);

  const lint = new Map<string, LintResult>();
  for (const s of eligible) lint.set(s.seg.segment_id, lintSegment(lintInputOf(s), lc.lint));

  const judged = await runJudge(lc, eligible, lint);

  for (const s of eligible) {
    const judge = judged.get(s.seg.segment_id) ?? null;
    if (!judge && needsJudge(s)) {
      s.reviewReasons.push(
        lc.halted
          ? 'NOT_VALIDATED: the run was halted (cost ceiling) before the LLM judge reviewed this segment'
          : 'JUDGE_UNAVAILABLE: the LLM judge did not return a result for this segment',
      );
    }
    s.validation = assemble(lc, s, lint.get(s.seg.segment_id) as LintResult, judge, s.validation);
    s.dirty = false;
  }
  lc.docFindings = refreshDocumentFindings(lc, states);
}

/** Recompute document-level rule findings (first mention, currency policy …) over all segments; returns the ones without a segment. */
export function refreshDocumentFindings(lc: LocaleContext, states: SegState[]): Finding[] {
  const eligible = states.filter(isValidatable);
  for (const s of eligible) if (s.validation) s.validation.docFindings = [];
  if (!eligible.length) return [];
  const result = lintDocument(eligible.map(lintInputOf), lc.lint);
  const byId = new Map(eligible.map((s) => [s.seg.segment_id, s]));
  const local: Finding[] = [];
  for (const d of result.findings) {
    const f = toFinding(lc, d);
    const owner = d.segment_id ? byId.get(d.segment_id) : undefined;
    if (owner?.validation) owner.validation.docFindings.push(f);
    else local.push(f);
  }
  return local;
}

/** Deterministic part only (used for SKIP_IDENTICAL / entity-only segments and by tests). */
export function lintOnly(lc: LocaleContext, s: SegState): LintResult {
  return lintSegment(lintInputOf(s), lc.lint);
}
