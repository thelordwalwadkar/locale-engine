import { describe, expect, it } from 'vitest';
import { bestProviderPerLocale, buildCostRows, buildScoreRows, buildSegmentDiff, type CandidateRun } from '../src/compare/index.js';
import { buildFindingRows, collectCostBuckets, costRole, countMissingOutputs } from '../src/compare/rows.js';
import type { RunReport, Stage } from '../src/schemas/index.js';
import { buildRunReport } from './fixtures/compare/run-report.js';
import { ALPHA, BRAVO, CHARLIE, JUDGE, scenarioRuns } from './fixtures/compare/scenario.js';

const scenario = scenarioRuns();
const runs: CandidateRun[] = [ALPHA, BRAVO, CHARLIE].map((ref) => ({ ref, report: scenario[ref] as RunReport }));
const both = ['de-CH', 'en-GB'] as const;

function row<T extends { provider: string; locale: string }>(rows: T[], provider: string, locale: string): T {
  const found = rows.find((r) => r.provider === provider && r.locale === locale);
  if (!found) throw new Error(`no row for ${provider} / ${locale}`);
  return found;
}

describe('buildScoreRows', () => {
  it('yields one row per provider and locale, provider by provider', () => {
    const rows = buildScoreRows(runs, both);
    expect(rows.map((r) => `${r.provider}|${r.locale}`)).toEqual([
      'anthropic|de-CH',
      'anthropic|en-GB',
      'openai:gpt-mini|de-CH',
      'openai:gpt-mini|en-GB',
      'google|de-CH',
      'google|en-GB',
    ]);
  });

  it('takes score, verdict and penalty from the locale result without rounding them', () => {
    const rows = buildScoreRows(runs, both);
    expect(row(rows, ALPHA, 'de-CH')).toMatchObject({ quality_score: 96, verdict: 'PASS', penalty: 4 });
    expect(row(rows, BRAVO, 'de-CH')).toMatchObject({ quality_score: 88, verdict: 'HUMAN_REVIEW', penalty: 12 });
    expect(row(rows, CHARLIE, 'en-GB')).toMatchObject({ quality_score: 70, verdict: 'FAIL', penalty: 30 });

    const odd = buildRunReport({
      runId: 'r',
      locales: [{ locale: 'de-CH', score: 94.3333, verdict: 'PASS', penalty: 5.6667, segments: [{ id: 's', source: 'x', final: 'y' }] }],
    });
    expect(buildScoreRows([{ ref: 'odd', report: odd }], ['de-CH'])[0]).toMatchObject({ quality_score: 94.3333, penalty: 5.6667 });
  });

  it('counts OPEN findings only, document-level ones included', () => {
    const rows = buildScoreRows(runs, both);
    // alpha de-CH: one minor fixed (excluded), one minor open in a segment, one minor open at document level.
    expect(row(rows, ALPHA, 'de-CH')).toMatchObject({ findings_minor: 2, findings_major: 0, findings_critical: 0 });
    // bravo de-CH: one critical open; a major that was fixed and a major that was accepted do not count.
    expect(row(rows, BRAVO, 'de-CH')).toMatchObject({ findings_minor: 0, findings_major: 0, findings_critical: 1 });
    expect(row(rows, CHARLIE, 'en-GB')).toMatchObject({ findings_minor: 1, findings_major: 2, findings_critical: 0 });
    expect(row(rows, ALPHA, 'en-GB')).toMatchObject({ findings_minor: 0, findings_major: 0, findings_critical: 0 });
  });

  it('averages each judge dimension over the segments the judge scored, rounded to one decimal', () => {
    const rows = buildScoreRows(runs, both);
    // alpha de-CH: three scored segments (the fourth has no judge block): 95/91/94, 94/90/92, 93/89/91, 92/88/87, 91/87/88.
    expect(row(rows, ALPHA, 'de-CH').judge_avg).toEqual({ accuracy: 93.3, fluency: 92, terminology: 91, locale_conventions: 89, style_brand: 88.7 });
    // bravo de-CH: four scored segments, 85/80/84/86 -> 83.75 -> 83.8.
    expect(row(rows, BRAVO, 'de-CH').judge_avg).toEqual({ accuracy: 83.8, fluency: 83.8, terminology: 83.8, locale_conventions: 83.8, style_brand: 83.8 });
  });

  it('gives a null judge_avg when the judge scored nothing', () => {
    expect(row(buildScoreRows(runs, both), CHARLIE, 'en-GB').judge_avg).toBeNull();
  });

  it('gives a null judge_avg for a locale the run did not validate, even if a judge block is present', () => {
    const report = buildRunReport({
      runId: 'r',
      locales: [
        {
          locale: 'de-CH',
          score: 100,
          verdict: 'HUMAN_REVIEW',
          reasons: ['NOT_VALIDATED: translate-only run [EVIDENCE: run-options]'],
          segments: [{ id: 's', source: 'x', final: 'y', judge: { accuracy: 90, fluency: 90, terminology: 90, locale_conventions: 90, style_brand: 90 } }],
        },
      ],
    });
    expect(buildScoreRows([{ ref: 'x', report }], ['de-CH'])[0]?.judge_avg).toBeNull();
  });

  it('skips locales a run did not produce', () => {
    const rows = buildScoreRows(runs, ['de-CH', 'it-IT']);
    expect(rows.map((r) => r.locale)).toEqual(['de-CH', 'de-CH', 'de-CH']);
  });
});

