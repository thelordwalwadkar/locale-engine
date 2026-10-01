import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runComparison, type CompareDeps } from '../src/compare/index.js';
import { CompareReportSchema, type RunReport } from '../src/schemas/index.js';
import { EngineError } from '../src/util/errors.js';
import { ALPHA, BINDINGS, BRAVO, CHARLIE, JUDGE, NOW, SIBLING, compareRequest, makeDeps, scenarioRuns } from './fixtures/compare/scenario.js';

const created: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'locale-compare-'));
  created.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function failure(promise: Promise<unknown>): Promise<EngineError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof EngineError) return e;
    throw e;
  }
  throw new Error('expected the comparison to fail');
}

/** Fresh scenario reports, patched in place by the test. */
function tweaked(patch: (runs: Record<string, RunReport>) => void): Record<string, RunReport> {
  const runs = scenarioRuns();
  patch(runs);
  return runs;
}
const run = (runs: Record<string, RunReport>, ref: string): RunReport => runs[ref] as RunReport;

describe('runComparison: routing and order', () => {
  it('sends translation, localization and repair to the candidate and validation and backtranslation to the fixed judge', async () => {
    const { deps, requests } = makeDeps();
    const req = compareRequest();
    await runComparison(req, deps);
    expect(requests).toHaveLength(3);
    [ALPHA, BRAVO, CHARLIE].forEach((ref, i) => {
      const request = requests[i];
      expect(request?.options.providers).toEqual({ translation: ref, localization: ref, repair: ref, validation: JUDGE, backtranslation: JUDGE });
      expect(request?.options.write_outputs).toBe(false);
      expect(request?.input).toEqual(req.input);
      expect(request?.targets).toEqual(['de-CH', 'en-GB']);
    });
  });

  it('passes the other options through, but neither output_dir nor run_id', async () => {
    const dir = await tempDir();
    const { deps, requests } = makeDeps();
    await runComparison(
      compareRequest({
        options: {
          pass_threshold: 85,
          max_repair_loops: 1,
          cost_ceiling_usd: 2,
          backtranslate: false,
          repair: true,
          source_locale: 'nl-NL',
          primary_keyword: 'pompen',
          output_dir: dir,
          run_id: 'mine',
          write_outputs: true,
        },
      }),
      deps,
    );
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.options).toEqual({
        pass_threshold: 85,
        max_repair_loops: 1,
        cost_ceiling_usd: 2,
        backtranslate: false,
        repair: true,
        source_locale: 'nl-NL',
        primary_keyword: 'pompen',
        write_outputs: false,
        providers: expect.any(Object),
      });
    }
  });

  it('uses the requested judge, else the routing default, for every candidate', async () => {
    const explicit = makeDeps();
    const a = await runComparison(compareRequest({ judge_provider: SIBLING }), explicit.deps);
    expect(explicit.requests.map((r) => [r.options.providers?.validation, r.options.providers?.backtranslation])).toEqual([
      [SIBLING, SIBLING],
      [SIBLING, SIBLING],
      [SIBLING, SIBLING],
    ]);
    expect(a.judge).toEqual(BINDINGS[SIBLING]);

    const fallback = makeDeps({ defaultJudge: JUDGE });
    const b = await runComparison(compareRequest(), fallback.deps);
    expect(fallback.requests.every((r) => r.options.providers?.validation === JUDGE)).toBe(true);
    expect(b.judge).toEqual({ provider: 'mistral', model: 'mistral-large-3' });
  });

  it('keeps a language_detection override for every run, since that stage is not compared', async () => {
    const { deps, requests } = makeDeps();
    await runComparison(compareRequest({ options: { write_outputs: false, providers: { language_detection: 'mistral', translation: 'ignored' } } }), deps);
    for (const [i, ref] of [ALPHA, BRAVO, CHARLIE].entries()) {
      expect(requests[i]?.options.providers).toEqual({
        language_detection: 'mistral',
        translation: ref,
        localization: ref,
        repair: ref,
        validation: JUDGE,
        backtranslation: JUDGE,
      });
    }
  });

  it('runs the candidates one after the other, in request order', async () => {
    const { deps, events, peak } = makeDeps({ delayMs: 5 });
    const report = await runComparison(compareRequest({ providers: [CHARLIE, ALPHA, BRAVO] }), deps);
    expect(events).toEqual([`start:${CHARLIE}`, `end:${CHARLIE}`, `start:${ALPHA}`, `end:${ALPHA}`, `start:${BRAVO}`, `end:${BRAVO}`]);
    expect(peak()).toBe(1);
    expect(report.providers).toEqual([CHARLIE, ALPHA, BRAVO]);
  });
});

