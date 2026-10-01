/**
 * Run orchestration (spec §7 Phase 5): ingest → detect → targets → locales in parallel → report → artifacts.
 * One code path serves `run`, `translate`, `localize` and `validate`; they differ only in which stages are switched on and where the
 * source comes from. Partial failure never discards work: a crashed locale becomes a FAIL locale, a halted run still exports what exists.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { secretValues } from '../config/env.js';
import { writeRunArtifacts } from '../export/index.js';
import { SCHEMA_VERSION } from '../schemas/report.js';
import type {
  LocaleCode,
  LocaleResult,
  PipelineOptions,
  PipelineRequest,
  ProviderRegistry,
  RunReport,
  SourceDocument,
  SourceSummary,
  Stage,
  StageBinding,
  ValidateRequest,
} from '../schemas/index.js';
import { ProviderError } from '../schemas/provider.js';
import { CostTracker, totalsOf } from '../telemetry/cost.js';
import { RunLog } from '../telemetry/run-log.js';
import { mapLimitSettled } from '../util/concurrency.js';
import { EngineError, errorMessage } from '../util/errors.js';
import { wordCount } from '../util/text.js';
import { toolVersion } from '../util/paths.js';
import { failedLocaleResult, processLocale } from './locale-run.js';
import type { LocaleRunOptions } from './locale-run.js';
import { createPromptKit } from './prompt.js';
import { resolveTargets } from './route.js';
import { scoringSettings } from './scoring.js';
import { documentFromPage, documentFromPair, loadSource, readPageJson } from './source.js';
import type { SourceDeps } from './source.js';
import { StageRunner } from './stage-runner.js';
import type { RunContext, RunSettings, StageSwitches } from './state.js';
import type { RegistryFactoryArgs } from './types.js';

export interface OrchestratorDeps extends SourceDeps {
  registryFactory: (args: RegistryFactoryArgs) => ProviderRegistry | Promise<ProviderRegistry>;
  now: () => Date;
  outputRoot: string;
}

export type RunMode = 'pipeline' | 'translate' | 'localize' | 'validate';

interface Loaded {
  doc: SourceDocument;
  /** Fixed targets (page.json / pair inputs); otherwise the request's targets are resolved against the matrix. */
  targets?: LocaleCode[];
  localeOptions?: (target: LocaleCode) => LocaleRunOptions;
}

interface Plan {
  mode: RunMode;
  switches: StageSwitches;
  options: PipelineOptions;
  requestedTargets: 'all' | readonly string[];
  prepare: (run: RunContext) => Promise<Loaded>;
}

export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

export function makeRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `run_${stamp}_${randomBytes(2).toString('hex')}`;
}

function switchesFor(mode: RunMode, o: PipelineOptions): StageSwitches {
  const backtranslate = o.backtranslate ?? true;
  switch (mode) {
    case 'translate':
      return { translate: true, localize: false, validate: false, repair: false, backtranslate: false };
    case 'localize':
      return { translate: true, localize: true, validate: false, repair: false, backtranslate: false };
    case 'validate':
      return { translate: false, localize: false, validate: true, repair: o.repair ?? false, backtranslate };
    case 'pipeline':
      return { translate: true, localize: true, validate: true, repair: o.repair ?? true, backtranslate };
  }
}