describe('buildFindingRows', () => {
  it('tags every finding of every status with its provider: segment findings first, document findings last', () => {
    const rows = buildFindingRows(runs, both).filter((r) => r.provider === ALPHA && r.locale === 'de-CH');
    expect(rows.map((r) => [r.finding_id, r.status, r.segment_id])).toEqual([
      ['f-a2', 'fixed', 'h-001'],
      ['f-a1', 'open', 'p-002'],
      ['f-a3', 'open', null],
    ]);
  });

  it('covers every finding of the requested locales only', () => {
    const all = buildFindingRows(runs, both);
    expect(all).toHaveLength(11);
    expect(new Set(all.map((r) => r.provider))).toEqual(new Set([ALPHA, BRAVO, CHARLIE]));
    expect(buildFindingRows(runs, ['en-GB']).every((r) => r.locale === 'en-GB')).toBe(true);
  });
});

describe('costRole', () => {
  it('assigns calls by stage: candidate, judge or shared pipeline plumbing', () => {
    const roles = (stages: Array<Stage | 'all'>): string[] => stages.map(costRole);
    expect(roles(['translation', 'localization', 'repair', 'all'])).toEqual(['candidate', 'candidate', 'candidate', 'candidate']);
    expect(roles(['validation', 'backtranslation'])).toEqual(['judge', 'judge']);
    expect(roles(['language_detection'])).toEqual(['pipeline']);
  });
});

