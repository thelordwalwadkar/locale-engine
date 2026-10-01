/** The service layer end to end (mock providers, no network): what the CLI, REST and MCP interfaces all call. */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { createEngine } from '../src/pipeline/engine.js';
import type { EngineOptions } from '../src/pipeline/types.js';
import type { MockCall, MockScript } from '../src/providers/mock.js';
import { EVIDENCE_TAG_RE, LOCALES } from '../src/schemas/common.js';
import type { PageJson, RunReport } from '../src/schemas/index.js';
import { RunReportSchema } from '../src/schemas/report.js';
import { ProviderError } from '../src/schemas/provider.js';
import type { ProviderRegistry } from '../src/schemas/provider.js';
import type { SourceDocument } from '../src/schemas/segment.js';
import { goldenDoc, goldenFixtures, makeDoc, mockProvider, NOW, segment, testRegistry } from './helpers/harness.js';

const cfg = loadConfig();
const quiet = { write_outputs: false } as const;
const text = { kind: 'text' as const, text: 'placeholder', format: 'text' as const };

function engine(script: MockScript = {}, over: Partial<EngineOptions> = {}, doc: () => SourceDocument = goldenDoc) {
  const registry = testRegistry(mockProvider('mock', script));
  return createEngine({ config: cfg, registryFactory: () => registry, documentLoader: async () => doc(), now: () => NOW, env: {}, outputRoot: 'output-test', ...over });
}

/** Every finding, change, note and recommendation in a report carries an evidence tag (spec success criterion 5). */
function assertEvidence(report: RunReport): void {
  for (const l of report.locales) {
    for (const r of l.recommendations) expect(EVIDENCE_TAG_RE.test(r.text), `${l.target_locale} ${r.id}`).toBe(true);
    for (const f of l.document_findings) expect(EVIDENCE_TAG_RE.test(f.explanation)).toBe(true);
    for (const s of l.segments) {
      for (const c of s.changes) expect(EVIDENCE_TAG_RE.test(c.reason), `${s.segment_id} change ${c.rule}`).toBe(true);
      for (const n of s.notes) expect(EVIDENCE_TAG_RE.test(n)).toBe(true);
      for (const f of s.validation?.findings ?? []) expect(EVIDENCE_TAG_RE.test(f.explanation), `${s.segment_id} ${f.rule_or_category}`).toBe(true);
      for (const c of s.validation?.deterministic_checks ?? []) expect(EVIDENCE_TAG_RE.test(c.note)).toBe(true);
      for (const f of s.changes) expect(f.rule.length).toBeGreaterThan(0);
    }
  }
}

