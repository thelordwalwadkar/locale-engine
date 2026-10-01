import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runComparison, writeComparisonArtifacts } from '../src/compare/index.js';
import { SEVERITY_FILL, VERDICT_FILL, cellText } from '../src/compare/workbook.js';
import { CompareReportSchema, type CompareReport } from '../src/schemas/index.js';
import { ALPHA, BRAVO, CHARLIE, JUDGE, compareRequest, makeDeps } from './fixtures/compare/scenario.js';

const created: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'locale-compare-xlsx-'));
  created.push(dir);
  return dir;
}

async function readWorkbook(dir: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(dir, 'model_comparison.xlsx'));
  return workbook;
}

function sheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const found = workbook.getWorksheet(name);
  if (!found) throw new Error(`missing tab ${name}`);
  return found;
}

const headers = (ws: ExcelJS.Worksheet): string[] => Array.from({ length: ws.columnCount }, (_, i) => String(ws.getCell(1, i + 1).value));
const rowValues = (ws: ExcelJS.Worksheet, row: number, count: number): ExcelJS.CellValue[] => Array.from({ length: count }, (_, i) => ws.getCell(row, i + 1).value);

/** First row whose column-A text starts with `text`. */
function rowStartingWith(ws: ExcelJS.Worksheet, text: string): number {
  for (let r = 1; r <= ws.rowCount; r++) {
    const value = ws.getCell(r, 1).value;
    if (typeof value === 'string' && value.startsWith(text)) return r;
  }
  throw new Error(`no row starting with "${text}" in ${ws.name}`);
}

function solidFill(cell: ExcelJS.Cell): string | undefined {
  const fill = cell.fill;
  return fill && fill.type === 'pattern' && fill.pattern === 'solid' ? fill.fgColor?.argb : undefined;
}

function channels(argb: string): { r: number; g: number; b: number } {
  return { r: parseInt(argb.slice(2, 4), 16), g: parseInt(argb.slice(4, 6), 16), b: parseInt(argb.slice(6, 8), 16) };
}

let dir: string;
let report: CompareReport;
let book: ExcelJS.Workbook;

beforeAll(async () => {
  dir = await tempDir();
  report = await runComparison(compareRequest({ options: { output_dir: dir, write_outputs: true } }), makeDeps().deps);
  book = await readWorkbook(dir);
});
afterAll(async () => {
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true })));
});

/** Writes a modified copy of the scenario report and reads the workbook back. */
async function writtenFrom(edit: (copy: CompareReport) => void): Promise<{ book: ExcelJS.Workbook; dir: string }> {
  const copy = structuredClone(report);
  edit(copy);
  const target = await tempDir();
  await writeComparisonArtifacts(copy, target);
  return { book: await readWorkbook(target), dir: target };
}

describe('workbook: tabs and house style', () => {
  it('has the four tabs of spec 6.5 item 5, in that order', () => {
    expect(book.worksheets.map((w) => w.name)).toEqual(['Scores_by_Provider', 'Findings_by_Provider', 'Cost_Latency', 'Segment_Diff']);
  });

  it.each([
    ['Scores_by_Provider', 'A1:N7', 2],
    ['Findings_by_Provider', 'A1:L12', 2],
    ['Cost_Latency', 'A1:I14', 0],
    ['Segment_Diff', 'A1:G9', 2],
  ] as const)('%s: bold filled header row, frozen header, autofilter over the table rows only, wrapped text', (name, range, frozenColumns) => {
    const ws = sheet(book, name);
    const fills = new Set<string | undefined>();
    for (let c = 1; c <= ws.columnCount; c++) {
      const cell = ws.getCell(1, c);
      expect(cell.font?.bold).toBe(true);
      expect(cell.alignment?.wrapText).toBe(true);
      expect(solidFill(cell)).toBeDefined();
      fills.add(solidFill(cell));
    }
    expect(fills.size).toBe(1);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1, xSplit: frozenColumns });
    expect(ws.autoFilter).toBe(range);
  });

  it('sets column widths and wraps body text', () => {
    const diff = sheet(book, 'Segment_Diff');
    expect(diff.getColumn(3).width).toBeGreaterThanOrEqual(40);
    expect(diff.getCell(2, 3).alignment?.wrapText).toBe(true);
    const findings = sheet(book, 'Findings_by_Provider');
    expect(findings.getColumn(7).width).toBeGreaterThanOrEqual(40);
    for (const ws of book.worksheets) {
      for (let c = 1; c <= ws.columnCount; c++) expect(ws.getColumn(c).width).toBeGreaterThan(5);
    }
  });

  it('carries workbook properties', () => {
    expect(book.creator).toBe('locale-engine');
    // Core properties are stored with second precision.
    expect(book.created.toISOString()).toBe(report.created_at.replace(/\.\d+Z$/, '.000Z'));
  });
});

