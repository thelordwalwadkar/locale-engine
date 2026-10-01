/**
 * Three candidates for the same page, two target locales, one fixed judge, and fake `CompareDeps`. The numbers are chosen so that the
 * expected rows can be checked by hand:
 *  - `anthropic` (ALPHA): clean, the most expensive; one minor finding fixed, two open (one of them document-level).
 *  - `openai:gpt-mini` (BRAVO): cheap; a critical open finding in de-CH; ties ALPHA on en-GB (cheaper, so it wins the tie).
 *  - `google` (CHARLIE): highest de-CH score although one segment is a PROVIDER_ERROR; one unpriced call; no judge scores in en-GB.
 */
import os from 'node:os';
import path from 'node:path';
import type { LoadedConfig } from '../../../src/config/load.js';
import type { CompareDeps } from '../../../src/compare/types.js';
import {
  CompareRequestSchema,
  type CompareRequest,
  type JudgeScores,
  type PipelineRequest,
  type RunReport,
  type Stage,
  type StageBinding,
} from '../../../src/schemas/index.js';
import { buildRunReport, type FixtureCall, type FixtureLocale, type FixtureSegment } from './run-report.js';

export const ALPHA = 'anthropic';
export const BRAVO = 'openai:gpt-mini';
export const CHARLIE = 'google';
export const JUDGE = 'mistral';
// Same vendor as ALPHA, different model: used by the judge-independence tests.
export const SIBLING = 'anthropic:haiku';

export const BINDINGS: Record<string, StageBinding> = {
  [ALPHA]: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  [BRAVO]: { provider: 'openai', model: 'gpt-5-mini' },
  [CHARLIE]: { provider: 'google', model: 'gemini-3-flash' },
  [JUDGE]: { provider: 'mistral', model: 'mistral-large-3' },
  [SIBLING]: { provider: 'anthropic', model: 'claude-haiku-5' },
};

export const NOW = new Date('2026-09-30T14:15:16.789Z');

const judge = (accuracy: number, fluency: number, terminology: number, locale_conventions: number, style_brand: number): JudgeScores => ({
  accuracy,
  fluency,
  terminology,
  locale_conventions,
  style_brand,
});
const flat = (n: number): JudgeScores => judge(n, n, n, n, n);

const SOURCE = {
  h: 'Industriële pompen voor de procesindustrie',
  p1: 'Onze pompen leveren 450 m³/h bij 16 bar.',
  p2: 'Levering binnen 5 werkdagen.',
  m: 'Pompen | Voorbeeld BV',
};

/** The four segments of the page for one locale; `finals` are the final texts in document order (null = PROVIDER_ERROR). */
function segments(finals: [string | null, string | null, string | null, string | null], extra: Array<Partial<FixtureSegment>>): FixtureSegment[] {
  const base: Array<Pick<FixtureSegment, 'id' | 'source'>> = [
    { id: 'h-001', source: SOURCE.h },
    { id: 'p-001', source: SOURCE.p1 },
    { id: 'p-002', source: SOURCE.p2 },
    { id: 'm-title', source: SOURCE.m },
  ];
  return base.map((b, i) => ({ ...b, final: finals[i] ?? null, ...extra[i] }));
}

const call = (stage: Stage, cost: number | null, ms: number, more: Partial<FixtureCall> = {}): FixtureCall => ({ stage, cost, ms, ...more });
const times = (n: number, c: FixtureCall): FixtureCall[] => Array.from({ length: n }, () => c);

function routing(candidate: string): RunReport['routing'] {
  const cand = BINDINGS[candidate] as StageBinding;
  const jud = BINDINGS[JUDGE] as StageBinding;
  return { translation: cand, localization: cand, repair: cand, validation: jud, backtranslation: jud };
}

