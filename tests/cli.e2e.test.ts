/**
 * The command line end to end, with nothing faked but the model: the real commander program, the real engine, the real provider
 * registry (`providers.yaml`), a real HTML file and the offline `mock` provider bound to every stage. No network, no credentials.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { buildProgram, runProgram } from '../src/interfaces/cli.js';
import { createEngine } from '../src/pipeline/engine.js';
import { RunReportSchema } from '../src/schemas/report.js';
import { fixturesDir } from '../src/util/paths.js';

const cfg = loadConfig();
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const STAGES = ['language_detection', 'translation', 'localization', 'validation', 'backtranslation', 'repair'];
const ALL_SIX = ['en-NL', 'en-GB', 'de-DE', 'de-AT', 'de-CH', 'it-IT'];
const PAGE = path.join(fixturesDir(), 'ingest', 'pumps-nl.html');
const ON_MOCK = STAGES.flatMap((s) => ['--provider', `${s}=mock`]);

async function cli(args: string[]) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'locale-cli-'));
  dirs.push(scratch);
  let stdout = '';
  let stderr = '';
  const io = { stdout: (t: string) => void (stdout += t), stderr: (t: string) => void (stderr += t) };
  // env: {} — the run cannot see any API key, so only the mock provider can possibly answer
  const program = buildProgram({ ...io, getEngine: async () => createEngine({ config: cfg, env: {}, outputRoot: path.join(scratch, 'root') }) });
  const code = await runProgram(program, args, io);
  return { code, stdout, stderr, scratch };
}

describe('locale run, end to end on the mock provider', () => {
  it('translates and localizes a real HTML page into all six locales and writes every deliverable', async () => {
    const out = path.join(os.tmpdir(), `locale-cli-out-${process.pid}`);
    dirs.push(out);
    const r = await cli(['run', '--input', PAGE, '--targets', ALL_SIX.join(','), ...ON_MOCK, '--out', out, '--json']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);

    const report = RunReportSchema.parse(JSON.parse(r.stdout));
    expect(report.status).toBe('COMPLETE');
    expect(report.source.source_locale).toBe('nl-NL');
    expect(report.locales.map((l) => l.target_locale)).toEqual(ALL_SIX);
    for (const l of report.locales) {
      expect(l.segments.length, l.target_locale).toBe(report.source.segments);
      expect(l.counts.provider_error, l.target_locale).toBe(0);
      expect(l.verdict, l.target_locale).not.toBe('FAIL');
      expect(l.quality_score, l.target_locale).toBeGreaterThan(80);
    }
    expect(Object.values(report.routing).every((b) => b?.provider === 'mock')).toBe(true);

    expect(report.output_dir).toBe(out);
    const expected = ['localization_report.xlsx', 'executive_summary.md', 'run.json', ...ALL_SIX.flatMap((l) => ['page.json', 'page.md', 'page.html'].map((f) => `${l}/${f}`))];
    for (const f of expected) expect((await stat(path.join(out, f))).size, f).toBeGreaterThan(0);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(out, 'localization_report.xlsx'));
    expect(wb.worksheets).toHaveLength(8);

    // structure survives: the table and the list of the source page are still there, in UTF-8, in every locale
    for (const l of ALL_SIX) {
      const md = await readFile(path.join(out, l, 'page.md'), 'utf8');
      expect(md, l).toContain('| DP-50 |');
      expect(md, l).toMatch(/^- /m);
      expect(md, l).not.toMatch(/Ã|â€/);
      const html = await readFile(path.join(out, l, 'page.html'), 'utf8');
      expect(html, l).toContain(`lang="${l}"`);
    }
    // the run.json on disk is the very report that was printed
    expect(RunReportSchema.parse(JSON.parse(await readFile(path.join(out, 'run.json'), 'utf8'))).run_id).toBe(report.run_id);
  }, 60_000);

  it('prints a plain summary per locale and exits 0; --strict-review turns open human reviews into exit code 4', async () => {
    const base = ['run', '--input', PAGE, '--targets', 'de-CH,it-IT', ...ON_MOCK, '--no-write'];
    const plain = await cli(base);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('COMPLETE');
    expect(plain.stdout).toContain('de-CH');
    expect(plain.stdout).toContain('it-IT');
    expect(plain.stdout).toContain('not written');

    const strict = await cli([...base, '--strict-review', '--quiet']);
    expect(strict.code).toBe(4);
    expect(strict.stdout).toBe('');
  }, 60_000);

  it('with no provider configured for a stage it refuses before any work, naming the missing variable', async () => {
    const r = await cli(['run', '--input', PAGE, '--targets', 'de-CH', '--no-write']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  }, 30_000);

  it('`locales` and `providers test` work offline', async () => {
    const locales = await cli(['locales']);
    expect(locales.code).toBe(0);
    for (const l of ['en-GB', 'de-CH', 'it-IT']) expect(locales.stdout).toContain(l);
    const providers = await cli(['providers', 'test', 'mock']);
    expect(providers.code).toBe(0);
    expect(providers.stdout).toContain('mock');
  }, 30_000);
});
