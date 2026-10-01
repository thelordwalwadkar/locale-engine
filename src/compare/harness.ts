/**
 * The model comparison harness (spec §2, Phase 8): the same input through several candidate providers, scored by ONE fixed judge
 * so the scores are comparable (ARCHITECTURE P4). It never imports the pipeline or the providers; everything arrives through `CompareDeps`.
 */
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  SCHEMA_VERSION,
  type CompareReport,
  type CompareRequest,
  type LocaleCode,
  type PipelineOptions,
  type PipelineRequest,
  type RunReport,
  type UsageTotals,
} from '../schemas/index.js';
import { EngineError, errorMessage, type EngineErrorCode } from '../util/errors.js';
import { round } from '../util/text.js';
import {
  costNotes,
  emptyRunNote,
  failedNote,
  independenceNotes,
  missingOutputNotes,
  notValidatedNotes,
  routingNotes,
  runStatusNotes,
  sourceNotes,
  targetsNotes,
  type ResolvedProvider,
} from './notes.js';
import { buildCostRows, buildFindingRows, buildScoreRows, buildSegmentDiff, type CandidateRun } from './rows.js';
import type { CompareDeps } from './types.js';
import { writeComparisonArtifacts } from './write.js';

interface Plan {
  candidates: ResolvedProvider[];
  judge: ResolvedProvider;
}

/**
 * Resolves the judge and every candidate before anything is spent. All problems are reported together. A failure that `describeProvider`
 * raises as an EngineError keeps its code when every failure agrees (e.g. PROVIDER_UNAVAILABLE for a provider without credentials);
 * anything else is INPUT_INVALID.
 */
function resolveProviders(req: CompareRequest, deps: CompareDeps): Plan {
  const problems: Array<{ message: string; code: EngineErrorCode }> = [];
  const refs = req.providers;
  if (refs.length < 2) problems.push({ message: `a comparison needs at least two providers, got ${refs.length}`, code: 'INPUT_INVALID' });
  const duplicates = [...new Set(refs.filter((ref, i) => refs.indexOf(ref) !== i))];
  if (duplicates.length > 0) problems.push({ message: `duplicate providers: ${duplicates.join(', ')}`, code: 'INPUT_INVALID' });

  const resolve = (ref: string, role: string): ResolvedProvider | undefined => {
    try {
      return { ref, binding: deps.describeProvider(ref) };
    } catch (e) {
      problems.push({ message: `${role} "${ref}" cannot be used: ${errorMessage(e)}`, code: e instanceof EngineError ? e.code : 'INPUT_INVALID' });
      return undefined;
    }
  };
  const judge = resolve(req.judge_provider ?? deps.defaultJudgeRef(), 'judge provider');
  const candidates = refs.flatMap((ref) => {
    const resolved = resolve(ref, 'provider');
    return resolved ? [resolved] : [];
  });

  if (!judge || problems.length > 0) {
    const first = problems[0]?.code ?? 'INPUT_INVALID';
    const code = problems.every((p) => p.code === first) ? first : 'INPUT_INVALID';
    const messages = problems.map((p) => p.message);
    throw new EngineError(code, `Cannot start the comparison: ${messages.join('; ')}`, { problems: messages });
  }
  return { candidates, judge };
}

/**
 * The pipeline request for one candidate: translation / localization / repair go to the candidate, validation / backtranslation to the
 * fixed judge. `language_detection` is not compared, so a caller's override of it is kept for every run.
 */
function candidateRequest(req: CompareRequest, candidateRef: string, judgeRef: string): PipelineRequest {
  const detection = req.options.providers?.language_detection;
  const options: PipelineOptions = {
    ...req.options,
    providers: {
      ...(detection ? { language_detection: detection } : {}),
      translation: candidateRef,
      localization: candidateRef,
      repair: candidateRef,
      validation: judgeRef,
      backtranslation: judgeRef,
    },
    write_outputs: false,
  };
  // `output_dir` is the comparison's folder and one `run_id` for every candidate would make the runs indistinguishable.
  delete options.output_dir;
  delete options.run_id;
  return { input: req.input, targets: req.targets, options };
}