describe('runComparison: request validation happens before any run', () => {
  it('rejects an unknown candidate with INPUT_INVALID and starts nothing', async () => {
    const root = await tempDir();
    const { deps, requests } = makeDeps({ outputRoot: root });
    const error = await failure(runComparison(compareRequest({ providers: [ALPHA, 'nope'], options: {} }), deps));
    expect(error.code).toBe('INPUT_INVALID');
    expect(error.message).toContain('"nope"');
    expect(requests).toHaveLength(0);
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects an unknown judge', async () => {
    const { deps, requests } = makeDeps();
    const error = await failure(runComparison(compareRequest({ judge_provider: 'ghost' }), deps));
    expect(error.code).toBe('INPUT_INVALID');
    expect(error.message).toContain('judge provider "ghost"');
    expect(requests).toHaveLength(0);
  });

  it('rejects duplicate candidates', async () => {
    const { deps, requests } = makeDeps();
    const error = await failure(runComparison(compareRequest({ providers: [ALPHA, BRAVO, ALPHA] }), deps));
    expect(error.code).toBe('INPUT_INVALID');
    expect(error.message).toContain('duplicate providers: anthropic');
    expect(requests).toHaveLength(0);
  });

  it('rejects a comparison of fewer than two providers, like the request schema does', async () => {
    const { deps, requests } = makeDeps();
    const error = await failure(runComparison({ ...compareRequest(), providers: [ALPHA] }, deps));
    expect(error.code).toBe('INPUT_INVALID');
    expect(error.message).toContain('at least two providers');
    expect(requests).toHaveLength(0);
  });

  it('reports every problem at once', async () => {
    const { deps } = makeDeps();
    const error = await failure(runComparison(compareRequest({ providers: [ALPHA, 'nope', ALPHA, 'nada'], judge_provider: 'ghost' }), deps));
    expect(error.details?.['problems']).toEqual([
      'duplicate providers: anthropic',
      'judge provider "ghost" cannot be used: unknown provider "ghost"',
      'provider "nope" cannot be used: unknown provider "nope"',
      'provider "nada" cannot be used: unknown provider "nada"',
    ]);
  });

  it('keeps the code of an EngineError from describeProvider when every failure agrees, else INPUT_INVALID', async () => {
    const { deps } = makeDeps();
    const unavailable: CompareDeps = {
      ...deps,
      describeProvider(ref) {
        if (ref === BRAVO) throw new EngineError('PROVIDER_UNAVAILABLE', 'no API key for openai');
        return deps.describeProvider(ref);
      },
    };
    const only = await failure(runComparison(compareRequest(), unavailable));
    expect(only.code).toBe('PROVIDER_UNAVAILABLE');
    expect(only.message).toContain('no API key for openai');

    const mixed = await failure(runComparison(compareRequest({ providers: [ALPHA, BRAVO, 'nope'] }), unavailable));
    expect(mixed.code).toBe('INPUT_INVALID');
  });

  it('fails fast on an output folder that cannot be created, before any run', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a-file');
    await writeFile(file, 'not a folder');
    const { deps, requests } = makeDeps();
    const error = await failure(runComparison(compareRequest({ options: { output_dir: path.join(file, 'sub') } }), deps));
    expect(error.code).toBe('INPUT_INVALID');
    expect(error.message).toContain('Cannot create the output directory');
    expect(requests).toHaveLength(0);
  });
});