describe('buildCostRows', () => {
  const rows = buildCostRows(runs, JUDGE);
  const find = (provider: string, stage: string) => rows.find((r) => r.provider === provider && r.stage === stage);

  it('lists each candidate stage by stage, then its all row, then the judge rows, then pipeline rows', () => {
    expect(rows.map((r) => `${r.provider}|${r.stage}`)).toEqual([
      'anthropic|translation',
      'anthropic|localization',
      'anthropic|repair',
      'anthropic|all',
      'openai:gpt-mini|translation',
      'openai:gpt-mini|localization',
      'openai:gpt-mini|all',
      'google|translation',
      'google|localization',
      'google|all',
      'mistral|validation',
      'mistral|backtranslation',
      'anthropic|language_detection',
    ]);
  });

  it('sums calls, tokens, known cost and latency per provider and stage', () => {
    expect(find(ALPHA, 'translation')).toEqual({ provider: ALPHA, stage: 'translation', calls: 2, input_tokens: 900, output_tokens: 650, cost_usd: 0.007, latency_ms: 2700 });
    expect(find(ALPHA, 'localization')).toEqual({ provider: ALPHA, stage: 'localization', calls: 2, input_tokens: 200, output_tokens: 100, cost_usd: 0.004, latency_ms: 1900 });
    expect(find(BRAVO, 'translation')).toMatchObject({ calls: 2, cost_usd: 0.0022, latency_ms: 1700 });
  });

  it('totals a candidate over its candidate stages only', () => {
    expect(find(ALPHA, 'all')).toEqual({ provider: ALPHA, stage: 'all', calls: 5, input_tokens: 1200, output_tokens: 800, cost_usd: 0.012, latency_ms: 5200 });
    expect(find(BRAVO, 'all')).toMatchObject({ calls: 4, cost_usd: 0.0039, latency_ms: 2950 });
  });

  it('attributes judge stages to the judge, aggregated over every run, and never to a candidate', () => {
    expect(find(JUDGE, 'validation')).toEqual({ provider: JUDGE, stage: 'validation', calls: 8, input_tokens: 800, output_tokens: 400, cost_usd: 0.004, latency_ms: 5600 });
    expect(find(JUDGE, 'backtranslation')).toEqual({ provider: JUDGE, stage: 'backtranslation', calls: 5, input_tokens: 500, output_tokens: 250, cost_usd: 0.0015, latency_ms: 2500 });
    expect(find(JUDGE, 'all')).toBeUndefined();
    for (const candidate of [ALPHA, BRAVO, CHARLIE]) {
      expect(find(candidate, 'validation')).toBeUndefined();
      expect(find(candidate, 'backtranslation')).toBeUndefined();
    }
    // alpha's run cost 0.0142 in all; its candidate total is 0.012: the judge's 0.0021 and detection's 0.0001 are not in it.
    expect((scenario[ALPHA] as RunReport).totals.cost_usd).toBe(0.0142);
  });

  it('keeps pipeline plumbing apart even when its provider name equals a candidate ref', () => {
    expect(find('anthropic', 'language_detection')).toMatchObject({ calls: 3, cost_usd: 0.0003, latency_ms: 600 });
    expect(find(ALPHA, 'all')?.calls).toBe(5);
  });

  it('counts unpriced calls as calls but adds no cost for them', () => {
    expect(find(CHARLIE, 'translation')).toMatchObject({ calls: 2, cost_usd: 0.0015 });
    expect(find(CHARLIE, 'all')).toMatchObject({ calls: 3, cost_usd: 0.0021 });
    const buckets = collectCostBuckets(runs, JUDGE);
    expect(buckets.find((b) => b.provider === CHARLIE && b.stage === 'translation')?.unpriced_calls).toBe(1);
  });

  it('adds up to the runs totals: every non-all row together is everything that was billed', () => {
    const body = rows.filter((r) => r.stage !== 'all');
    const sum = (pick: (r: (typeof rows)[number]) => number): number => body.reduce((t, r) => t + pick(r), 0);
    const totals = runs.map((r) => r.report.totals);
    expect(sum((r) => r.calls)).toBe(totals.reduce((t, x) => t + x.calls, 0));
    expect(sum((r) => r.input_tokens)).toBe(totals.reduce((t, x) => t + x.input_tokens, 0));
    expect(sum((r) => r.output_tokens)).toBe(totals.reduce((t, x) => t + x.output_tokens, 0));
    expect(Math.round(sum((r) => r.cost_usd) * 1e6) / 1e6).toBe(0.0238);
  });

  it('keeps six decimals and removes float noise from sums', () => {
    const calls = [
      { stage: 'translation' as const, cost: 0.1, ms: 10 },
      { stage: 'translation' as const, cost: 0.2, ms: 20 },
      { stage: 'localization' as const, cost: 0.000123, ms: 5 },
      { stage: 'repair' as const, cost: 0.000001, ms: 1 },
    ];
    const report = buildRunReport({ runId: 'r', locales: [{ locale: 'de-CH', score: 90, verdict: 'PASS', segments: [] }], calls });
    const out = buildCostRows([{ ref: 'x', report }], JUDGE);
    expect(out.find((r) => r.stage === 'translation')?.cost_usd).toBe(0.3); // 0.1 + 0.2 is 0.30000000000000004 in floating point
    expect(out.find((r) => r.stage === 'localization')?.cost_usd).toBe(0.000123);
    expect(out.find((r) => r.stage === 'repair')?.cost_usd).toBe(0.000001);
    expect(out.find((r) => r.stage === 'all')?.cost_usd).toBe(0.300124);
  });

  it('gives a candidate without calls an all row of zeros', () => {
    const report = buildRunReport({ runId: 'r', locales: [{ locale: 'de-CH', score: 90, verdict: 'PASS', segments: [] }] });
    expect(buildCostRows([{ ref: 'quiet', report }], JUDGE)).toEqual([{ provider: 'quiet', stage: 'all', calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, latency_ms: 0 }]);
  });
});

