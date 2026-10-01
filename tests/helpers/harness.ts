/** Shared test harness for pipeline tests: mock registry, run/locale contexts, the golden document and fixtures built from the exemplar files. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { LoadedConfig } from '../../src/config/load.js';
import { createMockProvider } from '../../src/providers/mock.js';
import type { MockFixtures, MockScript } from '../../src/providers/mock.js';
import { makeLocaleContext } from '../../src/pipeline/locale-run.js';
import { createPromptKit } from '../../src/pipeline/prompt.js';
import { scoringSettings } from '../../src/pipeline/scoring.js';
import { StageRunner } from '../../src/pipeline/stage-runner.js';
import type { LocaleContext, RunContext, RunSettings } from '../../src/pipeline/state.js';
import { ProviderConfigSchema } from '../../src/schemas/config.js';
import type { ProviderConfig } from '../../src/schemas/config.js';
import type { LocaleCode, Stage } from '../../src/schemas/common.js';
import type { LLMProvider, ProviderRegistry } from '../../src/schemas/provider.js';
import type { Segment, SourceDocument } from '../../src/schemas/segment.js';
import { CostTracker } from '../../src/telemetry/cost.js';
import { RunLog } from '../../src/telemetry/run-log.js';
import { projectRoot } from '../../src/util/paths.js';
import { hashText } from '../../src/util/text.js';

export const NOW = new Date('2026-09-30T12:00:00Z');

export function mockProviderConfig(): ProviderConfig {
  return ProviderConfigSchema.parse({
    kind: 'mock',
    default_model: 'mock-a',
    models: {
      'mock-a': { id: 'mock-a', structured_output: 'native', pricing: { input_per_mtok: 1, output_per_mtok: 2 }, pricing_verified: true },
      'mock-b': { id: 'mock-b', structured_output: 'prompted', pricing: { input_per_mtok: 3, output_per_mtok: 6 }, pricing_verified: true, unsupported_params: ['top_p'] },
    },
    timeout_ms: 1000,
    max_retries: 0,
  });
}

export function mockProvider(name: string, script: MockScript = {}, modelKey = 'mock-a'): LLMProvider {
  return createMockProvider(name, mockProviderConfig(), script, modelKey);
}

/** A registry that serves every stage with `fallback` unless `byStage` says otherwise. */
export function testRegistry(fallback: LLMProvider, byStage: Partial<Record<Stage, LLMProvider>> = {}): ProviderRegistry {
  return {
    forStage: (s) => byStage[s] ?? fallback,
    get: () => fallback,
    describe: () => [],
    notes: [],
  };
}

export function makeRun(cfg: LoadedConfig, registry: ProviderRegistry, over: { settings?: Partial<RunSettings>; ceiling?: number } = {}): RunContext {
  const log = new RunLog(() => NOW);
  const costs = new CostTracker(over.ceiling ?? 5);
  const settings: RunSettings = {
    passThreshold: 90,
    maxRepairLoops: 2,
    stages: { translate: true, localize: true, validate: true, repair: true, backtranslate: true },
    ...over.settings,
  };
  return {
    config: cfg,
    settings,
    kit: createPromptKit(cfg),
    runner: new StageRunner({ registry, stages: cfg.stages, costs, log, now: () => NOW }),
    log,
    costs,
    scoring: scoringSettings(cfg.stages, settings.passThreshold),
  };
}

export const GOLDEN_SOURCE =
  'Onze centrifugaalpompen leveren een debiet tot 450 m³/h bij een opvoerhoogte van 80 meter. Vraag vandaag nog een vrijblijvende offerte aan — levering binnen 5 werkdagen in heel Nederland.';

export function segment(over: Partial<Segment> & Pick<Segment, 'segment_id' | 'text'>): Segment {
  return {
    block_type: 'paragraph',
    order: 1,
    inline: {},
    hash: hashText(over.text),
    translatable: true,
    lang: { lang: 'nl', confidence: 0.99, method: 'lib' },
    ...over,
  };
}

export function makeDoc(segments: Segment[], over: Partial<SourceDocument> = {}): SourceDocument {
  return {
    doc_id: 'doc-test',
    origin: { kind: 'text', ref: 'test' },
    page_type: 'CONTENT',
    page_type_evidence: 'test fixture',
    source_locale: 'nl-NL',
    source_locale_evidence: 'declared',
    source_language: 'nl',
    head: {},
    seo: {},
    segments,
    warnings: [],
    ...over,
  };
}

/** The golden-standard input segment of spec §5.1 (segment id p-003). */
export function goldenDoc(over: Partial<SourceDocument> = {}): SourceDocument {
  return makeDoc([segment({ segment_id: 'p-003', text: GOLDEN_SOURCE })], over);
}

export function localeContext(cfg: LoadedConfig, target: LocaleCode, doc: SourceDocument, registry: ProviderRegistry, over: Parameters<typeof makeRun>[2] = {}): LocaleContext {
  return makeLocaleContext(makeRun(cfg, registry, over), target, doc);
}

// ---------------------------------------------------------------------------------------------------------------
// Golden exemplar files double as mock fixtures (single source of truth for spec §5.1)
// ---------------------------------------------------------------------------------------------------------------

type Golden = { input: { segments: Array<Record<string, unknown>> } & Record<string, unknown>; output: { results: Array<Record<string, unknown>> } };

export function readGolden(name: string): Golden {
  return JSON.parse(readFileSync(path.join(projectRoot(), 'prompts', 'exemplars', `golden.${name}.json`), 'utf8')) as Golden;
}

/** Fixtures that make the mock reproduce the golden exemplar of spec §5.1 for nl-NL → de-CH, segment p-003. */
export function goldenFixtures(): MockFixtures {
  const t = readGolden('translation').output.results[0] as Record<string, unknown>;
  const l = readGolden('localization').output.results[0] as Record<string, unknown>;
  const v = readGolden('validation').output.results[0] as Record<string, unknown>;
  const b = readGolden('backtranslation').output.results[0] as Record<string, unknown>;
  const strip = <T extends Record<string, unknown>>(o: T): Omit<T, 'segment_id' | 'target_locale'> => {
    const { segment_id: _s, target_locale: _t, ...rest } = o;
    return rest as Omit<T, 'segment_id' | 'target_locale'>;
  };
  return {
    translation: { 'de-CH': { 'p-003': strip(t) as never } },
    localization: { 'de-CH': { 'p-003': strip(l) as never } },
    validation: { 'de-CH': { 'p-003': strip(v) as never } },
    backtranslation: { 'de-CH': { 'p-003': b['back_translation'] as string } },
  };
}