describe('runComparison: candidates that fail or end early', () => {
  it('notes a candidate whose run throws, leaves it out of every table and carries on', async () => {
    const reports = { ...scenarioRuns(), [BRAVO]: new Error('rate limit exceeded') };
    const { deps, requests } = makeDeps({ reports });
    const report = await runComparison(compareRequest(), deps);

    expect(requests).toHaveLength(3); // charlie still ran after bravo failed
    expect(report.notes).toContain('CANDIDATE_FAILED: openai:gpt-mini: rate limit exceeded');
    expect(report.providers).toEqual([ALPHA, CHARLIE]);
    expect(Object.keys(report.runs)).toEqual([ALPHA, CHARLIE]);
    expect(new Set(report.scores.map((s) => s.provider))).toEqual(new Set([ALPHA, CHARLIE]));
    expect(new Set(report.findings.map((f) => f.provider))).toEqual(new Set([ALPHA, CHARLIE]));
    expect(report.cost_latency.some((r) => r.provider === BRAVO)).toBe(false);
    expect(report.segment_diff.every((r) => !(BRAVO in r.outputs))).toBe(true);
    expect(report.totals.calls).toBe(11 + 7); // alpha + charlie, not bravo
    expect(() => CompareReportSchema.parse(report)).not.toThrow();
  });

  it('fails with INTERNAL, naming every failure, when no candidate produces anything', async () => {
    const { deps } = makeDeps({ reports: { [ALPHA]: new Error('boom a'), [BRAVO]: new Error('boom b'), [CHARLIE]: new Error('boom c') } });
    const error = await failure(runComparison(compareRequest(), deps));
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toContain('CANDIDATE_FAILED: anthropic: boom a');
    expect(error.message).toContain('CANDIDATE_FAILED: google: boom c');
    expect(error.details?.['failures']).toHaveLength(3);
  });

  it('counts a run that returns no locale results as failed and says what it cost', async () => {
    const reports = tweaked((runs) => {
      run(runs, BRAVO).locales = [];
      run(runs, BRAVO).status = 'FAILED';
    });
    const report = await runComparison(compareRequest(), makeDeps({ reports }).deps);
    expect(report.providers).toEqual([ALPHA, CHARLIE]);
    expect(report.notes).toContain(
      'CANDIDATE_FAILED: openai:gpt-mini: run run-bravo produced no locale results (status FAILED); its usage of $0.006100 is not part of the totals',
    );
  });

  it.each(['HALTED_COST_CEILING', 'PARTIAL', 'FAILED'] as const)('keeps a %s run in the tables and notes it', async (status) => {
    const reports = tweaked((runs) => {
      run(runs, BRAVO).status = status;
    });
    const report = await runComparison(compareRequest(), makeDeps({ reports }).deps);
    expect(report.providers).toContain(BRAVO);
    const incomplete = report.notes.filter((n) => n.startsWith('CANDIDATE_INCOMPLETE:'));
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toContain(`openai:gpt-mini: run run-bravo ended ${status}`);
  });
});

describe('runComparison: judge independence (ARCHITECTURE P4)', () => {
  it('notes a candidate that is also the judge and carries on', async () => {
    const { deps, requests } = makeDeps();
    const report = await runComparison(compareRequest({ judge_provider: ALPHA }), deps);
    expect(report.notes).toContain('JUDGE_NOT_INDEPENDENT: candidate anthropic is also the judge');
    expect(report.providers).toEqual([ALPHA, BRAVO, CHARLIE]);
    expect(requests[0]?.options.providers).toMatchObject({ translation: ALPHA, validation: ALPHA, backtranslation: ALPHA });
  });

  it('notes a candidate that shares the judge provider but not its model, with its own wording', async () => {
    const { deps } = makeDeps();
    const report = await runComparison(compareRequest({ judge_provider: SIBLING }), deps);
    expect(report.notes).toContain('JUDGE_NOT_INDEPENDENT: candidate anthropic shares provider anthropic with the judge anthropic:haiku');
  });

  it('adds no independence note when the judge comes from another provider', async () => {
    const report = await runComparison(compareRequest(), makeDeps().deps);
    expect(report.notes.some((n) => n.startsWith('JUDGE_NOT_INDEPENDENT'))).toBe(false);
  });
});

