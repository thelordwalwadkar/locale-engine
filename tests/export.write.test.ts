import ExcelJS from 'exceljs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executiveSummary, readRunReport, renderHtml, renderMarkdown, toPageJson, writeRunArtifacts } from '../src/export/index.js';
import { PageJsonSchema, RunReportSchema } from '../src/schemas/index.js';
import type { LocaleCode, RunReport } from '../src/schemas/index.js';
import { EngineError } from '../src/util/errors.js';
import { localeOf, sampleReport, segmentOf } from './fixtures/export/sample-report.js';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'locale-export-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const EXPECTED_FILES = [
  'de-CH/page.json',
  'de-CH/page.md',
  'de-CH/page.html',
  'en-NL/page.json',
  'en-NL/page.md',
  'en-NL/page.html',
  'localization_report.xlsx',
  'executive_summary.md',
  'run.json',
];

async function failure(work: Promise<unknown>): Promise<EngineError> {
  try {
    await work;
  } catch (e) {
    if (e instanceof EngineError) return e;
    throw e;
  }
  throw new Error('expected an EngineError');
}

const read = (...parts: string[]): Promise<string> => readFile(path.join(dir, ...parts), 'utf8');

describe('toPageJson', () => {
  it('wraps the locale result with schema version, run id and source', () => {
    const report = sampleReport();
    const page = toPageJson(report, 'de-CH');
    expect(page.schema_version).toBe(1);
    expect(page.run_id).toBe(report.run_id);
    expect(page.source).toEqual(report.source);
    expect(page.locale).toEqual(localeOf(report, 'de-CH'));
    expect(PageJsonSchema.safeParse(page).success).toBe(true);
    expect(toPageJson(report, 'en-NL').locale.target_locale).toBe('en-NL');
  });

  it('throws INPUT_INVALID for a locale that is not part of the run, naming the ones that are', async () => {
    const err = await failure(Promise.resolve().then(() => toPageJson(sampleReport(), 'it-IT')));
    expect(err.code).toBe('INPUT_INVALID');
    expect(err.message).toContain('it-IT');
    expect(err.message).toContain('de-CH, en-NL');
  });
});