describe('workbook: Scores_by_Provider', () => {
  const ws = () => sheet(book, 'Scores_by_Provider');

  it('has provider, locale, score, verdict, penalty, findings by severity, the five judge averages and the missing outputs', () => {
    expect(headers(ws())).toEqual([
      'Provider',
      'Locale',
      'Quality score',
      'Verdict',
      'Penalty',
      'Minor findings (open)',
      'Major findings (open)',
      'Critical findings (open)',
      'Judge accuracy',
      'Judge fluency',
      'Judge terminology',
      'Judge locale conventions',
      'Judge style & brand',
      'Segments without output',
    ]);
  });

  it('writes the rows as typed numbers, blank where the judge scored nothing', () => {
    expect(rowValues(ws(), 2, 14)).toEqual(['anthropic', 'de-CH', 96, 'PASS', 4, 2, 0, 0, 93.3, 92, 91, 89, 88.7, 0]);
    expect(rowValues(ws(), 6, 14)).toEqual(['google', 'de-CH', 97, 'PASS', 3, 0, 1, 0, 92, 92, 92, 92, 92, 1]); // one segment has no output
    expect(rowValues(ws(), 7, 14)).toEqual(['google', 'en-GB', 70, 'FAIL', 30, 1, 2, 0, null, null, null, null, null, 0]);
    expect(typeof ws().getCell(2, 3).value).toBe('number');
    expect(ws().getCell(2, 3).numFmt).toBe('0.00');
    expect(ws().getCell(2, 9).numFmt).toBe('0.0');
  });

  it('colour-codes the verdict: PASS green, PASS_WITH_NOTES light green, HUMAN_REVIEW amber, FAIL red', () => {
    for (let r = 2; r <= 7; r++) {
      const verdict = String(ws().getCell(r, 4).value) as keyof typeof VERDICT_FILL;
      expect(solidFill(ws().getCell(r, 4))).toBe(VERDICT_FILL[verdict]);
    }
    const pass = channels(VERDICT_FILL.PASS);
    const notes = channels(VERDICT_FILL.PASS_WITH_NOTES);
    const review = channels(VERDICT_FILL.HUMAN_REVIEW);
    const fail = channels(VERDICT_FILL.FAIL);
    expect(pass.g).toBeGreaterThan(pass.r);
    expect(pass.g).toBeGreaterThan(pass.b);
    expect(notes.g).toBeGreaterThan(notes.r);
    expect(notes.r + notes.g + notes.b).toBeGreaterThan(pass.r + pass.g + pass.b); // lighter than PASS
    expect(review.r).toBeGreaterThan(200);
    expect(review.g).toBeGreaterThan(150);
    expect(review.b).toBeLessThan(120);
    expect(fail.r).toBeGreaterThan(fail.g + 50);
    expect(fail.r).toBeGreaterThan(fail.b + 50);
    expect(new Set(Object.values(VERDICT_FILL)).size).toBe(4);
  });

  it('puts the best provider per locale below the table, outside the filter range', () => {
    const table = ws();
    const tableEnd = Number(String(table.autoFilter).split(':')[1]?.replace(/\D/g, ''));
    const title = rowStartingWith(table, 'Best provider per locale');
    expect(tableEnd).toBe(7);
    expect(title).toBeGreaterThan(tableEnd + 1); // a blank row in between
    expect(table.getCell(tableEnd + 1, 1).value).toBeNull();
    expect(rowValues(table, title + 1, 6)).toEqual(['Best provider', 'Locale', 'Quality score', 'Verdict', 'Candidate cost USD', 'Decided by']);
    // google tops de-CH although one of its segments has no output: the block says so next to the decision.
    expect(rowValues(table, title + 2, 6)).toEqual(['google', 'de-CH', 97, 'PASS', 0.0021, 'highest score; caution: 1 segment without output']);
    expect(rowValues(table, title + 3, 6)).toEqual(['openai:gpt-mini', 'en-GB', 92.5, 'PASS_WITH_NOTES', 0.0039, 'tie on score with anthropic; lower candidate cost']);
    expect(solidFill(table.getCell(title + 3, 4))).toBe(VERDICT_FILL.PASS_WITH_NOTES);
    expect(table.getCell(title + 2, 5).numFmt).toBe('$0.0000');
  });

  it('says what was compared and lists every note, or none', () => {
    const table = ws();
    const about = rowStartingWith(table, 'About this comparison');
    const lines = [1, 2, 3, 4, 5].map((i) => String(table.getCell(about + i, 1).value));
    expect(lines[0]).toContain(report.compare_id);
    expect(lines[1]).toContain('pump-page');
    expect(lines[2]).toBe('Judge, the same for every candidate: mistral / mistral-large-3');
    expect(lines[3]).toBe('Candidates: anthropic, openai:gpt-mini, google');
    expect(lines[4]).toBe('Locales compared: de-CH, en-GB');

    const notes = rowStartingWith(table, 'Notes');
    expect(report.notes.length).toBeGreaterThan(0);
    report.notes.forEach((note, i) => expect(table.getCell(notes + 1 + i, 1).value).toBe(note));
    expect(table.getCell(notes, 1).font?.bold).toBe(true);
    expect(table.getRow(notes + 1).height).toBeGreaterThanOrEqual(15);
  });

  it('prints None. when there are no notes, and omits the best block when there are no scores', async () => {
    const { book: empty } = await writtenFrom((copy) => {
      copy.notes = [];
      copy.targets = [];
      copy.scores = [];
      copy.findings = [];
      copy.segment_diff = [];
    });
    const table = sheet(empty, 'Scores_by_Provider');
    expect(table.autoFilter).toBe('A1:N1');
    expect(() => rowStartingWith(table, 'Best provider per locale')).toThrow();
    expect(table.getCell(rowStartingWith(table, 'Notes') + 1, 1).value).toBe('None.');
  });
});