describe('runComparison: target locales', () => {
  it('compares only the locales every candidate produced and says so', async () => {
    const reports = tweaked((runs) => {
      run(runs, BRAVO).locales = run(runs, BRAVO).locales.filter((l) => l.target_locale === 'de-CH');
    });
    const report = await runComparison(compareRequest(), makeDeps({ reports }).deps);
    expect(report.targets).toEqual(['de-CH']);
    expect(report.scores.map((s) => s.locale)).toEqual(['de-CH', 'de-CH', 'de-CH']);
    expect(new Set(report.segment_diff.map((r) => r.locale))).toEqual(new Set(['de-CH']));
    expect(new Set(report.findings.map((f) => f.locale))).toEqual(new Set(['de-CH']));
    const note = report.notes.find((n) => n.startsWith('TARGETS_DIFFER:'));
    expect(note).toContain('anthropic: de-CH, en-GB; openai:gpt-mini: de-CH; google: de-CH, en-GB');
    expect(note).toContain('(de-CH)');
  });

  it('reports no difference when all candidates produced the same locales', async () => {
    const report = await runComparison(compareRequest(), makeDeps().deps);
    expect(report.targets).toEqual(['de-CH', 'en-GB']);
    expect(report.notes.some((n) => n.startsWith('TARGETS_DIFFER'))).toBe(false);
  });

  it('still returns a valid report, with empty tables and a note, when the candidates share no locale', async () => {
    const reports = tweaked((runs) => {
      run(runs, ALPHA).locales = run(runs, ALPHA).locales.filter((l) => l.target_locale === 'de-CH');
      run(runs, BRAVO).locales = run(runs, BRAVO).locales.filter((l) => l.target_locale === 'en-GB');
    });
    const report = await runComparison(compareRequest({ providers: [ALPHA, BRAVO] }), makeDeps({ reports }).deps);
    expect(report.targets).toEqual([]);
    expect(report.scores).toEqual([]);
    expect(report.segment_diff).toEqual([]);
    expect(report.cost_latency.length).toBeGreaterThan(0); // the spend is still on record
    expect(report.notes.find((n) => n.startsWith('TARGETS_DIFFER:'))).toContain('(none)');
    expect(() => CompareReportSchema.parse(report)).not.toThrow();
  });
});

