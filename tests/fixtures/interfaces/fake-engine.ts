/** A fake `Engine` for the interface tests: canned, schema-valid results; records every call with the request it received. */
import { loadConfig } from '../../../src/config/load.js';
import type { LoadedConfig } from '../../../src/config/load.js';
import type { Engine } from '../../../src/pipeline/types.js';
import { CompareReportSchema, ListLocalesResponseSchema, ProviderTestResultSchema, RunReportSchema } from '../../../src/schemas/index.js';
import type {
  CompareReport,
  Finding,
  ListLocalesResponse,
  LocaleCode,
  LocaleResult,
  ProviderTestResult,
  RunLogEntry,
  RunReport,
  RunStatus,
  Severity,
  Verdict,
} from '../../../src/schemas/index.js';

export interface LocaleSpec {
  locale: LocaleCode;
  verdict?: Verdict;
  score?: number;
  /** Open findings per severity. */
  open?: Partial<Record<Severity, number>>;
  humanReview?: number;
  cost?: number;
  unpricedCalls?: number;
  reasons?: string[];
}

export interface ReportSpec {
  runId?: string;
  status?: RunStatus;
  locales?: LocaleSpec[];
  /** `options.stages.validate`; false models a translate-only / localize-only run. */
  validate?: boolean;
  outputDir?: string | null;
  artifacts?: string[];
  runLog?: RunLogEntry[];
  pageType?: 'CONTENT' | 'LEGAL';
  costCeiling?: number;
}

const SEVERITIES: readonly Severity[] = ['minor', 'major', 'critical'];

function finding(locale: LocaleCode, severity: Severity, n: number): Finding {
  return {
    finding_id: `${locale}-${severity}-${n}`,
    locale,
    segment_id: 'p-001',
    origin: 'deterministic',
    rule_or_category: 'TEST-RULE-01',
    severity,
    evidence: '[EVIDENCE: TEST-RULE-01]',
    explanation: '[EVIDENCE: TEST-RULE-01] A finding for the tests.',
    source_span: null,
    target_span: null,
    span: null,
    suggested_fix: null,
    autofix: null,
    requires_human_review: false,
    repair_trigger: false,
    status: 'open',
  };
}

function makeLocale(spec: LocaleSpec, validate: boolean): LocaleResult {
  const { locale } = spec;
  const verdict = spec.verdict ?? 'PASS';
  const score = spec.score ?? 96;
  const open: Record<Severity, number> = { minor: 0, major: 0, critical: 0, ...spec.open };
  const findings = SEVERITIES.flatMap((severity) => Array.from({ length: open[severity] }, (_, n) => finding(locale, severity, n)));
  const humanReview = spec.humanReview ?? 0;
  const cost = spec.cost ?? 0.01;
  return {
    target_locale: locale,
    hreflang: locale,
    verdict,
    verdict_reasons: spec.reasons ?? [],
    quality_score: score,
    penalty: 100 - score,
    word_count: 2,
    operations: { TRANSLATE_LOCALIZE: 1 },
    counts: {
      segments: 1,
      ok: 1,
      provider_error: 0,
      not_processed: 0,
      findings_minor: open.minor,
      findings_major: open.major,
      findings_critical: open.critical,
      findings_open: findings.length,
      changes: 0,
      format_changes: 0,
      repairs: 0,
      human_review_segments: humanReview,
    },
    providers: { translation: { provider: 'mock', model: 'mock-1' } },
    usage: { calls: 2, input_tokens: 100, output_tokens: 50, cost_usd: cost, unpriced_calls: spec.unpricedCalls ?? 0, latency_ms: 1200 },
    segments: [
      {
        segment_id: 'p-001',
        block_type: 'paragraph',
        order: 1,
        inline: {},
        source_text: 'Onze pompen.',
        source_lang: 'nl',
        source_lang_confidence: 0.99,
        operation: 'TRANSLATE_LOCALIZE',
        status: 'OK',
        translation: 'Our pumps.',
        localized_text: 'Our pumps.',
        final_text: 'Our pumps.',
        changes: [],
        format_changes: [],
        entities_preserved: [],
        terminology_applied: [],
        requires_human_review: humanReview > 0,
        review_reasons: [],
        repairs: [],
        validation: validate
          ? {
              segment_id: 'p-001',
              target_locale: locale,
              deterministic_checks: [],
              llm_judge: null,
              back_translation: null,
              back_translation_similarity: null,
              quality_score: score,
              penalty: 100 - score,
              word_count: 2,
              verdict,
              verdict_reasons: spec.reasons ?? [],
              localization_recommendations: [],
              findings,
            }
          : null,
        notes: [],
      },
    ],
    document_findings: [],
    seo_meta: {
      locale,
      hreflang: locale,
      title: 'Pumps',
      title_length: 5,
      title_max: 60,
      title_ok: true,
      meta_description: null,
      meta_description_length: 0,
      meta_description_max: 155,
      meta_description_ok: true,
      slug: 'pumps',
      h1: null,
      primary_keyword: null,
    },
    recommendations: [],
  };
}