describe('buildSegmentDiff', () => {
  const diff = buildSegmentDiff(runs, both);
  const at = (locale: string, id: string) => {
    const found = diff.find((r) => r.locale === locale && r.segment_id === id);
    if (!found) throw new Error(`no diff row ${locale}/${id}`);
    return found;
  };

  it('has one row per locale and segment, in document order, with the source text', () => {
    expect(diff.map((r) => `${r.locale}/${r.segment_id}`)).toEqual([
      'de-CH/h-001',
      'de-CH/p-001',
      'de-CH/p-002',
      'de-CH/m-title',
      'en-GB/h-001',
      'en-GB/p-001',
      'en-GB/p-002',
      'en-GB/m-title',
    ]);
    expect(at('de-CH', 'p-001').source_text).toBe('Onze pompen leveren 450 m³/h bij 16 bar.');
  });

  it('keeps every provider final text and flags rows whose outputs differ', () => {
    expect(at('de-CH', 'p-001')).toMatchObject({
      outputs: {
        [ALPHA]: 'Unsere Pumpen liefern 450 m³/h bei 16 bar.',
        [BRAVO]: 'Unsere Pumpen fördern 450 m³/h bei 16 bar.',
        [CHARLIE]: 'Unsere Pumpen liefern 450 m³/h bei 16 bar.',
      },
      identical: false,
    });
    expect(at('de-CH', 'm-title').identical).toBe(true);
    expect(at('en-GB', 'p-002').identical).toBe(false); // charlie wrote 'Delivery in 5 working days.'
  });

  it('records null for a provider without output and ignores it when comparing the others', () => {
    const row = at('de-CH', 'p-002');
    expect(row.outputs[CHARLIE]).toBeNull();
    expect(row.identical).toBe(false); // alpha and bravo differ

    const produced = (final: string | null) => buildRunReport({ runId: 'r', locales: [{ locale: 'de-CH', score: 90, verdict: 'PASS', segments: [{ id: 's-1', source: 'x', final }] }] });
    const onlyOne = buildSegmentDiff(
      [
        { ref: 'a', report: produced('Hallo') },
        { ref: 'b', report: produced(null) },
      ],
      ['de-CH'],
    );
    expect(onlyOne[0]).toMatchObject({ outputs: { a: 'Hallo', b: null }, identical: true });
  });

  it('compares output byte for byte (no trimming, no case folding)', () => {
    const produced = (final: string) => buildRunReport({ runId: 'r', locales: [{ locale: 'de-CH', score: 90, verdict: 'PASS', segments: [{ id: 's-1', source: 'x', final }] }] });
    const same = buildSegmentDiff([{ ref: 'a', report: produced('Hallo') }, { ref: 'b', report: produced('Hallo') }], ['de-CH']);
    const spaced = buildSegmentDiff([{ ref: 'a', report: produced('Hallo') }, { ref: 'b', report: produced('Hallo ') }], ['de-CH']);
    const cased = buildSegmentDiff([{ ref: 'a', report: produced('Hallo') }, { ref: 'b', report: produced('hallo') }], ['de-CH']);
    expect([same[0]?.identical, spaced[0]?.identical, cased[0]?.identical]).toEqual([true, false, false]);
  });

  it('orders segments by their order field and appends ids only a later run has', () => {
    const first = buildRunReport({
      runId: 'a',
      locales: [
        {
          locale: 'de-CH',
          score: 90,
          verdict: 'PASS',
          segments: [
            { id: 'late', source: 's-late', final: 'L', order: 9 },
            { id: 'early', source: 's-early', final: 'E', order: 1 },
          ],
        },
      ],
    });
    const second = buildRunReport({
      runId: 'b',
      locales: [
        {
          locale: 'de-CH',
          score: 90,
          verdict: 'PASS',
          segments: [
            { id: 'early', source: 'different source', final: 'E2', order: 1 },
            { id: 'extra', source: 's-extra', final: 'X', order: 5 },
          ],
        },
      ],
    });
    const out = buildSegmentDiff([{ ref: 'a', report: first }, { ref: 'b', report: second }], ['de-CH']);
    expect(out.map((r) => r.segment_id)).toEqual(['early', 'late', 'extra']);
    expect(out[0]?.source_text).toBe('s-early'); // from the first run
    expect(out[1]?.outputs).toEqual({ a: 'L', b: null }); // only the first run has it
    expect(out[2]?.outputs).toEqual({ a: null, b: 'X' }); // only the second run has it
  });
});