describe('workbook: Findings_by_Provider', () => {
  const ws = () => sheet(book, 'Findings_by_Provider');

  it('mirrors the validation-findings columns plus the provider', () => {
    expect(headers(ws())).toEqual([
      'Provider',
      'Locale',
      'Segment',
      'Rule / category',
      'Severity',
      'Evidence',
      'Explanation',
      'Source span',
      'Target span',
      'Suggested fix',
      'Origin',
      'Status',
    ]);
  });

  it('lists every finding of every provider, nothing dropped, document findings marked', () => {
    const table = ws();
    const providers = Array.from({ length: 11 }, (_, i) => table.getCell(i + 2, 1).value);
    expect(providers).toEqual([...Array(3).fill(ALPHA), ...Array(4).fill(BRAVO), ...Array(4).fill(CHARLIE)]);
    const text = Array.from({ length: 11 }, (_, i) => String(table.getCell(i + 2, 7).value)).join('\n');
    for (const id of ['f-a1', 'f-a2', 'f-a3', 'f-b1', 'f-b2', 'f-b3', 'f-b4', 'f-c1', 'f-c2', 'f-c3', 'f-c4']) expect(text).toContain(id);
    expect(rowValues(table, 4, 12)).toEqual([ALPHA, 'de-CH', '(document)', 'INTEGRITY-CURRENCY', 'minor', '[EVIDENCE: INTEGRITY-CURRENCY]', '[EVIDENCE: INTEGRITY-CURRENCY] minor finding f-a3.', null, null, null, 'deterministic', 'open']);
  });

  it('colour-codes the severity and keeps the status of fixed and accepted findings', () => {
    const table = ws();
    const rows = Array.from({ length: 11 }, (_, i) => i + 2);
    for (const r of rows) {
      const severity = String(table.getCell(r, 5).value) as keyof typeof SEVERITY_FILL;
      expect(solidFill(table.getCell(r, 5))).toBe(SEVERITY_FILL[severity]);
    }
    expect(rows.map((r) => table.getCell(r, 12).value)).toEqual(['fixed', 'open', 'open', 'open', 'fixed', 'accepted', 'open', 'open', 'open', 'open', 'open']);
  });

  it('keeps just the header row when there are no findings', async () => {
    const { book: none } = await writtenFrom((copy) => {
      copy.findings = [];
    });
    const table = sheet(none, 'Findings_by_Provider');
    expect(table.actualRowCount).toBe(1);
    expect(table.autoFilter).toBe('A1:L1');
  });
});