describe('runComparison: notes that protect the decision', () => {
  it('reports exactly the expected notes for the clean scenario', async () => {
    const report = await runComparison(compareRequest(), makeDeps().deps);
    expect(report.notes).toEqual([
      'JUDGE_COST_SHARED: judge mistral (mistral/mistral-large-3) scored every candidate: 13 calls, $0.005500. They are listed with role judge and are not part of any candidate\'s total',
      'PRICING_UNKNOWN: google (candidate): 1 of 3 calls have no pricing, so its cost counts the priced calls only',
      'SEGMENTS_WITHOUT_OUTPUT: google / de-CH: 1 of 4 segments have no output (PROVIDER_ERROR or NOT_PROCESSED); read its score against the segment list',
    ]);
  });

  it('flags a stage that was served by another provider than the one requested (silent fallback)', async () => {
    const reports = tweaked((runs) => {
      run(runs, ALPHA).routing = { ...run(runs, ALPHA).routing, translation: { provider: 'openai', model: 'gpt-5-mini' }, validation: { provider: 'anthropic', model: 'claude-sonnet-5-5' } };
    });
    const report = await runComparison(compareRequest(), makeDeps({ reports }).deps);
    const notes = report.notes.filter((n) => n.startsWith('ROUTING_MISMATCH:'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('anthropic: translation served by openai/gpt-5-mini instead of anthropic/claude-sonnet-5-5');
    expect(notes[0]).toContain('validation served by anthropic/claude-sonnet-5-5 instead of mistral/mistral-large-3');
  });

  it('flags candidates that ingested a different source', async () => {
    const reports = tweaked((runs) => {
      run(runs, BRAVO).source = { ...run(runs, BRAVO).source, words: 41, segments: 5 };
    });
    const report = await runComparison(compareRequest(), makeDeps({ reports }).deps);
    const notes = report.notes.filter((n) => n.startsWith('SOURCE_DIFFERS:'));
    expect(notes).toEqual(['SOURCE_DIFFERS: openai:gpt-mini ingested a different source than anthropic (segments 5 vs 4, words 41 vs 40); the scores may not be comparable']);
  });

  it('flags a locale the run did not validate', async () => {
    const reports = tweaked((runs) => {
      const locale = run(runs, CHARLIE).locales[1];
      if (locale) locale.verdict_reasons = ['NOT_VALIDATED: localize-only run [EVIDENCE: run-options]'];
    });
    const report = await runComparison(compareRequest(), makeDeps({ reports }).deps);
    expect(report.notes.filter((n) => n.startsWith('LOCALE_NOT_VALIDATED:'))).toEqual([
      'LOCALE_NOT_VALIDATED: google / en-GB: the run did not validate this locale, so its score, findings and judge averages are not comparable',
    ]);
  });
});

describe('runComparison: the report', () => {
  it('names itself after deps.now() and carries the judge, providers and run ids', async () => {
    const report = await runComparison(compareRequest(), makeDeps().deps);
    expect(report.compare_id).toMatch(/^cmp_20260930T141516Z_[0-9a-f]{4}$/);
    expect(report.created_at).toBe(NOW.toISOString());
    expect(report.schema_version).toBe(1);
    expect(report.providers).toEqual([ALPHA, BRAVO, CHARLIE]);
    expect(report.runs).toEqual({ [ALPHA]: 'run-alpha', [BRAVO]: 'run-bravo', [CHARLIE]: 'run-charlie' });
    expect(report.judge).toEqual({ provider: 'mistral', model: 'mistral-large-3' });
  });

  it('takes the source from the first successful run', async () => {
    const reports: Record<string, RunReport | Error> = tweaked((runs) => {
      run(runs, BRAVO).source = { ...run(runs, BRAVO).source, origin_ref: 'bravo-page' };
    });
    reports[ALPHA] = new Error('down');
    const report = await runComparison(compareRequest(), makeDeps({ reports }).deps);
    expect(report.source.origin_ref).toBe('bravo-page');
    expect(report.providers).toEqual([BRAVO, CHARLIE]);
  });

  it('holds one row set per provider and locale and sums the run totals', async () => {
    const report = await runComparison(compareRequest(), makeDeps().deps);
    expect(report.scores).toHaveLength(6);
    expect(report.findings).toHaveLength(11);
    expect(report.cost_latency).toHaveLength(13);
    expect(report.segment_diff).toHaveLength(8);
    expect(report.totals).toEqual({ calls: 28, input_tokens: 3500, output_tokens: 1950, cost_usd: 0.0238, unpriced_calls: 1, latency_ms: 19650 });
  });

  it('validates against CompareReportSchema when nothing is written', async () => {
    const report = await runComparison(compareRequest(), makeDeps().deps);
    expect(() => CompareReportSchema.parse(report)).not.toThrow();
    expect(report.output_dir).toBeNull();
    expect(report.artifacts).toEqual([]);
  });

  it('builds the rows from spec clauses: findings tagged, judge cost shared, best per locale derivable', async () => {
    const report = await runComparison(compareRequest(), makeDeps().deps);
    expect(report.findings.every((f) => typeof f.provider === 'string' && f.finding_id !== '')).toBe(true);
    const judgeRows = report.cost_latency.filter((r) => r.provider === JUDGE);
    expect(judgeRows.map((r) => r.stage)).toEqual(['validation', 'backtranslation']);
    expect(report.scores.find((s) => s.provider === CHARLIE && s.locale === 'de-CH')?.quality_score).toBe(97);
  });
});

describe('runComparison: artifacts', () => {
  it('writes into <outputRoot>/<compare_id> when no output_dir is given, and lists the artifacts', async () => {
    const root = await tempDir();
    const report = await runComparison(compareRequest({ options: {} }), makeDeps({ outputRoot: root }).deps);
    expect(report.output_dir).toBe(path.resolve(root, report.compare_id));
    expect(report.artifacts).toEqual(['model_comparison.xlsx', 'compare_report.json']);
    for (const artifact of report.artifacts) {
      expect((await stat(path.join(report.output_dir ?? '', artifact))).isFile()).toBe(true);
    }
  });

  it('writes into options.output_dir when given', async () => {
    const dir = path.join(await tempDir(), 'chosen', 'folder');
    const root = await tempDir();
    const report = await runComparison(compareRequest({ options: { output_dir: dir, write_outputs: true } }), makeDeps({ outputRoot: root }).deps);
    expect(report.output_dir).toBe(path.resolve(dir));
    expect((await readdir(dir)).sort()).toEqual(['compare_report.json', 'model_comparison.xlsx']);
    expect(await readdir(root)).toEqual([]);
  });

  it('writes nothing with write_outputs: false', async () => {
    const root = await tempDir();
    const report = await runComparison(compareRequest({ options: { write_outputs: false } }), makeDeps({ outputRoot: root }).deps);
    expect(report.output_dir).toBeNull();
    expect(report.artifacts).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it('writes a compare_report.json that validates and equals the returned report', async () => {
    const root = await tempDir();
    const report = await runComparison(compareRequest({ options: {} }), makeDeps({ outputRoot: root }).deps);
    const text = await readFile(path.join(report.output_dir ?? '', 'compare_report.json'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('\r');
    const parsed = CompareReportSchema.parse(JSON.parse(text));
    expect(parsed).toEqual(JSON.parse(JSON.stringify(report)));
    expect(parsed.artifacts).toEqual(['model_comparison.xlsx', 'compare_report.json']);
    expect(parsed.output_dir).toBe(report.output_dir);
  });
});
