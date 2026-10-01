/**
 * Synthetic RunReports for the comparison tests. Everything goes through RunReportSchema, so a fixture that drifts from the real schema
 * fails loudly instead of exercising a shape the pipeline would never produce.
 */
import {
  RunReportSchema,
  type JudgeScores,
  type LocaleCode,
  type RunReport,
  type RunStatus,
  type Severity,
  type Stage,
  type Verdict,
} from '../../../src/schemas/index.js';

export interface FixtureFinding {
  id: string;
  severity: Severity;
  status?: 'open' | 'fixed' | 'accepted';
  rule?: string;
}

export interface FixtureSegment {
  id: string;
  source: string;
  /** `final_text`; null makes the segment a PROVIDER_ERROR one. */
  final: string | null;
  order?: number;
  /** Judge scores of the segment; omitted = the judge did not score it. */
  judge?: JudgeScores;
  findings?: FixtureFinding[];
}

export interface FixtureLocale {
  locale: LocaleCode;
  score: number;
  verdict: Verdict;
  penalty?: number;
  reasons?: string[];
  segments: FixtureSegment[];
  documentFindings?: FixtureFinding[];
}

export interface FixtureCall {
  stage: Stage;
  /** null = no pricing known for the model. */
  cost: number | null;
  ms: number;
  input?: number;
  output?: number;
  /** Provider that served the call (defaults to `mock`). */
  provider?: string;
}

export interface FixtureRun {
  runId: string;
  status?: RunStatus;
  locales: FixtureLocale[];
  calls?: FixtureCall[];
  routing?: RunReport['routing'];
  source?: Partial<RunReport['source']>;
}

const TS = '2026-09-30T14:00:00.000Z';
const micro = (n: number): number => Math.round(n * 1e6) / 1e6;

function findingOf(f: FixtureFinding, locale: LocaleCode, segmentId: string | null): unknown {
  const rule = f.rule ?? 'DECH-LEX-OFFERTE';
  return {
    finding_id: f.id,
    locale,
    segment_id: segmentId,
    origin: 'deterministic',
    rule_or_category: rule,
    severity: f.severity,
    evidence: `[EVIDENCE: ${rule}]`,
    explanation: `[EVIDENCE: ${rule}] ${f.severity} finding ${f.id}.`,
    source_span: null,
    target_span: null,
    span: null,
    suggested_fix: null,
    autofix: null,
    requires_human_review: f.severity === 'critical',
    repair_trigger: f.severity !== 'minor',
    status: f.status ?? 'open',
  };
}

function segmentOf(s: FixtureSegment, locale: LocaleCode, index: number): unknown {
  const ok = s.final !== null;
  return {
    segment_id: s.id,
    block_type: 'paragraph',
    order: s.order ?? index + 1,
    source_text: s.source,
    source_lang: 'nl',
    source_lang_confidence: 0.99,
    operation: 'TRANSLATE_LOCALIZE',
    status: ok ? 'OK' : 'PROVIDER_ERROR',
    translation: s.final,
    localized_text: s.final,
    final_text: s.final,
    changes: [],
    format_changes: [],
    entities_preserved: [],
    terminology_applied: [],
    requires_human_review: false,
    review_reasons: [],
    repairs: [],
    validation: ok
      ? {
          segment_id: s.id,
          target_locale: locale,
          deterministic_checks: [],
          llm_judge: s.judge ? { scores: s.judge, mqm_errors: [], confidence: 0.9 } : null,
          back_translation: null,
          back_translation_similarity: null,
          quality_score: 100,
          penalty: 0,
          word_count: 5,
          verdict: 'PASS',
          verdict_reasons: [],
          localization_recommendations: [],
          findings: (s.findings ?? []).map((f) => findingOf(f, locale, s.id)),
        }
      : null,
    notes: [],
  };
}