describe('run_pipeline', () => {
  it('--targets all produces all six default locales for a Dutch source, schema-valid and fully evidence-tagged', async () => {
    const calls: MockCall[] = [];
    const report = await engine({ calls }).runPipeline({ input: text, targets: 'all', options: quiet });
    expect(RunReportSchema.parse(report)).toBeTruthy();
    expect(report.status).toBe('COMPLETE');
    expect(report.locales.map((l) => l.target_locale)).toEqual(['en-NL', 'en-GB', 'de-DE', 'de-AT', 'de-CH', 'it-IT']);
    expect(report.options).toMatchObject({ pass_threshold: 90, max_repair_loops: 2, cost_ceiling_usd: 5, stages: { translate: true, localize: true, validate: true, repair: true, backtranslate: true } });
    expect(report.source).toMatchObject({ source_locale: 'nl-NL', source_language: 'nl', page_type: 'CONTENT', segments: 1 });
    expect(report.totals.calls).toBe(calls.length);
    expect(report.calls).toHaveLength(calls.length);
    expect(report.routing.translation).toEqual({ provider: 'mock', model: 'mock-a' });
    expect(report.output_dir).toBeNull();
    expect(report.run_log.map((e) => e.code)).toEqual(expect.arrayContaining(['RUN_START', 'SOURCE', 'RUN_END']));
    expect(report.run_id).toMatch(/^run_20260930T120000Z_[0-9a-f]{4}$/);
    for (const l of report.locales) {
      expect(l.segments).toHaveLength(1);
      expect(l.seo_meta.hreflang).toBe(l.hreflang);
      expect(l.recommendations.length).toBeGreaterThan(0);
    }
    assertEvidence(report);
  });

  it('the golden exemplar through the engine: de-CH scores 95 and goes to HUMAN_REVIEW', async () => {
    const report = await engine({ fixtures: goldenFixtures() }).runPipeline({ input: text, targets: ['de-CH'], options: quiet });
    const [l] = report.locales;
    expect(report.locales).toHaveLength(1);
    expect(l).toMatchObject({ target_locale: 'de-CH', verdict: 'HUMAN_REVIEW', quality_score: 95 });
    expect(l?.segments[0]?.final_text).toContain('Offerte');
    assertEvidence(report);
  });

  it('uses the caller run id, rejects unsafe ones, and reports explicit per-run thresholds', async () => {
    const e = engine();
    const r = await e.runPipeline({ input: text, targets: ['de-DE'], options: { ...quiet, run_id: 'my-run_1', pass_threshold: 80, max_repair_loops: 1, cost_ceiling_usd: 2 } });
    expect(r.run_id).toBe('my-run_1');
    expect(r.options).toMatchObject({ pass_threshold: 80, max_repair_loops: 1, cost_ceiling_usd: 2 });
    await expect(e.runPipeline({ input: text, targets: ['de-DE'], options: { ...quiet, run_id: '../evil' } })).rejects.toMatchObject({ code: 'INPUT_INVALID' });
  });

  it('the cost ceiling halts the run: status HALTED_COST_CEILING, logged, partial report', async () => {
    const report = await engine().runPipeline({ input: text, targets: 'all', options: { ...quiet, cost_ceiling_usd: 1e-9 } });
    expect(report.status).toBe('HALTED_COST_CEILING');
    expect(report.run_log.some((e) => e.code === 'COST_CEILING')).toBe(true);
    expect(report.locales.every((l) => l.verdict === 'FAIL')).toBe(true);
    expect(RunReportSchema.parse(report)).toBeTruthy();
  });

  it('per-run provider overrides reach the registry factory', async () => {
    const seen: unknown[] = [];
    const registry = testRegistry(mockProvider('mock'));
    const e = createEngine({ config: cfg, registryFactory: (a) => (seen.push(a.overrides), registry), documentLoader: async () => goldenDoc(), now: () => NOW, env: {} });
    await e.runPipeline({ input: text, targets: ['de-DE'], options: { ...quiet, providers: { validation: 'openai:sol' } } });
    expect(seen[0]).toEqual({ validation: 'openai:sol' });
  });

  it('registry notes (fallback, judge independence) are copied into the run log as warnings', async () => {
    const base = testRegistry(mockProvider('mock'));
    const registry: ProviderRegistry = { ...base, notes: [{ code: 'JUDGE_NOT_INDEPENDENT', message: 'validation and translation both use "mock"', stage: 'validation' }] };
    const e = createEngine({ config: cfg, registryFactory: () => registry, documentLoader: async () => goldenDoc(), now: () => NOW, env: {} });
    const report = await e.runPipeline({ input: text, targets: ['de-DE'], options: quiet });
    const entry = report.run_log.find((x) => x.code === 'JUDGE_NOT_INDEPENDENT');
    expect(entry).toMatchObject({ level: 'warn', stage: 'validation' });
  });

  it('fails early with PROVIDER_UNAVAILABLE when a needed stage has no usable provider', async () => {
    const dead: ProviderRegistry = {
      forStage: () => {
        throw new ProviderError('ANTHROPIC_API_KEY is not set', 'NO_CREDENTIALS', { provider: 'anthropic' });
      },
      get: () => {
        throw new Error('unused');
      },
      describe: () => [],
      notes: [],
    };
    const e = createEngine({ config: cfg, registryFactory: () => dead, documentLoader: async () => goldenDoc(), now: () => NOW, env: {} });
    await expect(e.runPipeline({ input: text, targets: ['de-DE'], options: quiet })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('routes are validated: English → nl-NL is disabled by default, unsupported source languages are refused, unknown locales are input errors', async () => {
    const en = () => makeDoc([segment({ segment_id: 'p-001', text: 'Our pumps are robust and reliable.', lang: { lang: 'en', confidence: 0.99, method: 'lib' } })], { source_locale: 'en-*', source_language: 'en' });
    await expect(engine({}, {}, en).runPipeline({ input: text, targets: ['nl-NL'], options: quiet })).rejects.toMatchObject({ code: 'UNSUPPORTED_ROUTE' });
    const de = () => makeDoc([segment({ segment_id: 'p-001', text: 'Unsere Pumpen sind robust.', lang: { lang: 'de', confidence: 0.99, method: 'lib' } })], { source_locale: 'de-*', source_language: 'de' });
    await expect(engine({}, {}, de).runPipeline({ input: text, targets: 'all', options: quiet })).rejects.toMatchObject({ code: 'UNSUPPORTED_ROUTE' });
    await expect(engine().runPipeline({ input: text, targets: ['de-XX'] as never, options: quiet })).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    const report = await engine({}, {}, en).runPipeline({ input: text, targets: 'all', options: quiet });
    expect(report.locales.map((l) => l.target_locale)).toEqual(['en-NL', 'en-GB', 'de-DE', 'de-AT', 'de-CH', 'it-IT']);
    expect(report.locales[0]?.operations).toEqual({ ADAPT_ONLY: 1 });
  });

  it('a locale that crashes becomes a FAIL locale with the reason; the other locales and the run survive (status PARTIAL)', async () => {
    const broken = structuredClone(cfg);
    const rules = broken.locales['de-AT'].effective_rules;
    rules.push({ type: 'lexicon', id: 'DEAT-BROKEN-01', severity: 'minor', message: 'deliberately broken pattern', autofix: false, hypothesis: false, terms: [{ pattern: '(', preserve_case: true }], tests: [{ target: 'x', expect: 'pass' }] });
    const registry = testRegistry(mockProvider('mock'));
    const e = createEngine({ config: broken, registryFactory: () => registry, documentLoader: async () => goldenDoc(), now: () => NOW, env: {} });
    const report = await e.runPipeline({ input: text, targets: ['de-DE', 'de-AT', 'it-IT'], options: quiet });
    expect(report.status).toBe('PARTIAL');
    const at = report.locales.find((l) => l.target_locale === 'de-AT');
    expect(at?.verdict).toBe('FAIL');
    expect(at?.verdict_reasons[0]).toContain('RUN_ERROR');
    expect(report.locales.filter((l) => l.target_locale !== 'de-AT').every((l) => l.verdict !== 'FAIL' || l.segments.length > 0)).toBe(true);
    expect(report.run_log.some((x) => x.code === 'LOCALE_FAILED' && x.locale === 'de-AT')).toBe(true);
    expect(RunReportSchema.parse(report)).toBeTruthy();
  });
});

describe('translate_content and localize_content', () => {
  it('translate stops before validation: no judge, verdict HUMAN_REVIEW "NOT_VALIDATED"', async () => {
    const calls: MockCall[] = [];
    const report = await engine({ calls }).translateContent({ input: text, targets: ['de-CH'], options: quiet });
    expect([...new Set(calls.map((c) => c.stage))]).toEqual(['translation']);
    expect(report.options.stages).toEqual({ translate: true, localize: false, validate: false, repair: false, backtranslate: false });
    const l = report.locales[0];
    expect(l?.verdict).toBe('HUMAN_REVIEW');
    expect(l?.verdict_reasons.join(' ')).toContain('NOT_VALIDATED');
    expect(l?.segments[0]?.validation).toBeNull();
    expect(l?.segments[0]?.final_text).toContain('Kreiselpumpen');
  });

  it('localize accepts the page.json of a translate run and does not translate again', async () => {
    const calls: MockCall[] = [];
    const e = engine({ calls, fixtures: goldenFixtures() });
    const t = await e.translateContent({ input: text, targets: ['de-CH'], options: quiet });
    const page: PageJson = { schema_version: 1, run_id: t.run_id, source: t.source, locale: t.locales[0] as PageJson['locale'] };
    calls.length = 0;
    const l = await e.localizeContent({ input: { kind: 'page_json', page }, targets: 'all', options: quiet });
    expect([...new Set(calls.map((c) => c.stage))]).toEqual(['localization']);
    expect(l.locales).toHaveLength(1);
    expect(l.locales[0]?.segments[0]?.final_text).toContain('Offerte');
    await expect(e.localizeContent({ input: { kind: 'page_json', page }, targets: ['it-IT'], options: quiet })).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    await expect(e.translateContent({ input: { kind: 'page_json', page }, targets: 'all', options: quiet })).rejects.toMatchObject({ code: 'INPUT_INVALID' });
  });
});

describe('validate_content', () => {
  const pair = (target_text: string) => ({ kind: 'pair' as const, source_text: 'De grootte van de pomp is aanzienlijk.', source_locale: 'nl-NL', target_text, target_locale: 'de-CH' as const, block_type: 'paragraph' as const });

  it('validates a source/target pair without repair by default: the critical ß is reported, not silently fixed', async () => {
    const report = await engine().validateContent({ input: pair('Die Größe der Pumpe ist beträchtlich.'), options: quiet });
    expect(report.options.stages).toMatchObject({ translate: false, localize: false, validate: true, repair: false });
    const seg = report.locales[0]?.segments[0];
    expect(seg?.final_text).toBe('Die Größe der Pumpe ist beträchtlich.');
    expect(seg?.validation?.findings.some((f) => f.rule_or_category === 'DECH-SZ-01' && f.severity === 'critical')).toBe(true);
    expect(report.locales[0]?.verdict).toBe('FAIL');
  });

  it('with repair enabled the same pair is fixed deterministically and passes', async () => {
    const report = await engine().validateContent({ input: pair('Die Größe der Pumpe ist beträchtlich.'), options: { ...quiet, repair: true } });
    const seg = report.locales[0]?.segments[0];
    expect(seg?.final_text).toBe('Die Grösse der Pumpe ist beträchtlich.');
    expect(seg?.repairs[0]).toMatchObject({ origin: 'autofix', rule: 'DECH-SZ-01' });
    expect(report.locales[0]?.verdict).toBe('PASS');
  });

  it('re-validates a page.json from an earlier run and reaches the same verdict and score', async () => {
    const e = engine({ fixtures: goldenFixtures() });
    const first = await e.runPipeline({ input: text, targets: ['de-CH'], options: quiet });
    const page: PageJson = { schema_version: 1, run_id: first.run_id, source: first.source, locale: first.locales[0] as PageJson['locale'] };
    const second = await e.validateContent({ input: { kind: 'page_json', page }, options: quiet });
    expect(second.locales[0]).toMatchObject({ target_locale: 'de-CH', verdict: first.locales[0]?.verdict, quality_score: first.locales[0]?.quality_score });
    expect(second.locales[0]?.segments[0]?.final_text).toBe(first.locales[0]?.segments[0]?.final_text);
    assertEvidence(second);
  });
});

describe('list_locales', () => {
  it('describes all seven locales with their rules and market checks', () => {
    const { locales } = engine().listLocales();
    expect(locales.map((l) => l.locale)).toEqual([...LOCALES]);
    const ch = locales.find((l) => l.locale === 'de-CH');
    expect(ch?.rules.find((r) => r.id === 'DECH-SZ-01')).toMatchObject({ severity: 'critical', type: 'lexicon' });
    expect(ch?.rule_count).toBe(ch?.rules.length);
    expect(ch?.market_checks.some((m) => m.applies === 'legal_page')).toBe(true);
    expect(ch?.description).not.toContain('\n');
  });
});