const alphaDe: FixtureLocale = {
  locale: 'de-CH',
  score: 96,
  verdict: 'PASS',
  penalty: 4,
  documentFindings: [{ id: 'f-a3', severity: 'minor', rule: 'INTEGRITY-CURRENCY' }],
  segments: segments(
    ['Industriepumpen für die Prozessindustrie', 'Unsere Pumpen liefern 450 m³/h bei 16 bar.', 'Lieferung innert 5 Arbeitstagen.', 'Pumpen | Beispiel AG'],
    [
      { judge: judge(95, 94, 93, 92, 91), findings: [{ id: 'f-a2', severity: 'minor', status: 'fixed' }] },
      { judge: judge(91, 90, 89, 88, 87) },
      { judge: judge(94, 92, 91, 87, 88), findings: [{ id: 'f-a1', severity: 'minor' }] },
      {},
    ],
  ),
};
const alphaEn: FixtureLocale = {
  locale: 'en-GB',
  score: 92.5,
  verdict: 'PASS_WITH_NOTES',
  penalty: 7.5,
  segments: segments(
    ['Industrial pumps for the process industry', 'Our pumps deliver 450 m³/h at 16 bar.', 'Delivery within 5 working days.', 'Pumps | Example Ltd'],
    [{ judge: flat(90) }, { judge: flat(90) }, { judge: flat(90) }, { judge: flat(90) }],
  ),
};
const bravoDe: FixtureLocale = {
  locale: 'de-CH',
  score: 88,
  verdict: 'HUMAN_REVIEW',
  penalty: 12,
  segments: segments(
    ['Industriepumpen für die Prozessindustrie', 'Unsere Pumpen fördern 450 m³/h bei 16 bar.', 'Lieferung innerhalb von 5 Werktagen.', 'Pumpen | Beispiel AG'],
    [
      { judge: flat(85) },
      { judge: flat(80), findings: [{ id: 'f-b1', severity: 'critical', rule: 'INTEGRITY-ENTITY' }] },
      { judge: flat(84), findings: [{ id: 'f-b2', severity: 'major', status: 'fixed' }] },
      { judge: flat(86), findings: [{ id: 'f-b3', severity: 'major', status: 'accepted' }] },
    ],
  ),
};
const bravoEn: FixtureLocale = {
  locale: 'en-GB',
  score: 92.5,
  verdict: 'PASS_WITH_NOTES',
  penalty: 7.5,
  segments: segments(
    ['Industrial pumps for the process industry', 'Our pumps provide 450 m³/h at 16 bar.', 'Delivery within 5 working days.', 'Pumps | Example Ltd'],
    [{ judge: flat(88) }, { judge: flat(88) }, { judge: flat(88), findings: [{ id: 'f-b4', severity: 'minor' }] }, { judge: flat(88) }],
  ),
};
const charlieDe: FixtureLocale = {
  locale: 'de-CH',
  score: 97,
  verdict: 'PASS',
  penalty: 3,
  segments: segments(
    ['Industrielle Pumpen für die Prozessindustrie', 'Unsere Pumpen liefern 450 m³/h bei 16 bar.', null, 'Pumpen | Beispiel AG'],
    [{ judge: flat(92) }, { judge: flat(92), findings: [{ id: 'f-c1', severity: 'major' }] }, {}, { judge: flat(92) }],
  ),
};
const charlieEn: FixtureLocale = {
  locale: 'en-GB',
  score: 70,
  verdict: 'FAIL',
  penalty: 30,
  segments: segments(
    ['Industrial pumps for process industries', 'Our pumps deliver 450 m³/h at 16 bar.', 'Delivery in 5 working days.', 'Pumps | Example Ltd'],
    [{}, { findings: [{ id: 'f-c2', severity: 'major' }] }, { findings: [{ id: 'f-c3', severity: 'major' }] }, { findings: [{ id: 'f-c4', severity: 'minor' }] }],
  ),
};