/** `cmp_<YYYYMMDDTHHMMSSZ>_<4 hex>`. */
function newCompareId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '');
  return `cmp_${stamp}_${randomBytes(2).toString('hex')}`;
}

/** Locales every successful run produced, in the first run's order. */
function commonTargets(runs: readonly CandidateRun[]): LocaleCode[] {
  const [first, ...rest] = runs;
  if (!first) return [];
  const others = rest.map(({ report }) => new Set(report.locales.map((l) => l.target_locale)));
  const firstLocales = [...new Set(first.report.locales.map((l) => l.target_locale))];
  return firstLocales.filter((locale) => others.every((produced) => produced.has(locale)));
}

function sumTotals(list: readonly UsageTotals[]): UsageTotals {
  const total: UsageTotals = { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unpriced_calls: 0, latency_ms: 0 };
  for (const u of list) {
    total.calls += u.calls;
    total.input_tokens += u.input_tokens;
    total.output_tokens += u.output_tokens;
    total.cost_usd += u.cost_usd;
    total.unpriced_calls += u.unpriced_calls;
    total.latency_ms += u.latency_ms;
  }
  return { ...total, cost_usd: round(total.cost_usd, 6), latency_ms: round(total.latency_ms, 3) };
}

async function ensureOutputDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    throw new EngineError('INPUT_INVALID', `Cannot create the output directory ${dir}: ${errorMessage(e)}`, { dir }, e);
  }
}

/**
 * Runs the candidates one after the other (predictable cost, readable logs), each with the same judge, and builds the side-by-side
 * report. A candidate that throws is noted and left out; the comparison fails only when no candidate produced anything.
 */
export async function runComparison(req: CompareRequest, deps: CompareDeps): Promise<CompareReport> {
  const { candidates, judge } = resolveProviders(req, deps);
  const now = deps.now();
  const compareId = newCompareId(now);
  const writeOutputs = req.options.write_outputs !== false;
  const outDir = req.options.output_dir ?? path.join(deps.outputRoot, compareId);
  // Fail before spending money rather than after.
  if (writeOutputs) await ensureOutputDir(outDir);

  const notes: string[] = candidates.flatMap((candidate) => independenceNotes(candidate, judge));
  const runs: CandidateRun[] = [];
  for (const candidate of candidates) {
    let report: RunReport;
    try {
      report = await deps.runPipeline(candidateRequest(req, candidate.ref, judge.ref));
    } catch (e) {
      notes.push(failedNote(candidate.ref, e));
      continue;
    }
    if (report.locales.length === 0) {
      notes.push(emptyRunNote(candidate.ref, report));
      continue;
    }
    runs.push({ ref: candidate.ref, report });
    notes.push(...runStatusNotes(candidate.ref, report), ...routingNotes(candidate, judge, report));
  }
  const first = runs[0];
  if (!first) {
    const failures = notes.filter((note) => note.startsWith('CANDIDATE_FAILED:'));
    throw new EngineError('INTERNAL', `No candidate produced a result, so there is nothing to compare. ${failures.join(' | ')}`, { failures });
  }

  const targets = commonTargets(runs);
  const segmentDiff = buildSegmentDiff(runs, targets);
  notes.push(
    ...sourceNotes(runs),
    ...targetsNotes(runs, targets),
    ...notValidatedNotes(runs, targets),
    ...costNotes(runs, judge),
    ...missingOutputNotes(segmentDiff),
  );

  const report: CompareReport = {
    schema_version: SCHEMA_VERSION,
    compare_id: compareId,
    created_at: now.toISOString(),
    source: first.report.source,
    targets,
    providers: runs.map((r) => r.ref),
    judge: judge.binding,
    scores: buildScoreRows(runs, targets),
    findings: buildFindingRows(runs, targets),
    cost_latency: buildCostRows(runs, judge.ref),
    segment_diff: segmentDiff,
    runs: Object.fromEntries(runs.map((r) => [r.ref, r.report.run_id])),
    totals: sumTotals(runs.map((r) => r.report.totals)),
    output_dir: null,
    artifacts: [],
    notes,
  };

  if (writeOutputs) {
    report.artifacts = await writeComparisonArtifacts(report, outDir);
    report.output_dir = path.resolve(outDir);
  }
  return report;
}
