/**
 * Pure row builders for the comparison report: no I/O, no clock, deterministic. The harness hands them the successful
 * candidate runs; the workbook writer and the tests reuse them.
 *
 * Costs are attributed by STAGE, never by who happened to be billed: translation / localization / repair belong to the candidate,
 * validation / backtranslation to the fixed judge (they are identical work for every candidate and must not leak into a candidate's total).
 */
import type {
  CallRecord,
  CompareReport,
  Finding,
  LocaleCode,
  LocaleResult,
  RunReport,
  SegmentResult,
  Severity,
  Stage,
  Verdict,
} from '../schemas/index.js';
import { round } from '../util/text.js';

export type CompareScoreRow = CompareReport['scores'][number];
export type CompareFindingRow = CompareReport['findings'][number];
export type CompareCostRow = CompareReport['cost_latency'][number];
export type CompareSegmentDiffRow = CompareReport['segment_diff'][number];

/** A successful candidate run. `ref` is the provider ref the candidate was requested as (`provider[:model-key]`). */
export interface CandidateRun {
  ref: string;
  report: RunReport;
}

/** Whose money a call is: the candidate's, the judge's, or pipeline plumbing that is the same for every candidate (language detection). */
export type CostRole = 'candidate' | 'judge' | 'pipeline';

export const CANDIDATE_STAGES: readonly Stage[] = ['translation', 'localization', 'repair'];
export const JUDGE_STAGES: readonly Stage[] = ['validation', 'backtranslation'];

/** Role of a `cost_latency` row. The per-candidate `all` row totals the candidate stages only, so it is a candidate row. */
export function costRole(stage: Stage | 'all'): CostRole {
  if (stage === 'all' || CANDIDATE_STAGES.includes(stage)) return 'candidate';
  return JUDGE_STAGES.includes(stage) ? 'judge' : 'pipeline';
}

// ---------------------------------------------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------------------------------------------

function findLocale(report: RunReport, locale: LocaleCode): LocaleResult | undefined {
  return report.locales.find((l) => l.target_locale === locale);
}

/** Segments in document order (`Array.prototype.sort` is stable, so equal `order` keeps the pipeline's sequence). */
function orderedSegments(locale: LocaleResult | undefined): SegmentResult[] {
  return locale ? [...locale.segments].sort((a, b) => a.order - b.order) : [];
}

/** Every finding of a locale: segment findings in document order, then the document-level ones. */
function findingsOf(locale: LocaleResult): Finding[] {
  return [...orderedSegments(locale).flatMap((s) => s.validation?.findings ?? []), ...locale.document_findings];
}

// ---------------------------------------------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------------------------------------------

const JUDGE_DIMENSIONS = ['accuracy', 'fluency', 'terminology', 'locale_conventions', 'style_brand'] as const;

/** Translate-only / localize-only runs skip validation; the locale then carries a verdict reason starting `NOT_VALIDATED`. */
export function isNotValidated(locale: LocaleResult): boolean {
  return locale.verdict_reasons.some((reason) => reason.startsWith('NOT_VALIDATED'));
}

/** Mean of each judge dimension over the segments the judge actually scored; null when it scored none (or the locale was not validated). */
function judgeAverages(locale: LocaleResult): CompareScoreRow['judge_avg'] {
  if (isNotValidated(locale)) return null;
  const judged = locale.segments.flatMap((s) => (s.validation?.llm_judge ? [s.validation.llm_judge.scores] : []));
  if (judged.length === 0) return null;
  const mean = (dimension: (typeof JUDGE_DIMENSIONS)[number]): number =>
    round(judged.reduce((sum, scores) => sum + scores[dimension], 0) / judged.length, 1);
  return {
    accuracy: mean('accuracy'),
    fluency: mean('fluency'),
    terminology: mean('terminology'),
    locale_conventions: mean('locale_conventions'),
    style_brand: mean('style_brand'),
  };
}

/**
 * One row per provider x locale (locales a run did not produce are skipped). Finding counts are the OPEN findings of the locale,
 * document-level ones included, so the counts reconcile with the Findings tab and with a verdict driven by a document finding.
 */