/** One RunReport per candidate ref, as `runPipeline` would return them. */
export function scenarioRuns(): Record<string, RunReport> {
  return {
    [ALPHA]: buildRunReport({
      runId: 'run-alpha',
      locales: [alphaDe, alphaEn],
      routing: routing(ALPHA),
      calls: [
        call('translation', 0.003, 1200, { input: 400, output: 300 }),
        call('translation', 0.004, 1500, { input: 500, output: 350 }),
        call('localization', 0.002, 900),
        call('localization', 0.002, 1000),
        call('repair', 0.001, 600),
        ...times(3, call('validation', 0.0005, 700)),
        ...times(2, call('backtranslation', 0.0003, 500)),
        call('language_detection', 0.0001, 200, { provider: 'anthropic' }),
      ],
    }),
    [BRAVO]: buildRunReport({
      runId: 'run-bravo',
      locales: [bravoDe, bravoEn],
      routing: routing(BRAVO),
      calls: [
        call('translation', 0.001, 800),
        call('translation', 0.0012, 900),
        call('localization', 0.0008, 600),
        call('localization', 0.0009, 650),
        ...times(3, call('validation', 0.0005, 700)),
        ...times(2, call('backtranslation', 0.0003, 500)),
        call('language_detection', 0.0001, 200, { provider: 'anthropic' }),
      ],
    }),
    [CHARLIE]: buildRunReport({
      runId: 'run-charlie',
      locales: [charlieDe, charlieEn],
      routing: routing(CHARLIE),
      calls: [
        call('translation', null, 1000),
        call('translation', 0.0015, 1100),
        call('localization', 0.0006, 700),
        ...times(2, call('validation', 0.0005, 700)),
        call('backtranslation', 0.0003, 500),
        call('language_detection', 0.0001, 200, { provider: 'anthropic' }),
      ],
    }),
  };
}

export interface DepsOptions {
  /** Report (or error to throw) per candidate ref; default `scenarioRuns()`. */
  reports?: Record<string, RunReport | Error>;
  defaultJudge?: string;
  outputRoot?: string;
  now?: Date;
  /** Each runPipeline call waits this long, so overlapping calls would show up in `events`. */
  delayMs?: number;
}

export interface FakeDeps {
  deps: CompareDeps;
  /** Every request handed to `runPipeline`, in call order. */
  requests: PipelineRequest[];
  /** `start:<ref>` / `end:<ref>` in the order they happened. */
  events: string[];
  /** Highest number of `runPipeline` calls that were in flight at the same time. */
  peak: () => number;
}

export function makeDeps(opts: DepsOptions = {}): FakeDeps {
  const reports = opts.reports ?? scenarioRuns();
  const requests: PipelineRequest[] = [];
  const events: string[] = [];
  let active = 0;
  let peak = 0;
  const deps: CompareDeps = {
    // The harness never reads the configuration; the contract only carries it for the engine.
    config: {} as unknown as LoadedConfig,
    async runPipeline(req) {
      requests.push(req);
      const ref = req.options.providers?.translation ?? '(none)';
      events.push(`start:${ref}`);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 0));
      active -= 1;
      events.push(`end:${ref}`);
      const result = Object.hasOwn(reports, ref) ? reports[ref] : undefined;
      if (result === undefined) throw new Error(`no fixture report for ${ref}`);
      if (result instanceof Error) throw result;
      return result;
    },
    now: () => opts.now ?? NOW,
    describeProvider(ref) {
      if (!Object.hasOwn(BINDINGS, ref)) throw new Error(`unknown provider "${ref}"`);
      return { ...(BINDINGS[ref] as StageBinding) };
    },
    defaultJudgeRef: () => opts.defaultJudge ?? JUDGE,
    outputRoot: opts.outputRoot ?? path.join(os.tmpdir(), 'locale-engine-compare-unused'),
  };
  return { deps, requests, events, peak: () => peak };
}

/** A schema-valid compare request for the scenario (no outputs written unless a test asks for them). */
export function compareRequest(overrides: Partial<CompareRequest> = {}): CompareRequest {
  return CompareRequestSchema.parse({
    input: { kind: 'text', text: 'Onze pompen leveren 450 m³/h bij 16 bar.', format: 'text' },
    targets: ['de-CH', 'en-GB'],
    providers: [ALPHA, BRAVO, CHARLIE],
    options: { write_outputs: false },
    ...overrides,
  });
}