describe('workbook: Cost_Latency', () => {
  const ws = () => sheet(book, 'Cost_Latency');

  it('has provider, role, stage, calls, tokens, cost, latency and average latency per call', () => {
    expect(headers(ws())).toEqual(['Provider', 'Role', 'Stage', 'Calls', 'Input tokens', 'Output tokens', 'Cost USD', 'Latency ms (sum of calls)', 'Avg latency ms per call']);
  });

  it('labels every row with its role: candidate, judge or pipeline', () => {
    const rows = Array.from({ length: 13 }, (_, i) => rowValues(ws(), i + 2, 3).join('|'));
    expect(rows).toEqual([
      'anthropic|candidate|translation',
      'anthropic|candidate|localization',
      'anthropic|candidate|repair',
      'anthropic|candidate|all',
      'openai:gpt-mini|candidate|translation',
      'openai:gpt-mini|candidate|localization',
      'openai:gpt-mini|candidate|all',
      'google|candidate|translation',
      'google|candidate|localization',
      'google|candidate|all',
      'mistral|judge|validation',
      'mistral|judge|backtranslation',
      'anthropic|pipeline|language_detection',
    ]);
  });

  it('writes calls, tokens, cost and latency as typed numbers, cost as $0.0000 with the full value kept', () => {
    expect(rowValues(ws(), 2, 9)).toEqual(['anthropic', 'candidate', 'translation', 2, 900, 650, 0.007, 2700, 1350]);
    expect(rowValues(ws(), 5, 9)).toEqual(['anthropic', 'candidate', 'all', 5, 1200, 800, 0.012, 5200, 1040]);
    expect(rowValues(ws(), 12, 9)).toEqual(['mistral', 'judge', 'validation', 8, 800, 400, 0.004, 5600, 700]);
    for (let r = 2; r <= 14; r++) expect(ws().getCell(r, 7).numFmt).toBe('$0.0000');
    expect(ws().getCell(5, 1).font?.bold).toBe(true); // an all row is emphasised
  });

  it('does not round costs to the displayed four decimals', async () => {
    const { book: precise } = await writtenFrom((copy) => {
      const first = copy.cost_latency[0];
      if (first) first.cost_usd = 0.000123;
    });
    const cell = sheet(precise, 'Cost_Latency').getCell(2, 7);
    expect(cell.value).toBe(0.000123);
    expect(cell.numFmt).toBe('$0.0000');
  });

  it('totals the judge separately and the whole comparison below the table', () => {
    const table = ws();
    const title = rowStartingWith(table, 'Totals');
    expect(title).toBeGreaterThan(15); // after the 13 table rows and a blank row
    expect(rowValues(table, title + 1, 3)).toEqual(['Provider', 'Role', 'Stage']);
    expect(rowValues(table, title + 2, 9)).toEqual(['mistral', 'judge', 'all', 13, 1300, 650, 0.0055, 8100, 623.1]);
    expect(rowValues(table, title + 3, 9)).toEqual(['All calls in this comparison', 'all', 'all', 28, 3500, 1950, 0.0238, 19650, 701.8]);
    expect(table.autoFilter).toBe('A1:I14');
  });

  it('explains the roles and repeats the cost caveats next to the numbers', () => {
    const table = ws();
    const notes = rowStartingWith(table, 'How to read this sheet');
    const lines = Array.from({ length: 6 }, (_, i) => String(table.getCell(notes + 1 + i, 1).value));
    expect(lines[0]).toContain('Role candidate');
    expect(lines[1]).toContain('Role judge');
    expect(lines[2]).toContain('Role pipeline');
    expect(lines[3]).toContain('sum of call latencies');
    expect(lines[4]).toMatch(/^JUDGE_COST_SHARED:/);
    expect(lines[5]).toMatch(/^PRICING_UNKNOWN:/);
  });
});