function envNumber(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function summarise(doc: SourceDocument): SourceSummary {
  const languages: Record<string, number> = {};
  for (const s of doc.segments) {
    const l = s.lang?.lang && s.lang.lang !== 'und' ? s.lang.lang : doc.source_language;
    languages[l] = (languages[l] ?? 0) + 1;
  }
  return {
    doc_id: doc.doc_id,
    origin_kind: doc.origin.kind,
    origin_ref: doc.origin.ref,
    source_locale: doc.source_locale,
    source_language: doc.source_language,
    page_type: doc.page_type,
    page_type_evidence: doc.page_type_evidence,
    segments: doc.segments.length,
    words: doc.segments.reduce((n, s) => n + wordCount(s.text), 0),
    languages,
  };
}

function neededStages(sw: StageSwitches): Stage[] {
  const out: Stage[] = [];
  if (sw.translate) out.push('translation');
  if (sw.localize) out.push('localization');
  if (sw.validate) {
    out.push('validation');
    if (sw.backtranslate) out.push('backtranslation');
    if (sw.repair) out.push('repair');
  }
  return out;
}

async function runCore(deps: OrchestratorDeps, plan: Plan): Promise<RunReport> {
  const { config } = deps;
  const started = deps.now();
  const { options } = plan;
  if (options.run_id !== undefined && !RUN_ID_RE.test(options.run_id)) {
    throw new EngineError('INPUT_INVALID', `run_id "${options.run_id}" may contain only letters, digits, "_", "." and "-" (max 80 characters)`);
  }
  const runId = options.run_id ?? makeRunId(started);
  const log = new RunLog(deps.now, secretValues(deps.env));
  const settings: RunSettings = {
    passThreshold: options.pass_threshold ?? config.stages.thresholds.pass,
    maxRepairLoops: options.max_repair_loops ?? config.stages.thresholds.max_repair_loops,
    stages: plan.switches,
  };
  const ceiling = options.cost_ceiling_usd ?? envNumber(deps.env['LOCALE_COST_CEILING_USD']) ?? config.stages.cost.ceiling_usd;
  const costs = new CostTracker(ceiling);
  log.info({ code: 'RUN_START', message: `${plan.mode} run ${runId}`, data: { pass_threshold: settings.passThreshold, max_repair_loops: settings.maxRepairLoops, cost_ceiling_usd: ceiling } });

  const registry = await deps.registryFactory({ config, ...(options.providers ? { overrides: options.providers } : {}), env: deps.env });
  for (const stage of neededStages(plan.switches)) {
    try {
      registry.forStage(stage);
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'NO_CREDENTIALS') throw new EngineError('PROVIDER_UNAVAILABLE', `no usable provider for the ${stage} stage: ${e.message}`);
      throw e;
    }
  }
  let notesLogged = 0;
  const flushNotes = (): void => {
    for (const n of registry.notes.slice(notesLogged)) {
      log.warn({ code: n.code, message: n.message, ...(n.stage ? { stage: n.stage } : {}) });
    }
    notesLogged = registry.notes.length;
  };
  flushNotes();

  const run: RunContext = {
    config,
    settings,
    kit: createPromptKit(config),
    runner: new StageRunner({ registry, stages: config.stages, costs, log, now: deps.now }),
    log,
    costs,
    scoring: scoringSettings(config.stages, settings.passThreshold),
  };

  const loaded = await plan.prepare(run);
  const { doc } = loaded;
  const targets = resolveTargets(loaded.targets ?? plan.requestedTargets, doc.source_language, config.stages);
  log.info({ code: 'SOURCE', message: `${doc.origin.kind} ${doc.origin.ref}: ${doc.segments.length} segment(s), ${doc.source_locale}, page type ${doc.page_type}`, data: { page_type_evidence: doc.page_type_evidence, targets } });
  for (const w of doc.warnings) log.warn({ code: 'INGEST_WARNING', message: w });
  if (!doc.segments.length) throw new EngineError('INPUT_INVALID', 'the input contains no segments to process');

  const settled = await mapLimitSettled(targets, config.stages.concurrency.locales, async (target) => {
    try {
      return await processLocale(run, target, doc, loaded.localeOptions?.(target) ?? {});
    } catch (e) {
      log.error({ code: 'LOCALE_FAILED', message: `${target}: ${errorMessage(e)}`, locale: target });
      return { result: failedLocaleResult(run, target, doc, errorMessage(e)), halted: false, crashed: true as const };
    }
  });
  const outcomes = settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : { result: failedLocaleResult(run, targets[i] as LocaleCode, doc, errorMessage(s.reason)), halted: false, crashed: true as const },
  );
  flushNotes();

  const halted = outcomes.some((o) => o.halted);
  const crashed = outcomes.some((o) => 'crashed' in o);
  if (halted) log.warn({ code: 'COST_CEILING', message: `cost ceiling of $${ceiling.toFixed(2)} reached; the run was halted and the report covers what was finished` });
  const unpriced = costs.calls().filter((c) => c.ok && c.cost_usd === null).length;
  if (unpriced) log.warn({ code: 'PRICING_UNKNOWN', message: `${unpriced} call(s) had no pricing; the cost ceiling cannot account for them` });

  const locales: LocaleResult[] = outcomes.map((o) => o.result);
  const routing: Partial<Record<Stage, StageBinding>> = {};
  for (const c of costs.calls().filter((x) => x.ok)) routing[c.stage] = { provider: c.provider, model: c.model };

  const finished = deps.now();
  log.info({ code: 'RUN_END', message: `${plan.mode} run ${runId} finished: ${locales.map((l) => `${l.target_locale} ${l.verdict}`).join(', ')}` });
  const report: RunReport = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    tool_version: toolVersion(),
    status: halted ? 'HALTED_COST_CEILING' : crashed ? 'PARTIAL' : 'COMPLETE',
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    duration_ms: finished.getTime() - started.getTime(),
    source: summarise(doc),
    options: {
      targets,
      pass_threshold: settings.passThreshold,
      max_repair_loops: settings.maxRepairLoops,
      cost_ceiling_usd: ceiling,
      stages: plan.switches,
    },
    routing,
    locales,
    totals: totalsOf(costs.calls()),
    calls: costs.calls(),
    run_log: log.entries(),
    output_dir: null,
    artifacts: [],
  };

  if (options.write_outputs ?? true) {
    const dir = options.output_dir ? path.resolve(options.output_dir) : path.join(deps.outputRoot, runId);
    try {
      report.artifacts = await writeRunArtifacts({ ...report, output_dir: dir }, dir);
      report.output_dir = dir;
    } catch (e) {
      log.error({ code: 'OUTPUT_WRITE_FAILED', message: `could not write the deliverables to ${dir}: ${errorMessage(e)}` });
      report.run_log = log.entries();
    }
  }
  return report;
}

