/**
 * compare_models through the REAL provider registry (providers.yaml → `mock` provider with models mock-a / mock-b): proves per-run routing
 * overrides, the fixed judge, cost attribution and the model_comparison.xlsx deliverable without a line of pipeline code knowing the vendor.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { createEngine } from '../src/pipeline/engine.js';
import { CompareReportSchema } from '../src/schemas/api.js';
import { goldenDoc, NOW } from './helpers/harness.js';

const cfg = loadConfig();
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function engineInTemp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'locale-cmp-'));
  dirs.push(dir);
  return { dir, engine: createEngine({ config: cfg, documentLoader: async () => goldenDoc(), now: () => NOW, env: {}, outputRoot: dir }) };
}

describe('compare_models (real registry, mock vendor)', () => {
  it('runs two candidates with one fixed judge and reports scores, costs and diffs per provider and locale', async () => {
    const { engine } = await engineInTemp();
    const report = await engine.compareModels({
      input: { kind: 'text', text: 'placeholder', format: 'text' },
      targets: ['de-CH', 'it-IT'],
      providers: ['mock:mock-a', 'mock:mock-b'],
      judge_provider: 'mock',
      options: { write_outputs: false },
    });
    expect(CompareReportSchema.parse(report)).toBeTruthy();
    expect(report.providers).toEqual(['mock:mock-a', 'mock:mock-b']);
    expect(report.targets).toEqual(['de-CH', 'it-IT']);
    expect(report.judge).toEqual({ provider: 'mock', model: 'mock-a' });
    expect(report.scores.map((s) => `${s.provider}/${s.locale}`).sort()).toEqual(['mock:mock-a/de-CH', 'mock:mock-a/it-IT', 'mock:mock-b/de-CH', 'mock:mock-b/it-IT']);
    expect(Object.keys(report.runs)).toEqual(['mock:mock-a', 'mock:mock-b']);
    expect(new Set(Object.values(report.runs)).size).toBe(2);
    expect(report.segment_diff.map((d) => d.segment_id)).toEqual(['p-003', 'p-003']);
    // candidate and judge stages are attributed separately
    const stages = new Set(report.cost_latency.map((r) => r.stage));
    expect(stages.has('translation') && stages.has('validation') && stages.has('all')).toBe(true);
    expect(report.totals.calls).toBeGreaterThan(0);
    expect(report.notes.some((n) => n.startsWith('ROUTING_MISMATCH'))).toBe(false);
  });

  it('writes model_comparison.xlsx (four tabs) and compare_report.json into <outputRoot>/<compare_id>/', async () => {
    const { engine, dir } = await engineInTemp();
    const report = await engine.compareModels({
      input: { kind: 'text', text: 'placeholder', format: 'text' },
      targets: ['de-DE'],
      providers: ['mock:mock-a', 'mock:mock-b'],
      judge_provider: 'mock',
      options: {},
    });
    expect(report.output_dir).toBe(path.join(dir, report.compare_id));
    expect(report.artifacts).toEqual(expect.arrayContaining(['model_comparison.xlsx', 'compare_report.json']));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(report.output_dir as string, 'model_comparison.xlsx'));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Scores_by_Provider', 'Findings_by_Provider', 'Cost_Latency', 'Segment_Diff']);
    const json = CompareReportSchema.parse(JSON.parse(await readFile(path.join(report.output_dir as string, 'compare_report.json'), 'utf8')));
    expect(json.compare_id).toBe(report.compare_id);
  });

  it('refuses unknown providers before any model call, and fewer than two candidates', async () => {
    const { engine } = await engineInTemp();
    const base = { input: { kind: 'text' as const, text: 'x', format: 'text' as const }, targets: ['de-DE' as const], options: { write_outputs: false } };
    await expect(engine.compareModels({ ...base, providers: ['mock:mock-a', 'nosuch:model'] })).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    await expect(engine.compareModels({ ...base, providers: ['mock:mock-a'] })).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    // the default judge (routing.stages.validation = openai) has no key here: the run is refused with a message that names the variable
    await expect(engine.compareModels({ ...base, providers: ['mock:mock-a', 'mock:mock-b'] })).rejects.toThrow(/OPENAI_API_KEY/);
  });
});