describe('workbook: Segment_Diff', () => {
  const ws = () => sheet(book, 'Segment_Diff');

  it('has locale, segment, source, one column per provider and the identical flag', () => {
    expect(headers(ws())).toEqual(['Locale', 'Segment', 'Source', 'anthropic', 'openai:gpt-mini', 'google', 'Identical']);
  });

  it('highlights outputs that differ from the baseline and marks a missing output', () => {
    const table = ws();
    // de-CH p-002: alpha is the baseline, bravo differs, charlie produced nothing.
    expect(rowValues(table, 4, 7)).toEqual(['de-CH', 'p-002', 'Levering binnen 5 werkdagen.', 'Lieferung innert 5 Arbeitstagen.', 'Lieferung innerhalb von 5 Werktagen.', '[no output]', 'no']);
    const changed = solidFill(table.getCell(4, 5));
    const missing = solidFill(table.getCell(4, 6));
    expect(solidFill(table.getCell(4, 4))).toBeUndefined();
    expect(changed).toBeDefined();
    expect(missing).toBeDefined();
    expect(changed).not.toBe(missing);
    expect(table.getCell(4, 6).font?.color?.argb).toBeDefined();

    // de-CH h-001: bravo equals the baseline, charlie differs.
    expect([4, 5, 6].map((c) => solidFill(table.getCell(2, c)))).toEqual([undefined, undefined, changed]);
    expect(table.getCell(2, 7).value).toBe('no');
  });

  it('leaves identical rows unhighlighted', () => {
    const table = ws();
    expect(table.getCell(5, 2).value).toBe('m-title');
    expect([4, 5, 6].map((c) => solidFill(table.getCell(5, c)))).toEqual([undefined, undefined, undefined]);
    expect(table.getCell(5, 7).value).toBe('yes');
  });

  it('takes the first provider that has an output as the baseline', async () => {
    const { book: shifted } = await writtenFrom((copy) => {
      copy.segment_diff = [{ locale: 'de-CH', segment_id: 's-1', source_text: 'bron', outputs: { [ALPHA]: null, [BRAVO]: 'eins', [CHARLIE]: 'eins' }, identical: true }];
    });
    const table = sheet(shifted, 'Segment_Diff');
    expect([4, 5, 6].map((c) => solidFill(table.getCell(2, c)) !== undefined)).toEqual([true, false, false]);
    expect(table.getCell(2, 4).value).toBe('[no output]');
    expect(table.getCell(2, 7).value).toBe('yes');
  });

  it('explains the highlighting in a legend below the table', () => {
    const table = ws();
    const legend = rowStartingWith(table, 'Legend');
    expect(legend).toBeGreaterThan(10);
    expect(String(table.getCell(legend + 2, 1).value)).toContain('Yellow');
    expect(String(table.getCell(legend + 3, 1).value)).toContain('[no output]');
  });
});