/** A schema-valid `RunReport`; throws when the spec produces something `RunReportSchema` rejects. */
export function makeRunReport(spec: ReportSpec = {}): RunReport {
  const validate = spec.validate ?? true;
  const localeSpecs = spec.locales ?? [{ locale: 'en-GB' }, { locale: 'de-CH', verdict: 'HUMAN_REVIEW', score: 95, open: { minor: 1, major: 1 }, humanReview: 1, cost: 0.02 }];
  const locales = localeSpecs.map((s) => makeLocale(s, validate));
  const cost = locales.reduce((sum, l) => sum + l.usage.cost_usd, 0);
  const outputDir = spec.outputDir === undefined ? '/out/run-1' : spec.outputDir;
  return RunReportSchema.parse({
    schema_version: 1,
    run_id: spec.runId ?? 'run-1',
    tool_version: '0.1.0',
    status: spec.status ?? 'COMPLETE',
    started_at: '2026-09-30T10:00:00.000Z',
    finished_at: '2026-09-30T10:00:12.300Z',
    duration_ms: 12300,
    source: {
      doc_id: 'doc-1',
      origin_kind: 'url',
      origin_ref: 'https://example.nl/pompen',
      source_locale: 'nl-NL',
      source_language: 'nl',
      page_type: spec.pageType ?? 'CONTENT',
      page_type_evidence: 'url path contains "privacyverklaring"',
      segments: 1,
      words: 2,
      languages: { nl: 1 },
    },
    options: {
      targets: locales.map((l) => l.target_locale),
      pass_threshold: 90,
      max_repair_loops: 2,
      cost_ceiling_usd: spec.costCeiling ?? 5,
      stages: { translate: true, localize: true, validate, repair: true, backtranslate: true },
    },
    routing: { translation: { provider: 'mock', model: 'mock-1' } },
    locales,
    totals: {
      calls: locales.length * 2,
      input_tokens: locales.length * 100,
      output_tokens: locales.length * 50,
      cost_usd: cost,
      unpriced_calls: locales.reduce((sum, l) => sum + l.usage.unpriced_calls, 0),
      latency_ms: 1200,
    },
    calls: [],
    run_log: spec.runLog ?? [],
    output_dir: outputDir,
    artifacts: outputDir === null ? [] : (spec.artifacts ?? ['localization_report.xlsx', 'executive_summary.md', 'run.json', 'en-GB/page.json', 'de-CH/page.json']),
  });
}

export function makeCompareReport(): CompareReport {
  const source = makeRunReport().source;
  const judge = { provider: 'openai', model: 'gpt-judge' };
  return CompareReportSchema.parse({
    schema_version: 1,
    compare_id: 'cmp-1',
    created_at: '2026-09-30T10:00:00.000Z',
    source,
    targets: ['de-CH'],
    providers: ['anthropic', 'openai'],
    judge,
    scores: [
      { provider: 'anthropic', locale: 'de-CH', quality_score: 97, verdict: 'PASS', penalty: 3, findings_minor: 1, findings_major: 0, findings_critical: 0, judge_avg: null },
      { provider: 'openai', locale: 'de-CH', quality_score: 91.5, verdict: 'PASS_WITH_NOTES', penalty: 8.5, findings_minor: 2, findings_major: 1, findings_critical: 0, judge_avg: null },
    ],
    findings: [],
    cost_latency: [
      { provider: 'anthropic', stage: 'translation', calls: 2, input_tokens: 100, output_tokens: 50, cost_usd: 0.01, latency_ms: 900 },
      { provider: 'anthropic', stage: 'all', calls: 5, input_tokens: 400, output_tokens: 200, cost_usd: 0.03, latency_ms: 2500 },
      { provider: 'openai', stage: 'all', calls: 4, input_tokens: 350, output_tokens: 180, cost_usd: 0.02, latency_ms: 1800 },
    ],
    segment_diff: [],
    runs: { anthropic: 'cmp-1-anthropic', openai: 'cmp-1-openai' },
    totals: { calls: 9, input_tokens: 750, output_tokens: 380, cost_usd: 0.05, unpriced_calls: 0, latency_ms: 4300 },
    output_dir: '/out/cmp-1',
    artifacts: ['model_comparison.xlsx'],
    notes: [],
  });
}

