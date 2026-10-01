/** Turns working state into the persisted result shapes: findings with stable ids, scores, verdicts, segment and locale results. */
import { backTranslationSimilarity } from '../lint/index.js';
import type { Finding, LocaleResult, SegmentResult, SegmentValidation, Verdict } from '../schemas/index.js';
import { totalsOf } from '../telemetry/cost.js';
import { plainText } from '../util/inline.js';
import { round, wordCount } from '../util/text.js';
import { ensureTagged } from './evidence.js';
import { decideVerdict, penaltyFor, rawWeight, scoreFor, worstVerdict } from './scoring.js';
import type { LocaleContext, SegState } from './state.js';

export function openFindings(s: SegState): Finding[] {
  if (!s.validation) return [];
  return [...s.validation.findings, ...s.validation.docFindings].filter((f) => f.status === 'open');
}

export function segmentWords(s: SegState): number {
  return wordCount(s.text ?? s.seg.text);
}

export interface SegmentMetrics {
  rawWeight: number;
  penalty: number;
  score: number;
  words: number;
}

export function segmentMetrics(lc: LocaleContext, s: SegState): SegmentMetrics {
  const words = segmentWords(s);
  const raw = rawWeight(openFindings(s).map((f) => f.severity), lc.run.scoring);
  const penalty = penaltyFor(raw, words, lc.run.scoring);
  return { rawWeight: raw, penalty, score: scoreFor(penalty), words };
}

export function assignFindingIds(lc: LocaleContext, findings: Finding[]): void {
  for (const f of findings) {
    if (f.finding_id === '') f.finding_id = `F-${lc.target}-${String(++lc.findingSeq).padStart(4, '0')}`;
  }
}