describe('workbook: text that looks like a formula', () => {
  it.each([
    ['=HYPERLINK("http://evil.example/x","click")', "'=HYPERLINK("],
    ['+31 20 123 4567', "'+31 20"],
    ['-2 °C bis 40 °C', "'-2 °C"],
    ['@SUM(1+1)*cmd|" /C calc"!A0', "'@SUM("],
    ['\t=1+1', "'\t=1+1"],
    ['\r=1+1', "'\r=1+1"],
  ])('cellText guards %j', (text, expectedStart) => {
    expect(cellText(text).startsWith(expectedStart)).toBe(true);
    expect(cellText(text)).toBe(`'${text}`);
  });

  it('leaves ordinary text untouched', () => {
    for (const text of ['', 'Industriepumpen', '450 m³/h', ' =spaced', 'a=b', '[no output]', '(document)', '€ 12,50', "'already quoted"]) {
      expect(cellText(text)).toBe(text);
    }
  });

  it('cuts text at Excel\'s cell limit with a visible marker and never splits a surrogate pair', () => {
    const long = cellText('x'.repeat(40_000));
    expect(long.length).toBe(32_767);
    expect(long.endsWith('…[truncated]')).toBe(true);
    const emoji = cellText('a'.repeat(32_754) + '😀' + 'b'.repeat(100));
    expect(emoji.length).toBeLessThanOrEqual(32_767);
    expect(emoji.endsWith('a…[truncated]')).toBe(true);
    expect(emoji).not.toContain('\ud83d');
  });

  it('writes a hostile segment, finding and provider name as plain text cells, with no formula anywhere', async () => {
    const hostile = {
      source: '+31 20 123 4567',
      alpha: '=HYPERLINK("http://evil.example/steal","click")',
      bravo: '-2+3',
      charlie: '@SUM(1+1)*cmd|" /C calc"!A0',
      fix: '=1+1',
    };
    const { book: out, dir: outDir } = await writtenFrom((copy) => {
      copy.providers = ['=evil', BRAVO, CHARLIE];
      copy.segment_diff = [{ locale: 'de-CH', segment_id: '=seg', source_text: hostile.source, outputs: { '=evil': hostile.alpha, [BRAVO]: hostile.bravo, [CHARLIE]: hostile.charlie }, identical: false }];
      copy.scores = copy.scores.map((s) => (s.provider === ALPHA ? { ...s, provider: '=evil' } : s));
      const finding = copy.findings[0];
      if (finding) finding.suggested_fix = hostile.fix;
    });

    const diff = sheet(out, 'Segment_Diff');
    expect(rowValues(diff, 1, 7)).toEqual(['Locale', 'Segment', 'Source', "'=evil", BRAVO, CHARLIE, 'Identical']);
    expect(rowValues(diff, 2, 6)).toEqual(['de-CH', "'=seg", `'${hostile.source}`, `'${hostile.alpha}`, `'${hostile.bravo}`, `'${hostile.charlie}`]);
    expect(sheet(out, 'Scores_by_Provider').getCell(2, 1).value).toBe("'=evil");
    expect(sheet(out, 'Findings_by_Provider').getCell(2, 10).value).toBe(`'${hostile.fix}`);

    for (const ws of out.worksheets) {
      ws.eachRow((row) =>
        row.eachCell((cell) => {
          expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
          expect(cell.formula).toBeUndefined();
        }),
      );
    }
    expect(diff.getCell(2, 4).type).toBe(ExcelJS.ValueType.String);

    // The JSON report keeps the original text; only the spreadsheet is guarded.
    const json = JSON.parse(await readFile(path.join(outDir, 'compare_report.json'), 'utf8')) as CompareReport;
    expect(json.segment_diff[0]?.outputs['=evil']).toBe(hostile.alpha);
  });

  it('does not write a formula for any cell of the normal workbook either', () => {
    for (const ws of book.worksheets) {
      ws.eachRow((row) => row.eachCell((cell) => expect(cell.type).not.toBe(ExcelJS.ValueType.Formula)));
    }
  });
});

describe('writeComparisonArtifacts', () => {
  it('creates the folder, writes both files and returns their relative paths', async () => {
    const target = path.join(await tempDir(), 'nested', 'deeper');
    const paths = await writeComparisonArtifacts(report, target);
    expect(paths).toEqual(['model_comparison.xlsx', 'compare_report.json']);
    const workbook = await readWorkbook(target);
    expect(workbook.worksheets).toHaveLength(4);
    const json: unknown = JSON.parse(await readFile(path.join(target, 'compare_report.json'), 'utf8'));
    expect(() => CompareReportSchema.parse(json)).not.toThrow();
  });

  it('writes a self-describing JSON: absolute output_dir and the artifact list', async () => {
    const target = await tempDir();
    await writeComparisonArtifacts({ ...report, output_dir: null, artifacts: [] }, target);
    const json = CompareReportSchema.parse(JSON.parse(await readFile(path.join(target, 'compare_report.json'), 'utf8')));
    expect(json.output_dir).toBe(path.resolve(target));
    expect(json.artifacts).toEqual(['model_comparison.xlsx', 'compare_report.json']);
  });

  it('is repeatable: a second write overwrites the first without error', async () => {
    const target = await tempDir();
    await writeComparisonArtifacts(report, target);
    await expect(writeComparisonArtifacts(report, target)).resolves.toEqual(['model_comparison.xlsx', 'compare_report.json']);
  });

  it('references the judge as a role, not as a candidate, in every candidate total', () => {
    const rows = sheet(book, 'Cost_Latency');
    const candidateAll = [5, 8, 11].map((r) => rows.getCell(r, 7).value);
    expect(candidateAll).toEqual([0.012, 0.0039, 0.0021]);
    expect(report.cost_latency.filter((r) => r.provider === JUDGE).map((r) => r.stage)).toEqual(['validation', 'backtranslation']);
  });
});