function localeOf(l: FixtureLocale): unknown {
  const segments = l.segments.map((s, i) => segmentOf(s, l.locale, i));
  const documentFindings = (l.documentFindings ?? []).map((f) => findingOf(f, l.locale, null));
  const all = [...l.segments.flatMap((s) => s.findings ?? []), ...(l.documentFindings ?? [])];
  const count = (severity: Severity): number => all.filter((f) => f.severity === severity).length;
  const failed = l.segments.filter((s) => s.final === null).length;
  return {
    target_locale: l.locale,
    hreflang: l.locale,
    verdict: l.verdict,
    verdict_reasons: l.reasons ?? [],
    quality_score: l.score,
    penalty: l.penalty ?? micro(100 - l.score),
    word_count: 40,
    operations: { TRANSLATE_LOCALIZE: l.segments.length },
    counts: {
      segments: l.segments.length,
      ok: l.segments.length - failed,
      provider_error: failed,
      not_processed: 0,
      findings_minor: count('minor'),
      findings_major: count('major'),
      findings_critical: count('critical'),
      findings_open: all.filter((f) => (f.status ?? 'open') === 'open').length,
      changes: 0,
      format_changes: 0,
      repairs: 0,
      human_review_segments: 0,
    },
    providers: {},
    usage: { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unpriced_calls: 0, latency_ms: 0 },
    segments,
    document_findings: documentFindings,
    seo_meta: {
      locale: l.locale,
      hreflang: l.locale,
      title: null,
      title_length: 0,
      title_max: 60,
      title_ok: true,
      meta_description: null,
      meta_description_length: 0,
      meta_description_max: 155,
      meta_description_ok: true,
      slug: null,
      h1: null,
      primary_keyword: null,
    },
    recommendations: [],
  };
}

/** A RunReport validated with `RunReportSchema`. Totals are derived from the calls, so they always agree with them. */
export function buildRunReport(run: FixtureRun): RunReport {
  const calls = (run.calls ?? []).map((c, i) => ({
    call_id: `call-${i + 1}`,
    ts: TS,
    stage: c.stage,
    locale: null,
    provider: c.provider ?? 'mock',
    model: 'mock-model',
    input_tokens: c.input ?? 100,
    output_tokens: c.output ?? 50,
    cost_usd: c.cost,
    latency_ms: c.ms,
    attempts: 1,
    ok: true,
    segments: 1,
    warnings: [],
  }));
  const sum = (pick: (c: (typeof calls)[number]) => number): number => calls.reduce((total, c) => total + pick(c), 0);
  return RunReportSchema.parse({
    schema_version: 1,
    run_id: run.runId,
    tool_version: '0.1.0-test',
    status: run.status ?? 'COMPLETE',
    started_at: TS,
    finished_at: TS,
    duration_ms: 1000,
    source: {
      doc_id: 'doc-1',
      origin_kind: 'text',
      origin_ref: 'pump-page',
      source_locale: 'nl-NL',
      source_language: 'nl',
      page_type: 'CONTENT',
      page_type_evidence: '[EVIDENCE: fixture]',
      segments: 4,
      words: 40,
      languages: { nl: 4 },
      ...run.source,
    },
    options: {
      targets: run.locales.map((l) => l.locale),
      pass_threshold: 90,
      max_repair_loops: 2,
      cost_ceiling_usd: 5,
      stages: { translate: true, localize: true, validate: true, repair: true, backtranslate: true },
    },
    routing: run.routing ?? {},
    locales: run.locales.map(localeOf),
    totals: {
      calls: calls.length,
      input_tokens: sum((c) => c.input_tokens),
      output_tokens: sum((c) => c.output_tokens),
      cost_usd: micro(sum((c) => c.cost_usd ?? 0)),
      unpriced_calls: calls.filter((c) => c.cost_usd === null).length,
      latency_ms: sum((c) => c.latency_ms),
    },
    calls,
    run_log: [],
    output_dir: null,
    artifacts: [],
  });
}