/** Why a human must look at this segment regardless of its score. LOCALIZATION_FLAG is dropped when a more specific reason exists. */
function reviewReasonsOf(lc: LocaleContext, s: SegState): string[] {
  const fromLint = s.validation?.lint.review_reasons ?? [];
  const all = [...new Set([...fromLint, ...s.reviewReasons])];
  const specific = all.filter((r) => !r.startsWith('LOCALIZATION_FLAG'));
  const reasons = specific.length ? specific : all;
  if (lc.pageType === 'LEGAL' && !reasons.some((r) => r.startsWith('LEGAL_PAGE'))) reasons.unshift('LEGAL_PAGE: legal content is translated only and always needs human review');
  return reasons;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function similarityOf(s: SegState): number | null {
  const bt = s.backTranslation;
  if (!bt || bt.lang !== s.lang || wordCount(s.seg.text) < 6) return null;
  return round(backTranslationSimilarity(plainText(s.seg.text), plainText(bt.text)), 3);
}

export function buildSegmentResult(lc: LocaleContext, s: SegState): SegmentResult {
  const reasons = reviewReasonsOf(lc, s);
  const metrics = segmentMetrics(lc, s);
  const open = openFindings(s);

  let validation: SegmentValidation | null = null;
  const v = s.validation;
  const verdict = decideVerdict(
    {
      status: s.status,
      validated: v !== null,
      score: metrics.score,
      open,
      judgeConfidence: v?.confidence ?? null,
      reviewReasons: reasons.filter((r) => !r.startsWith('LEGAL_PAGE')),
      legal: lc.pageType === 'LEGAL',
      hasRecommendations: (v?.recommendations.length ?? 0) > 0,
    },
    lc.run.scoring,
  );

  if (v) {
    assignFindingIds(lc, [...v.history, ...v.findings, ...v.docFindings]);
    const judge = v.judge;
    validation = {
      segment_id: s.seg.segment_id,
      target_locale: lc.target,
      deterministic_checks: v.lint.checks,
      llm_judge: judge
        ? {
            scores: {
              accuracy: clamp(judge.scores.accuracy, 0, 100),
              fluency: clamp(judge.scores.fluency, 0, 100),
              terminology: clamp(judge.scores.terminology, 0, 100),
              locale_conventions: clamp(judge.scores.locale_conventions, 0, 100),
              style_brand: clamp(judge.scores.style_brand, 0, 100),
            },
            mqm_errors: judge.mqm_errors.map((e) => ({ ...e, explanation: ensureTagged(e.explanation).text })),
            confidence: clamp(judge.confidence, 0, 1),
          }
        : null,
      back_translation: s.backTranslation?.text ?? null,
      back_translation_similarity: similarityOf(s),
      quality_score: metrics.score,
      penalty: metrics.penalty,
      word_count: metrics.words,
      verdict: verdict.verdict,
      verdict_reasons: verdict.reasons,
      localization_recommendations: v.recommendations,
      findings: [...v.history, ...v.findings, ...v.docFindings],
    };
  }

  const failed = s.status !== 'OK';
  const base: SegmentResult = {
    segment_id: s.seg.segment_id,
    block_type: s.seg.block_type,
    order: s.seg.order,
    inline: s.seg.inline,
    source_text: s.seg.text,
    source_lang: s.lang,
    source_lang_confidence: s.langConfidence,
    operation: s.operation,
    status: s.status,
    translation: s.translation,
    localized_text: s.localized,
    final_text: failed ? null : s.text,
    changes: s.changes,
    format_changes: s.formatChanges,
    entities_preserved: s.entitiesPreserved,
    terminology_applied: s.terminology,
    requires_human_review: reasons.length > 0 || s.llmReview || open.some((f) => f.requires_human_review) || verdict.verdict === 'HUMAN_REVIEW',
    review_reasons: reasons,
    repairs: s.repairs,
    validation,
    notes: s.notes.map((n) => ensureTagged(n).text),
  };
  if (s.seg.meta_kind) base.meta_kind = s.seg.meta_kind;
  if (s.seg.level !== undefined) base.level = s.seg.level;
  if (s.seg.group) base.group = s.seg.group;
  if (s.seg.href) base.href = s.seg.href;
  if (s.seg.src) base.src = s.seg.src;
  return base;
}

export interface LocaleAggregate {
  verdict: Verdict;
  reasons: string[];
  penalty: number;
  score: number;
  words: number;
}

export function aggregateLocale(lc: LocaleContext, states: SegState[], results: SegmentResult[]): LocaleAggregate {
  const words = states.reduce((n, s) => n + segmentWords(s), 0);
  const raw =
    states.reduce((n, s) => n + segmentMetrics(lc, s).rawWeight, 0) + rawWeight(lc.docFindings.filter((f) => f.status === 'open').map((f) => f.severity), lc.run.scoring);
  const penalty = penaltyFor(raw, words, lc.run.scoring);
  const score = scoreFor(penalty);

  const verdicts = results.map((r) => r.validation?.verdict ?? (r.status === 'OK' ? 'HUMAN_REVIEW' : 'FAIL'));
  let verdict = worstVerdict(verdicts);
  const reasonCounts = new Map<string, number>();
  for (const r of results) {
    const rs = r.validation?.verdict_reasons ?? (r.status === 'OK' ? ['NOT_VALIDATED: validation did not run'] : ['segment could not be produced']);
    const v = r.validation?.verdict ?? (r.status === 'OK' ? 'HUMAN_REVIEW' : 'FAIL');
    if (v === 'PASS') continue;
    for (const reason of rs) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const reasons = [...reasonCounts.entries()].map(([r, n]) => (n > 1 ? `${r} (${n} segments)` : r));
  if (score < lc.run.scoring.passThreshold && verdict !== 'FAIL') {
    verdict = 'FAIL';
    reasons.unshift(`locale quality score ${score} is below the pass threshold ${lc.run.scoring.passThreshold}`);
  }
  const openDoc = lc.docFindings.filter((f) => f.status === 'open');
  if (openDoc.length && verdict === 'PASS') verdict = 'PASS_WITH_NOTES';
  for (const f of openDoc) reasons.push(`document-level: ${f.rule_or_category}`);
  return { verdict, reasons, penalty, score, words };
}

export function usageOfLocale(lc: LocaleContext): LocaleResult['usage'] {
  return totalsOf(lc.run.costs.calls().filter((c) => c.locale === lc.target));
}
