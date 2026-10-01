/**
 * Diagnostics attached to a CompareReport. A comparison drives a model-selection decision, so anything that makes the numbers less
 * comparable than they look is said out loud. Every note starts with a stable `CODE:` so clients can filter on it.
 */
import type { LocaleCode, RunReport, RunStatus, Stage, StageBinding } from '../schemas/index.js';
import { errorMessage } from '../util/errors.js';
import { round } from '../util/text.js';
import {
  CANDIDATE_STAGES,
  JUDGE_STAGES,
  collectCostBuckets,
  countMissingOutputs,
  isNotValidated,
  type CandidateRun,
  type CompareSegmentDiffRow,
} from './rows.js';

/** A provider ref together with what `describeProvider` says would serve it. */
export interface ResolvedProvider {
  ref: string;
  binding: StageBinding;
}

const usd = (amount: number): string => `$${amount.toFixed(6)}`;
const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0);

export function failedNote(ref: string, cause: unknown): string {
  return `CANDIDATE_FAILED: ${ref}: ${errorMessage(cause)}`;
}

/** A run that returned a report without any locale has nothing to compare; its spend is still said out loud. */
export function emptyRunNote(ref: string, report: RunReport): string {
  return `CANDIDATE_FAILED: ${ref}: run ${report.run_id} produced no locale results (status ${report.status}); its usage of ${usd(report.totals.cost_usd)} is not part of the totals`;
}

/** P4 (judge independence) is about the vendor: a sibling model of the judge's own provider still favours its own family. */
export function independenceNotes(candidate: ResolvedProvider, judge: ResolvedProvider): string[] {
  if (candidate.binding.provider !== judge.binding.provider) return [];
  if (candidate.binding.model === judge.binding.model) return [`JUDGE_NOT_INDEPENDENT: candidate ${candidate.ref} is also the judge`];
  return [`JUDGE_NOT_INDEPENDENT: candidate ${candidate.ref} shares provider ${judge.binding.provider} with the judge ${judge.ref}`];
}

const INCOMPLETE_CONSEQUENCE: Record<Exclude<RunStatus, 'COMPLETE'>, string> = {
  HALTED_COST_CEILING: 'the run stopped at the cost ceiling; segments it did not reach have no output, so its scores and cost cover only part of the input',
  PARTIAL: 'some results are missing, so its scores and cost may cover only part of the input',
  FAILED: 'only what the run produced before it failed is shown',
};

export function runStatusNotes(ref: string, report: RunReport): string[] {
  if (report.status === 'COMPLETE') return [];
  return [`CANDIDATE_INCOMPLETE: ${ref}: run ${report.run_id} ended ${report.status}; ${INCOMPLETE_CONSEQUENCE[report.status]}`];
}

/**
 * A missing credential makes the registry fall back to the default provider (P6), which would silently score that provider under the
 * candidate's name. The run's `routing` records what really served each stage; any difference from what was requested is reported.
 */
export function routingNotes(candidate: ResolvedProvider, judge: ResolvedProvider, report: RunReport): string[] {
  const mismatches: string[] = [];
  const check = (stage: Stage, expected: ResolvedProvider): void => {
    const actual = report.routing[stage];
    if (actual && (actual.provider !== expected.binding.provider || actual.model !== expected.binding.model)) {
      mismatches.push(`${stage} served by ${actual.provider}/${actual.model} instead of ${expected.binding.provider}/${expected.binding.model}`);
    }
  };
  for (const stage of CANDIDATE_STAGES) check(stage, candidate);
  for (const stage of JUDGE_STAGES) check(stage, judge);
  if (mismatches.length === 0) return [];
  return [`ROUTING_MISMATCH: ${candidate.ref}: ${mismatches.join('; ')}; the requested provider did not do all of this work (provider fallback?)`];
}

/** Each candidate run ingests the input itself (a live URL can change between runs); compare the first run's source with the others'. */
export function sourceNotes(runs: readonly CandidateRun[]): string[] {
  const [first, ...rest] = runs;
  if (!first) return [];
  const fields = ['segments', 'words', 'source_locale', 'page_type'] as const;
  return rest.flatMap(({ ref, report }) => {
    const differing = fields.filter((field) => report.source[field] !== first.report.source[field]);
    if (differing.length === 0) return [];
    const detail = differing.map((field) => `${field} ${String(report.source[field])} vs ${String(first.report.source[field])}`).join(', ');
    return [`SOURCE_DIFFERS: ${ref} ingested a different source than ${first.ref} (${detail}); the scores may not be comparable`];
  });
}

/** `targets` is the intersection of what every run produced; say so when some run produced more. */
export function targetsNotes(runs: readonly CandidateRun[], targets: readonly LocaleCode[]): string[] {
  const produced = runs.map(({ ref, report }) => ({ ref, locales: [...new Set(report.locales.map((l) => l.target_locale))] }));
  if (produced.every((p) => p.locales.length === targets.length)) return [];
  const list = produced.map((p) => `${p.ref}: ${p.locales.join(', ')}`).join('; ');
  return [`TARGETS_DIFFER: the candidates produced different locales (${list}); the tables cover only the locales all of them produced (${targets.join(', ') || 'none'})`];
}

/** Judge cost is one shared bill for all candidates; unpriced calls make a cost a lower bound rather than a total. */
export function costNotes(runs: readonly CandidateRun[], judge: ResolvedProvider): string[] {
  const buckets = collectCostBuckets(runs, judge.ref);
  const notes: string[] = [];

  const judged = buckets.filter((b) => b.role === 'judge');
  const judgeCalls = sum(judged.map((b) => b.calls));
  if (judgeCalls > 0) {
    notes.push(
      `JUDGE_COST_SHARED: judge ${judge.ref} (${judge.binding.provider}/${judge.binding.model}) scored every candidate: ${judgeCalls} calls, ` +
        `${usd(round(sum(judged.map((b) => b.cost_usd)), 6))}. They are listed with role judge and are not part of any candidate's total`,
    );
  }

  const groups = new Map<string, { provider: string; role: string; calls: number; unpriced: number }>();
  for (const b of buckets) {
    const key = JSON.stringify([b.provider, b.role]);
    const group = groups.get(key) ?? { provider: b.provider, role: b.role, calls: 0, unpriced: 0 };
    group.calls += b.calls;
    group.unpriced += b.unpriced_calls;
    groups.set(key, group);
  }
  for (const g of groups.values()) {
    if (g.unpriced > 0) {
      notes.push(`PRICING_UNKNOWN: ${g.provider} (${g.role}): ${g.unpriced} of ${g.calls} calls have no pricing, so its cost counts the priced calls only`);
    }
  }
  return notes;
}

/** A locale the run did not validate has a meaningless score and no findings; it must not be read as a clean result. */
export function notValidatedNotes(runs: readonly CandidateRun[], targets: readonly LocaleCode[]): string[] {
  return runs.flatMap(({ ref, report }) =>
    report.locales
      .filter((locale) => targets.includes(locale.target_locale) && isNotValidated(locale))
      .map((locale) => `LOCALE_NOT_VALIDATED: ${ref} / ${locale.target_locale}: the run did not validate this locale, so its score, findings and judge averages are not comparable`),
  );
}

export function missingOutputNotes(diff: readonly CompareSegmentDiffRow[]): string[] {
  return countMissingOutputs(diff)
    .filter((c) => c.missing > 0)
    .map(
      (c) =>
        `SEGMENTS_WITHOUT_OUTPUT: ${c.provider} / ${c.locale}: ${c.missing} of ${c.total} segments have no output (PROVIDER_ERROR or NOT_PROCESSED); read its score against the segment list`,
    );
}