describe('countMissingOutputs', () => {
  it('lists every provider x locale with its number of segments that have no output', () => {
    const counts = countMissingOutputs(buildSegmentDiff(runs, both));
    expect(counts).toHaveLength(6);
    expect(counts.find((c) => c.provider === CHARLIE && c.locale === 'de-CH')).toEqual({ provider: CHARLIE, locale: 'de-CH', missing: 1, total: 4 });
    expect(counts.filter((c) => c.missing > 0)).toHaveLength(1);
  });
});

describe('bestProviderPerLocale', () => {
  const scores = buildScoreRows(runs, both);
  const costs = buildCostRows(runs, JUDGE);

  it('picks the highest quality score per locale', () => {
    const best = bestProviderPerLocale(scores, costs);
    expect(best.map((b) => b.locale)).toEqual(['de-CH', 'en-GB']);
    expect(best[0]).toEqual({ locale: 'de-CH', provider: CHARLIE, quality_score: 97, verdict: 'PASS', cost_usd: 0.0021, decided_by: 'score', tied_with: [] });
  });

  it('settles a score tie with the lower candidate cost (judge cost excluded)', () => {
    const en = bestProviderPerLocale(scores, costs)[1];
    // alpha and bravo both score 92.5 on en-GB; bravo is cheaper (0.0039 vs 0.012).
    expect(en).toEqual({ locale: 'en-GB', provider: BRAVO, quality_score: 92.5, verdict: 'PASS_WITH_NOTES', cost_usd: 0.0039, decided_by: 'cost', tied_with: [ALPHA] });
  });

  it('gives a tie on score and cost to the provider listed first', () => {
    const tie = [
      { ...row(scores, ALPHA, 'en-GB') },
      { ...row(scores, BRAVO, 'en-GB') },
    ];
    const sameCost = [
      { provider: ALPHA, stage: 'all' as const, calls: 1, input_tokens: 0, output_tokens: 0, cost_usd: 0.01, latency_ms: 0 },
      { provider: BRAVO, stage: 'all' as const, calls: 1, input_tokens: 0, output_tokens: 0, cost_usd: 0.01, latency_ms: 0 },
    ];
    expect(bestProviderPerLocale(tie, sameCost)[0]).toMatchObject({ provider: ALPHA, decided_by: 'order', tied_with: [BRAVO] });
  });

  it('treats scores equal up to float noise as a tie, and a provider with no cost row loses it', () => {
    const noisy = [
      { ...row(scores, ALPHA, 'en-GB'), quality_score: 92.5 },
      { ...row(scores, BRAVO, 'en-GB'), quality_score: 92.5 + 1e-12 },
    ];
    const onlyBravoCost = costs.filter((c) => c.provider === BRAVO);
    expect(bestProviderPerLocale(noisy, onlyBravoCost)[0]).toMatchObject({ provider: BRAVO, decided_by: 'cost' });
    expect(bestProviderPerLocale(noisy, [])[0]).toMatchObject({ provider: ALPHA, decided_by: 'order', cost_usd: null });
  });

  it('returns nothing for no scores', () => {
    expect(bestProviderPerLocale([], [])).toEqual([]);
  });
});