describe('writeRunArtifacts', () => {
  it('writes every deliverable and returns the relative paths, forward slashes, in a stable order', async () => {
    const written = await writeRunArtifacts(sampleReport(), dir);
    expect(written).toEqual(EXPECTED_FILES);
    for (const rel of written) expect((await readFile(path.join(dir, ...rel.split('/')))).length).toBeGreaterThan(0);
    expect((await readdir(dir)).sort()).toEqual(['de-CH', 'en-NL', 'executive_summary.md', 'localization_report.xlsx', 'run.json']);
    expect((await readdir(path.join(dir, 'de-CH'))).sort()).toEqual(['page.html', 'page.json', 'page.md']);
  });

  it('creates the output directory, including missing parents', async () => {
    const nested = path.join(dir, 'a', 'b', 'run-1');
    await writeRunArtifacts(sampleReport(), nested);
    expect(await readFile(path.join(nested, 'run.json'), 'utf8')).toContain('"run_id"');
  });

  it('writes the same content the render functions return', async () => {
    const report = sampleReport();
    await writeRunArtifacts(report, dir);
    const page = toPageJson(report, 'de-CH');
    expect(JSON.parse(await read('de-CH', 'page.json'))).toEqual(page);
    expect(PageJsonSchema.safeParse(JSON.parse(await read('en-NL', 'page.json'))).success).toBe(true);
    expect(await read('de-CH', 'page.md')).toBe(renderMarkdown(page));
    expect(await read('de-CH', 'page.html')).toBe(renderHtml(page));
    expect(await read('executive_summary.md')).toBe(executiveSummary(report));
  });

  it('writes a real workbook with the eight tabs', async () => {
    await writeRunArtifacts(sampleReport(), dir);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(dir, 'localization_report.xlsx'));
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Summary',
      'Segments',
      'Validation_Findings',
      'Localization_Changes',
      'Market_Recommendations',
      'SEO_Meta',
      'Format_Changes',
      'Run_Log',
    ]);
  });

  it('writes run.json with output_dir and artifacts filled in, and readRunReport round-trips it', async () => {
    const report = sampleReport();
    const written = await writeRunArtifacts(report, dir);
    const raw = JSON.parse(await read('run.json')) as RunReport;
    expect(raw.output_dir).toBe(path.resolve(dir));
    expect(raw.artifacts).toEqual(written);
    expect(raw.artifacts).toContain('run.json');
    const back = await readRunReport(dir);
    expect(back).toEqual({ ...report, output_dir: path.resolve(dir), artifacts: EXPECTED_FILES });
    expect(RunReportSchema.safeParse(back).success).toBe(true);
    // the caller's report is not modified
    expect(report.output_dir).toBeNull();
    expect(report.artifacts).toEqual([]);
  });

  it('writes UTF-8 text with LF line endings and no byte-order mark, even for CRLF source text', async () => {
    const report = sampleReport();
    const de = localeOf(report, 'de-CH');
    segmentOf(de, 'p-019').final_text = 'Größe – Zeile eins\r\nZeile zwei\rZeile drei';
    de.seo_meta.title = 'Titel\r\nmit Umbruch';
    report.run_log[0]!.message = 'line\r\nbreak';
    for (const rel of await writeRunArtifacts(report, dir)) {
      if (rel.endsWith('.xlsx')) continue;
      const bytes = await readFile(path.join(dir, ...rel.split('/')));
      expect(bytes.includes(0x0d), `${rel} contains CR`).toBe(false);
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${rel} has a BOM`).toBe(false);
      expect(bytes.at(-1), `${rel} ends with a newline`).toBe(0x0a);
    }
    expect(await read('de-CH', 'page.md')).toContain('Größe – Zeile eins Zeile zwei Zeile drei');
    expect(await read('de-CH', 'page.json')).toContain('Größe – Zeile eins\\r\\nZeile zwei\\rZeile drei'); // data, escaped, not a line ending
  });

  it('shows "n/a (not validated)" in page.md when the run skipped validation, and keeps the numbers in page.json', async () => {
    const report = sampleReport();
    report.options.stages.validate = false;
    await writeRunArtifacts(report, dir);
    expect(await read('de-CH', 'page.md')).toContain('quality_score: n/a (not validated)');
    expect(JSON.parse(await read('de-CH', 'page.json')).locale.quality_score).toBe(94);
    expect(await read('executive_summary.md')).toContain('n/a (not validated)');
  });

  it('is idempotent: a second run gives the same paths and the same files', async () => {
    const report = sampleReport();
    const first = await writeRunArtifacts(report, dir);
    const before = new Map<string, string>();
    for (const rel of first.filter((f) => !f.endsWith('.xlsx'))) before.set(rel, await read(...rel.split('/')));
    const second = await writeRunArtifacts(report, dir);
    expect(second).toEqual(first);
    for (const [rel, content] of before) expect(await read(...rel.split('/')), rel).toBe(content);
    // a report that was read back from run.json exports to the same files again
    const again = await writeRunArtifacts(await readRunReport(dir), dir);
    expect(again).toEqual(first);
    expect(await read('executive_summary.md')).toBe(before.get('executive_summary.md'));
    expect(await read('de-CH', 'page.json')).toBe(before.get('de-CH/page.json'));
  });

  it('exports partial and halted runs: what exists is written', async () => {
    const report = sampleReport();
    report.status = 'HALTED_COST_CEILING';
    const en = localeOf(report, 'en-NL');
    for (const seg of en.segments) {
      if (seg.segment_id === 'p-003' || seg.segment_id === 'p-007') {
        seg.status = 'NOT_PROCESSED';
        seg.final_text = null;
        seg.translation = null;
        seg.localized_text = null;
        seg.validation = null;
      }
    }
    const written = await writeRunArtifacts(report, dir);
    expect(written).toEqual(EXPECTED_FILES);
    expect(await read('en-NL', 'page.md')).toContain('> [NOT_PROCESSED: p-003]');
    expect(await read('en-NL', 'page.html')).toContain('[NOT_PROCESSED: p-007]');
    expect(await read('executive_summary.md')).toContain('HALTED_COST_CEILING');
    expect((await readRunReport(dir)).status).toBe('HALTED_COST_CEILING');
  });

  it('exports a run without any locale result: workbook, summary and run.json only', async () => {
    const report = sampleReport();
    report.status = 'FAILED';
    report.locales = [];
    const written = await writeRunArtifacts(report, dir);
    expect(written).toEqual(['localization_report.xlsx', 'executive_summary.md', 'run.json']);
    expect(await readdir(dir)).toHaveLength(3);
    expect((await readRunReport(dir)).locales).toEqual([]);
  });

  it('writes a locale once even when the report lists it twice', async () => {
    const report = sampleReport();
    report.locales.push(structuredClone(localeOf(report, 'de-CH')));
    const written = await writeRunArtifacts(report, dir);
    expect(written).toEqual(EXPECTED_FILES);
  });

  it('refuses a locale code that cannot be a folder name', async () => {
    const report = sampleReport();
    localeOf(report, 'de-CH').target_locale = '../evil' as LocaleCode;
    const err = await failure(writeRunArtifacts(report, dir));
    expect(err.code).toBe('INPUT_INVALID');
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('readRunReport', () => {
  it('throws RUN_NOT_FOUND when the folder or the file is missing', async () => {
    for (const target of [path.join(dir, 'missing'), dir]) {
      const err = await failure(readRunReport(target));
      expect(err.code).toBe('RUN_NOT_FOUND');
      expect(err.message).toContain('run.json');
    }
    await writeFile(path.join(dir, 'plain-file'), 'x');
    expect((await failure(readRunReport(path.join(dir, 'plain-file')))).code).toBe('RUN_NOT_FOUND');
  });

  it('throws CONFIG_INVALID for text that is not JSON', async () => {
    await writeFile(path.join(dir, 'run.json'), '{ "run_id": ');
    const err = await failure(readRunReport(dir));
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toContain('not valid JSON');
  });

  it('throws CONFIG_INVALID naming the problem when the JSON is not a run report', async () => {
    const broken = { ...sampleReport(), status: 'DONE' } as unknown;
    await writeFile(path.join(dir, 'run.json'), JSON.stringify(broken));
    const err = await failure(readRunReport(dir));
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toContain('not a valid run report');
    expect(err.message).toContain('status');

    await writeFile(path.join(dir, 'run.json'), '[]');
    const root = await failure(readRunReport(dir));
    expect(root.code).toBe('CONFIG_INVALID');
    expect(root.message).toContain('(root)');

    const nested = sampleReport() as unknown as { locales: Array<{ segments: Array<Record<string, unknown>> }> };
    nested.locales[0]!.segments[2]!['block_type'] = 'table';
    await writeFile(path.join(dir, 'run.json'), JSON.stringify(nested));
    expect((await failure(readRunReport(dir))).message).toContain('locales.0.segments.2.block_type');
  });

  it('accepts a run.json saved with a byte-order mark', async () => {
    await writeFile(path.join(dir, 'run.json'), `﻿${JSON.stringify(sampleReport())}`);
    expect((await readRunReport(dir)).run_id).toBe('run-20260930-a1b2c3');
  });

  it('reports other read problems as INTERNAL', async () => {
    await mkdir(path.join(dir, 'run.json'));
    expect((await failure(readRunReport(dir))).code).toBe('INTERNAL');
  });
});

describe('determinism', () => {
  it('renders the same report to identical page.json, page.md, page.html and summary', () => {
    const a = sampleReport();
    const b = sampleReport();
    for (const code of ['de-CH', 'en-NL'] as const) {
      const pa = toPageJson(a, code);
      const pb = toPageJson(b, code);
      expect(JSON.stringify(pa)).toBe(JSON.stringify(pb));
      expect(renderMarkdown(pa)).toBe(renderMarkdown(pb));
      expect(renderHtml(pa)).toBe(renderHtml(pb));
    }
    expect(executiveSummary(a)).toBe(executiveSummary(b));
  });

  it('writes identical files into two folders (the workbook differs only in zip metadata)', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'locale-export-'));
    try {
      const report = sampleReport();
      await writeRunArtifacts(report, dir);
      await writeRunArtifacts(sampleReport(), other);
      for (const rel of EXPECTED_FILES.filter((f) => !f.endsWith('.xlsx') && f !== 'run.json')) {
        expect(await readFile(path.join(dir, ...rel.split('/')), 'utf8'), rel).toBe(await readFile(path.join(other, ...rel.split('/')), 'utf8'));
      }
      const values = async (folder: string): Promise<string> => {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(path.join(folder, 'localization_report.xlsx'));
        return JSON.stringify(wb.worksheets.map((w) => w.getSheetValues()));
      };
      expect(await values(dir)).toBe(await values(other));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