/** `run`, `translate` and `localize`: content (URL / file / text) — or, for `localize`, the page.json of an earlier `translate` run. */
export async function runContent(deps: OrchestratorDeps, mode: 'pipeline' | 'translate' | 'localize', req: PipelineRequest): Promise<RunReport> {
  return runCore(deps, {
    mode,
    switches: switchesFor(mode, req.options),
    options: req.options,
    requestedTargets: req.targets,
    prepare: async (run) => {
      const spec = req.input;
      if (spec.kind !== 'page_json') return { doc: await loadSource(spec, run, deps, req.options) };
      if (mode !== 'localize') throw new EngineError('INPUT_INVALID', `a page_json input is only supported by localize and validate, not by ${mode}`);
      const page = await readPageJson(spec);
      const target = page.locale.target_locale;
      if (req.targets !== 'all' && !(req.targets.length === 1 && req.targets[0] === target)) {
        throw new EngineError('INPUT_INVALID', `this page.json holds the ${target} translation; request targets "all" or [${target}]`);
      }
      const prior = new Map(page.locale.segments.map((r) => [r.segment_id, { translation: r.translation ?? r.final_text }]));
      return { doc: documentFromPage(page, deps.config), targets: [target], localeOptions: () => ({ prior }) };
    },
  });
}

/** `validate`: a page.json from an earlier run, or one source/target pair. */
export async function runValidation(deps: OrchestratorDeps, req: ValidateRequest): Promise<RunReport> {
  return runCore(deps, {
    mode: 'validate',
    switches: switchesFor('validate', req.options),
    options: req.options,
    requestedTargets: 'all',
    prepare: async () => {
      const input = req.input;
      if (input.kind === 'page_json') {
        const page = await readPageJson(input);
        const existing = new Map(
          page.locale.segments.map((r) => [
            r.segment_id,
            { text: r.final_text, translation: r.translation, localized: r.localized_text, changes: r.changes, formatChanges: r.format_changes, status: r.status },
          ]),
        );
        return { doc: documentFromPage(page, deps.config), targets: [page.locale.target_locale], localeOptions: () => ({ existing, skipPostProcess: true }) };
      }
      const doc = documentFromPair(input, deps.config);
      const seg = doc.segments[0];
      const existing = new Map(
        seg ? [[seg.segment_id, { text: input.target_text, translation: input.target_text, localized: input.target_text, changes: [], formatChanges: [], status: 'OK' as const }]] : [],
      );
      return { doc, targets: [input.target_locale], localeOptions: () => ({ existing, skipPostProcess: true }) };
    },
  });
}