export function buildScoreRows(runs: readonly CandidateRun[], targets: readonly LocaleCode[]): CompareScoreRow[] {
  return runs.flatMap(({ ref, report }) =>
    targets.flatMap((locale) => {
      const result = findLocale(report, locale);
      if (!result) return [];
      const open = findingsOf(result).filter((f) => f.status === 'open');
      const count = (severity: Severity): number => open.filter((f) => f.severity === severity).length;
      return [
        {
          provider: ref,
          locale,
          quality_score: result.quality_score,
          verdict: result.verdict,
          penalty: result.penalty,
          findings_minor: count('minor'),
          findings_major: count('major'),
          findings_critical: count('critical'),
          judge_avg: judgeAverages(result),
        },
      ];
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------------------------

/** Every finding (any status) of every produced target locale, tagged with the provider; segment findings first, then document findings. */
export function buildFindingRows(runs: readonly CandidateRun[], targets: readonly LocaleCode[]): CompareFindingRow[] {
  return runs.flatMap(({ ref, report }) =>
    targets.flatMap((locale) => {
      const result = findLocale(report, locale);
      return result ? findingsOf(result).map((finding) => ({ provider: ref, ...finding })) : [];
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Cost & latency
// ---------------------------------------------------------------------------------------------------------------

export interface CostBucket {
  /** Candidate ref (candidate stages), judge ref (judge stages) or the serving provider's name (pipeline stages). */
  provider: string;
  stage: Stage;
  role: CostRole;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  /** Sum of the KNOWN call costs; calls without pricing are only counted in `unpriced_calls`. */
  cost_usd: number;
  latency_ms: number;
  unpriced_calls: number;
}

/**
 * Groups every call of every run by (owner, stage). Order: each candidate's stages in pipeline order, then the judge's stages
 * (aggregated over all runs), then the remaining plumbing stages.
 */
export function collectCostBuckets(runs: readonly CandidateRun[], judgeRef: string): CostBucket[] {
  const buckets = new Map<string, CostBucket>();
  const keyOf = (provider: string, stage: Stage): string => JSON.stringify([provider, stage]);
  const add = (provider: string, call: CallRecord): void => {
    const key = keyOf(provider, call.stage);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { provider, stage: call.stage, role: costRole(call.stage), calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, latency_ms: 0, unpriced_calls: 0 };
      buckets.set(key, bucket);
    }
    bucket.calls += 1;
    bucket.input_tokens += call.input_tokens;
    bucket.output_tokens += call.output_tokens;
    bucket.latency_ms += call.latency_ms;
    if (call.cost_usd === null) bucket.unpriced_calls += 1;
    else bucket.cost_usd += call.cost_usd;
  };
  for (const { ref, report } of runs) {
    for (const call of report.calls) {
      const role = costRole(call.stage);
      add(role === 'candidate' ? ref : role === 'judge' ? judgeRef : call.provider, call);
    }
  }

  const ordered: CostBucket[] = [];
  const take = (provider: string, stage: Stage): void => {
    const bucket = buckets.get(keyOf(provider, stage));
    if (bucket) ordered.push(bucket);
    buckets.delete(keyOf(provider, stage));
  };
  for (const { ref } of runs) for (const stage of CANDIDATE_STAGES) take(ref, stage);
  for (const stage of JUDGE_STAGES) take(judgeRef, stage);
  ordered.push(...buckets.values());
  return ordered;
}

function toCostRow(b: Pick<CostBucket, 'provider' | 'calls' | 'input_tokens' | 'output_tokens' | 'cost_usd' | 'latency_ms'>, stage: Stage | 'all'): CompareCostRow {
  // 6 decimals: fine enough for sub-cent call costs, coarse enough to drop float noise from summing.
  return {
    provider: b.provider,
    stage,
    calls: b.calls,
    input_tokens: b.input_tokens,
    output_tokens: b.output_tokens,
    cost_usd: round(b.cost_usd, 6),
    latency_ms: round(b.latency_ms, 3),
  };
}

/**
 * Rows per (provider, stage): every candidate's stage rows followed by its `all` row (candidate stages only, always present), then the
 * judge's stage rows and any pipeline rows. The judge's total is deliberately NOT an `all` row: the judge may also be a candidate and
 * the two `all` rows would be indistinguishable. Every non-`all` row sums to the runs' totals.
 */
export function buildCostRows(runs: readonly CandidateRun[], judgeRef: string): CompareCostRow[] {
  const buckets = collectCostBuckets(runs, judgeRef);
  const rows: CompareCostRow[] = [];
  for (const { ref } of runs) {
    const mine = buckets.filter((b) => b.role === 'candidate' && b.provider === ref);
    const total = { provider: ref, calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, latency_ms: 0 };
    for (const b of mine) {
      rows.push(toCostRow(b, b.stage));
      total.calls += b.calls;
      total.input_tokens += b.input_tokens;
      total.output_tokens += b.output_tokens;
      total.cost_usd += b.cost_usd;
      total.latency_ms += b.latency_ms;
    }
    rows.push(toCostRow(total, 'all'));
  }
  for (const b of buckets) if (b.role !== 'candidate') rows.push(toCostRow(b, b.stage));
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// Segment diff
// ---------------------------------------------------------------------------------------------------------------

/**
 * One row per target locale x segment id, in document order of the first run (ids only a later run has follow). `outputs` holds each
 * provider's `final_text` (null when it produced none); `identical` compares the non-null outputs byte for byte.
 */
export function buildSegmentDiff(runs: readonly CandidateRun[], targets: readonly LocaleCode[]): CompareSegmentDiffRow[] {
  const rows: CompareSegmentDiffRow[] = [];
  for (const locale of targets) {
    const byId = new Map<string, { source_text: string; outputs: Map<string, string | null> }>();
    for (const { ref, report } of runs) {
      for (const segment of orderedSegments(findLocale(report, locale))) {
        let entry = byId.get(segment.segment_id);
        if (!entry) {
          entry = { source_text: segment.source_text, outputs: new Map() };
          byId.set(segment.segment_id, entry);
        }
        entry.outputs.set(ref, segment.final_text);
      }
    }
    for (const [segment_id, entry] of byId) {
      const outputs = Object.fromEntries(runs.map(({ ref }) => [ref, entry.outputs.get(ref) ?? null]));
      const produced = Object.values(outputs).filter((text): text is string => text !== null);
      rows.push({ locale, segment_id, source_text: entry.source_text, outputs, identical: produced.every((text) => text === produced[0]) });
    }
  }
  return rows;
}

export interface MissingOutputCount {
  provider: string;
  locale: LocaleCode;
  /** Segments of the locale for which the provider produced no output (PROVIDER_ERROR, NOT_PROCESSED or absent). */
  missing: number;
  total: number;
}

/** Per provider x locale, how many segments of the diff have no output. Every combination is listed, zero counts included. */
export function countMissingOutputs(diff: readonly CompareSegmentDiffRow[]): MissingOutputCount[] {
  const counts = new Map<string, MissingOutputCount>();
  for (const row of diff) {
    for (const [provider, text] of Object.entries(row.outputs)) {
      const key = JSON.stringify([provider, row.locale]);
      const entry = counts.get(key) ?? { provider, locale: row.locale, missing: 0, total: 0 };
      entry.total += 1;
      if (text === null) entry.missing += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()];
}

// ---------------------------------------------------------------------------------------------------------------
// Best provider per locale
// ---------------------------------------------------------------------------------------------------------------

export interface BestProvider {
  locale: LocaleCode;
  provider: string;
  quality_score: number;
  verdict: Verdict;
  /** The winner's candidate-stage cost (its `all` cost row); null when the cost rows have none. */
  cost_usd: number | null;
  /** `score`: a unique top score; `cost`: a score tie settled by the lower cost; `order`: a tie on both, first listed wins. */
  decided_by: 'score' | 'cost' | 'order';
  /** The other providers that share the top score (empty when it is unique). */
  tied_with: string[];
}

/**
 * Highest quality score wins; a tie goes to the lower candidate cost (judge cost is shared by every candidate, so it never decides).
 * The score alone is the criterion: read it together with the segments that have no output.
 */
export function bestProviderPerLocale(scores: readonly CompareScoreRow[], costs: readonly CompareCostRow[]): BestProvider[] {
  const costOf = new Map(costs.filter((c) => c.stage === 'all').map((c) => [c.provider, c.cost_usd]));
  const cost = (row: CompareScoreRow): number => costOf.get(row.provider) ?? Number.POSITIVE_INFINITY;

  const byLocale = new Map<LocaleCode, CompareScoreRow[]>();
  for (const row of scores) {
    const list = byLocale.get(row.locale);
    if (list) list.push(row);
    else byLocale.set(row.locale, [row]);
  }

  return [...byLocale].map(([locale, rows]) => {
    const top = Math.max(...rows.map((r) => r.quality_score));
    const tied = rows.filter((r) => Math.abs(top - r.quality_score) < 1e-9);
    // Strict `<` keeps the earlier provider when costs are equal, so a full tie goes to request order.
    const winner = tied.reduce((best, row) => (cost(row) < cost(best) ? row : best));
    // Costs are rounded to 6 decimals when built, so equal costs are exactly equal doubles.
    const sameCost = tied.filter((r) => cost(r) === cost(winner));
    return {
      locale,
      provider: winner.provider,
      quality_score: winner.quality_score,
      verdict: winner.verdict,
      cost_usd: costOf.get(winner.provider) ?? null,
      decided_by: tied.length === 1 ? 'score' : sameCost.length === 1 ? 'cost' : 'order',
      tied_with: tied.filter((r) => r !== winner).map((r) => r.provider),
    };
  });
}