export function makeLocalesResponse(): ListLocalesResponse {
  const locale = (code: LocaleCode, language: string, region: string, name: string, rules: number): ListLocalesResponse['locales'][number] => ({
    locale: code,
    language,
    region,
    display_name: name,
    hreflang: code,
    description: `${name} test profile`,
    rule_count: rules,
    rules: [{ id: 'TEST-RULE-01', severity: 'minor', type: 'lexicon', message: 'A rule for the tests.' }],
    market_checks: [{ id: 'TEST-MARKET-01', text: 'A market check.', applies: 'always' }],
  });
  return ListLocalesResponseSchema.parse({
    locales: [locale('en-GB', 'en', 'GB', 'British English', 12), locale('de-CH', 'de', 'CH', 'Swiss German', 21)],
  });
}

export function makeProviderResults(): ProviderTestResult[] {
  return [
    { provider: 'anthropic', model: 'claude-x', configured: true, ok: true, structured_output: 'native', latency_ms: 812.4, cost_usd: 0.0002, warnings: [], error: null },
    { provider: 'openai', model: 'gpt-x', configured: false, ok: false, structured_output: 'native', latency_ms: null, cost_usd: null, warnings: [], error: 'NO_CREDENTIALS: set OPENAI_API_KEY' },
  ].map((r) => ProviderTestResultSchema.parse(r));
}

export type EngineMethod =
  | 'runPipeline'
  | 'translateContent'
  | 'localizeContent'
  | 'validateContent'
  | 'compareModels'
  | 'listLocales'
  | 'getRunReport'
  | 'testProviders';

let cachedConfig: LoadedConfig | undefined;

export class FakeEngine implements Engine {
  readonly calls: Array<{ method: EngineMethod; request: unknown }> = [];
  report: RunReport = makeRunReport();
  compareReport: CompareReport = makeCompareReport();
  locales: ListLocalesResponse = makeLocalesResponse();
  providerResults: ProviderTestResult[] = makeProviderResults();
  /** When set, every call records itself and then fails with this error. */
  failure: Error | undefined;

  /** Nothing in the interfaces reads it; loaded on demand so the tests do not pay for it. */
  get config(): LoadedConfig {
    cachedConfig ??= loadConfig();
    return cachedConfig;
  }

  get lastCall(): { method: EngineMethod; request: unknown } | undefined {
    return this.calls.at(-1);
  }

  private record(method: EngineMethod, request: unknown): void {
    this.calls.push({ method, request });
    if (this.failure) throw this.failure;
  }

  async runPipeline(req: Parameters<Engine['runPipeline']>[0]): Promise<RunReport> {
    this.record('runPipeline', req);
    return this.report;
  }

  async translateContent(req: Parameters<Engine['translateContent']>[0]): Promise<RunReport> {
    this.record('translateContent', req);
    return this.report;
  }

  async localizeContent(req: Parameters<Engine['localizeContent']>[0]): Promise<RunReport> {
    this.record('localizeContent', req);
    return this.report;
  }

  async validateContent(req: Parameters<Engine['validateContent']>[0]): Promise<RunReport> {
    this.record('validateContent', req);
    return this.report;
  }

  async compareModels(req: Parameters<Engine['compareModels']>[0]): Promise<CompareReport> {
    this.record('compareModels', req);
    return this.compareReport;
  }

  listLocales(): ListLocalesResponse {
    this.record('listLocales', undefined);
    return this.locales;
  }

  async getRunReport(req: Parameters<Engine['getRunReport']>[0]): Promise<RunReport> {
    this.record('getRunReport', req);
    return this.report;
  }

  async testProviders(names?: string[]): Promise<ProviderTestResult[]> {
    this.record('testProviders', names);
    return this.providerResults;
  }
}
