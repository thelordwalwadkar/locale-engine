/** The deliverables of spec §6.5 written by a real run to disk, and read back (get_run_report, page.json as input of later stages). */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { createEngine } from '../src/pipeline/engine.js';
import { PageJsonSchema, RunReportSchema } from '../src/schemas/report.js';
import { goldenDoc, goldenFixtures, mockProvider, NOW, testRegistry } from './helpers/harness.js';

const cfg = loadConfig();
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const text = { kind: 'text' as const, text: 'placeholder', format: 'text' as const };

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'locale-out-'));
  dirs.push(dir);
  const registry = testRegistry(mockProvider('mock', { fixtures: goldenFixtures() }));
  const engine = createEngine({ config: cfg, registryFactory: () => registry, documentLoader: async () => goldenDoc(), now: () => NOW, env: {}, outputRoot: dir });
  return { dir, engine };
}

describe('deliverables per run', () => {
  it('writes <locale>/page.json|md|html, the 8-tab workbook, the executive summary and run.json into <outputRoot>/<run_id>/', async () => {
    const { dir, engine } = await setup();
    const report = await engine.runPipeline({ input: text, targets: ['de-CH', 'en-NL'], options: {} });
    const out = path.join(dir, report.run_id);
    expect(report.output_dir).toBe(out);
    const expected = ['de-CH/page.json', 'de-CH/page.md', 'de-CH/page.html', 'en-NL/page.json', 'en-NL/page.md', 'en-NL/page.html', 'localization_report.xlsx', 'executive_summary.md', 'run.json'];
    expect(report.artifacts).toEqual(expected);
    for (const f of expected) expect((await stat(path.join(out, f))).size, f).toBeGreaterThan(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(out, 'localization_report.xlsx'));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Segments', 'Validation_Findings', 'Localization_Changes', 'Market_Recommendations', 'SEO_Meta', 'Format_Changes', 'Run_Log']);

    const page = PageJsonSchema.parse(JSON.parse(await readFile(path.join(out, 'de-CH', 'page.json'), 'utf8')));
    expect(page.locale.target_locale).toBe('de-CH');
    expect(page.locale.segments[0]?.final_text).toContain('eine unverbindliche Offerte');
    const html = await readFile(path.join(out, 'de-CH', 'page.html'), 'utf8');
    expect(html).toContain('lang="de-CH"');
    expect(html).toContain('id="p-003"');
    expect(html).toContain('Offerte');
    expect(html).not.toContain('in heel Nederland');
    const md = await readFile(path.join(out, 'de-CH', 'page.md'), 'utf8');
    expect(md.startsWith('---\n')).toBe(true);
    const summary = await readFile(path.join(out, 'executive_summary.md'), 'utf8');
    expect(summary).toContain('de-CH');
    expect(summary).toContain('HUMAN_REVIEW');
  });

  it('get_run_report reads the run back from disk; unknown and unsafe ids are refused', async () => {
    const { dir, engine } = await setup();
    const report = await engine.runPipeline({ input: text, targets: ['de-CH'], options: {} });
    const back = await engine.getRunReport({ run_id: report.run_id });
    expect(RunReportSchema.parse(back)).toBeTruthy();
    expect(back.run_id).toBe(report.run_id);
    expect(back.artifacts).toContain('run.json');
    expect(back.locales[0]?.quality_score).toBe(95);
    expect(back.output_dir).toBe(path.join(dir, report.run_id));
    await expect(engine.getRunReport({ run_id: 'run_missing' })).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    await expect(engine.getRunReport({ run_id: '../escape' })).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    // an explicit folder is read as is, and must hold the requested run
    const explicit = await engine.getRunReport({ run_id: report.run_id, output_dir: path.join(dir, report.run_id) });
    expect(explicit.run_id).toBe(report.run_id);
    await expect(engine.getRunReport({ run_id: 'run_other', output_dir: path.join(dir, report.run_id) })).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
  });

  it('honours an explicit output_dir and write_outputs: false', async () => {
    const { dir, engine } = await setup();
    const custom = path.join(dir, 'custom-out');
    const a = await engine.runPipeline({ input: text, targets: ['de-CH'], options: { output_dir: custom } });
    expect(a.output_dir).toBe(custom);
    expect((await stat(path.join(custom, 'run.json'))).isFile()).toBe(true);
    const b = await engine.runPipeline({ input: text, targets: ['de-CH'], options: { write_outputs: false } });
    expect(b.output_dir).toBeNull();
    expect(b.artifacts).toEqual([]);
  });

  it('a page.json written by translate can be handed back by PATH to localize and to validate (stage commands chain on files)', async () => {
    const { dir, engine } = await setup();
    const t = await engine.translateContent({ input: text, targets: ['de-CH'], options: {} });
    const pagePath = path.join(dir, t.run_id, 'de-CH', 'page.json');
    const l = await engine.localizeContent({ input: { kind: 'page_json', path: pagePath }, targets: 'all', options: { write_outputs: false } });
    expect(l.locales[0]?.segments[0]?.final_text).toContain('Offerte');
    const v = await engine.validateContent({ input: { kind: 'page_json', path: pagePath }, options: { write_outputs: false } });
    expect(v.locales[0]?.target_locale).toBe('de-CH');
    await expect(engine.validateContent({ input: { kind: 'page_json', path: path.join(dir, 'nope.json') }, options: { write_outputs: false } })).rejects.toMatchObject({ code: 'INPUT_INVALID' });
  });
});
