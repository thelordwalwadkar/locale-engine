/**
 * `model_comparison.xlsx` (spec §6.5 item 5). House style: bold filled header row, frozen header, autofilter over the table rows only,
 * wrapped text, real numbers as typed cells. Everything that is not a table row (best provider per locale, totals, notes) sits below the
 * table after a blank row, outside the filter range, so filtering or sorting the table never touches it.
 *
 * The workbook contains no formulas: every number is computed in TypeScript and written as a typed value.
 */
import ExcelJS from 'exceljs';
import type { CompareReport, Severity, Verdict } from '../schemas/index.js';
import { round } from '../util/text.js';
import {
  bestProviderPerLocale,
  costRole,
  countMissingOutputs,
  type BestProvider,
  type CompareCostRow,
  type CompareFindingRow,
  type CompareScoreRow,
  type CompareSegmentDiffRow,
} from './rows.js';

// ---------------------------------------------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------------------------------------------

const COLOR = {
  headerFill: 'FF1F4E78',
  headerFont: 'FFFFFFFF',
  /** A segment output that differs from the baseline output. */
  changed: 'FFFFF59D',
  /** A segment the provider produced no output for. */
  missing: 'FFFFCDD2',
  missingFont: 'FFB71C1C',
  total: 'FFEDEDED',
} as const;

export const VERDICT_FILL: Record<Verdict, string> = {
  PASS: 'FF81C784',
  PASS_WITH_NOTES: 'FFC8E6C9',
  HUMAN_REVIEW: 'FFFFD54F',
  FAIL: 'FFE57373',
};

export const SEVERITY_FILL: Record<Severity, string> = {
  critical: 'FFE57373',
  major: 'FFFFD54F',
  minor: 'FFFFF9C4',
};

const BASE_FONT = { name: 'Calibri', size: 11 } as const;
// ExcelJS treats a width of exactly 9 as the column default and does not store it, so narrow columns use 10.
const HEADER_HEIGHT = 32;
const LINE_HEIGHT = 15;
const MAX_ROW_HEIGHT = 409;
const NO_OUTPUT = '[no output]';
const COST_FORMAT = '$0.0000';

function solid(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

// ---------------------------------------------------------------------------------------------------------------
// Text guard
// ---------------------------------------------------------------------------------------------------------------

/** Excel rejects (and "repairs") a file with a cell longer than this. */
const EXCEL_MAX_CELL_CHARS = 32_767;
const TRUNCATION_MARK = '…[truncated]';
/** What makes a spreadsheet read a text cell as a formula (OWASP "CSV injection"): `=`, `+`, `-`, `@`, and a leading tab or carriage return. */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Every string that reaches a cell goes through here (headers built from provider refs included).
 *
 * Formula guard: ExcelJS writes a plain string as a string cell, never as a formula, so the file itself is safe. The guard covers what
 * happens once the data leaves the file: editing the cell (F2, Enter), "Save as CSV", copy-paste into another tool, where a leading
 * `= + - @` is executed. A leading apostrophe ("text follows") is prefixed; it stays visible in the cell, so the change is never silent,
 * and `compare_report.json` keeps the original text. Numbers are written as numbers and are not affected.
 *
 * Text longer than Excel's cell limit is cut with a visible marker; the JSON report keeps the full text.
 */
export function cellText(text: string): string {
  const guarded = FORMULA_TRIGGER.test(text) ? `'${text}` : text;
  if (guarded.length <= EXCEL_MAX_CELL_CHARS) return guarded;
  let end = EXCEL_MAX_CELL_CHARS - TRUNCATION_MARK.length;
  const last = guarded.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // never cut a surrogate pair in half
  return guarded.slice(0, end) + TRUNCATION_MARK;
}

// ---------------------------------------------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------------------------------------------

interface CellStyle {
  fill?: string;
  fontColor?: string;
  bold?: boolean;
}

interface Col<R> {
  header: string;
  /** Column width in characters; only read by `addTable` (blocks below a table reuse the table's columns). */
  width?: number;
  value: (row: R) => string | number | null;
  numFmt?: string;
  align?: 'left' | 'center' | 'right';
  /** false: no wrapping, so long text spills into the empty cells to its right. */
  wrap?: boolean;
  style?: (row: R) => CellStyle | undefined;
}

type RowStyle<R> = (row: R) => CellStyle | undefined;

function writeHeader<R>(ws: ExcelJS.Worksheet, rowIndex: number, cols: readonly Col<R>[]): void {
  const row = ws.getRow(rowIndex);
  row.height = HEADER_HEIGHT;
  cols.forEach((col, i) => {
    const cell = row.getCell(i + 1);
    cell.value = cellText(col.header);
    cell.font = { ...BASE_FONT, bold: true, color: { argb: COLOR.headerFont } };
    cell.fill = solid(COLOR.headerFill);
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
}

function writeBody<R>(ws: ExcelJS.Worksheet, firstRow: number, cols: readonly Col<R>[], rows: readonly R[], rowStyle?: RowStyle<R>): void {
  rows.forEach((data, r) => {
    const row = ws.getRow(firstRow + r);
    cols.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      const value = col.value(data);
      cell.value = typeof value === 'string' ? cellText(value) : value;
      if (col.numFmt) cell.numFmt = col.numFmt;
      cell.alignment = { vertical: 'top', wrapText: col.wrap !== false, ...(col.align ? { horizontal: col.align } : {}) };
      const style = { ...rowStyle?.(data), ...col.style?.(data) };
      cell.font = { ...BASE_FONT, ...(style.bold ? { bold: true } : {}), ...(style.fontColor ? { color: { argb: style.fontColor } } : {}) };
      if (style.fill) cell.fill = solid(style.fill);
    });
  });
}

/** Header in row 1, data from row 2, frozen header (+ `frozenColumns` leading columns), autofilter over exactly these rows. Returns the last table row. */
function addTable<R>(ws: ExcelJS.Worksheet, cols: readonly Col<R>[], rows: readonly R[], frozenColumns: number, rowStyle?: RowStyle<R>): number {
  cols.forEach((col, i) => {
    ws.getColumn(i + 1).width = col.width ?? 12;
  });
  writeHeader(ws, 1, cols);
  writeBody(ws, 2, cols, rows, rowStyle);
  ws.views = [{ state: 'frozen', xSplit: frozenColumns, ySplit: 1 }];
  const lastRow = rows.length + 1;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastRow, column: cols.length } };
  return lastRow;
}

function writeTitle(ws: ExcelJS.Worksheet, rowIndex: number, title: string): void {
  const cell = ws.getCell(rowIndex, 1);
  cell.value = cellText(title);
  cell.font = { ...BASE_FONT, bold: true };
}

/**
 * A titled block of full-width wrapped lines. Merged cells are not auto-sized by Excel, so the row height is estimated from the text
 * length and the width of the merged columns. Returns the next free row, after one blank row.
 */
function addTextBlock(ws: ExcelJS.Worksheet, firstRow: number, title: string, lines: readonly string[], span: number): number {
  writeTitle(ws, firstRow, title);
  let width = 0;
  for (let c = 1; c <= span; c++) width += ws.getColumn(c).width ?? 10;
  let row = firstRow + 1;
  for (const line of lines) {
    ws.mergeCells(row, 1, row, span);
    const cell = ws.getCell(row, 1);
    cell.value = cellText(line);
    cell.font = { ...BASE_FONT };
    cell.alignment = { vertical: 'top', wrapText: true };
    ws.getRow(row).height = Math.min(MAX_ROW_HEIGHT, LINE_HEIGHT * Math.max(1, Math.ceil(line.length / width)));
    row += 1;
  }
  return row + 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Scores_by_Provider
// ---------------------------------------------------------------------------------------------------------------

function decidedBy(best: BestProvider): string {
  if (best.decided_by === 'score') return 'highest score';
  const tie = `tie on score with ${best.tied_with.join(', ')}`;
  return best.decided_by === 'cost' ? `${tie}; lower candidate cost` : `${tie} and on cost; first listed`;
}

function buildScoresSheet(ws: ExcelJS.Worksheet, report: CompareReport): void {
  const withoutOutput = new Map(countMissingOutputs(report.segment_diff).map((c) => [JSON.stringify([c.provider, c.locale]), c.missing]));
  const judgeAvg = (pick: (avg: NonNullable<CompareScoreRow['judge_avg']>) => number) => (row: CompareScoreRow): number | null =>
    row.judge_avg ? pick(row.judge_avg) : null;
  const cols: Col<CompareScoreRow>[] = [
    { header: 'Provider', width: 28, value: (r) => r.provider },
    { header: 'Locale', width: 10, align: 'center', value: (r) => r.locale },
    { header: 'Quality score', width: 10, numFmt: '0.00', value: (r) => r.quality_score },
    { header: 'Verdict', width: 18, align: 'center', value: (r) => r.verdict, style: (r) => ({ fill: VERDICT_FILL[r.verdict], bold: true }) },
    { header: 'Penalty', width: 10, numFmt: '0.00', value: (r) => r.penalty },
    { header: 'Minor findings (open)', width: 11, numFmt: '0', value: (r) => r.findings_minor },
    { header: 'Major findings (open)', width: 11, numFmt: '0', value: (r) => r.findings_major },
    { header: 'Critical findings (open)', width: 11, numFmt: '0', value: (r) => r.findings_critical },
    { header: 'Judge accuracy', width: 10, numFmt: '0.0', value: judgeAvg((a) => a.accuracy) },
    { header: 'Judge fluency', width: 10, numFmt: '0.0', value: judgeAvg((a) => a.fluency) },
    { header: 'Judge terminology', width: 11, numFmt: '0.0', value: judgeAvg((a) => a.terminology) },
    { header: 'Judge locale conventions', width: 11, numFmt: '0.0', value: judgeAvg((a) => a.locale_conventions) },
    { header: 'Judge style & brand', width: 10, numFmt: '0.0', value: judgeAvg((a) => a.style_brand) },
    { header: 'Segments without output', width: 12, numFmt: '0', value: (r) => withoutOutput.get(JSON.stringify([r.provider, r.locale])) ?? 0 },
  ];
  let next = addTable(ws, cols, report.scores, 2) + 2;

  const best = bestProviderPerLocale(report.scores, report.cost_latency);
  if (best.length > 0) {
    // A provider can top the ranking while skipping segments (PROVIDER_ERROR); the score alone would hide that.
    const caution = (b: BestProvider): string => {
      const n = withoutOutput.get(JSON.stringify([b.provider, b.locale])) ?? 0;
      return n > 0 ? `; caution: ${n} segment${n === 1 ? '' : 's'} without output` : '';
    };
    const bestCols: Col<BestProvider>[] = [
      { header: 'Best provider', value: (b) => b.provider },
      { header: 'Locale', align: 'center', value: (b) => b.locale },
      { header: 'Quality score', numFmt: '0.00', value: (b) => b.quality_score },
      { header: 'Verdict', align: 'center', value: (b) => b.verdict, style: (b) => ({ fill: VERDICT_FILL[b.verdict], bold: true }) },
      { header: 'Candidate cost USD', numFmt: COST_FORMAT, value: (b) => b.cost_usd },
      { header: 'Decided by', wrap: false, align: 'left', value: (b) => decidedBy(b) + caution(b) },
    ];
    writeTitle(ws, next, 'Best provider per locale: highest quality score, a tie goes to the lower candidate cost (judge cost excluded)');
    writeHeader(ws, next + 1, bestCols);
    writeBody(ws, next + 2, bestCols, best);
    next += best.length + 3;
  }

  next = addTextBlock(
    ws,
    next,
    'About this comparison',
    [
      `Compare ID ${report.compare_id}, created ${report.created_at}`,
      `Source: ${report.source.origin_ref} (${report.source.source_locale}, ${report.source.segments} segments, ${report.source.words} words)`,
      `Judge, the same for every candidate: ${report.judge.provider} / ${report.judge.model}`,
      `Candidates: ${report.providers.join(', ')}`,
      `Locales compared: ${report.targets.join(', ') || 'none'}`,
    ],
    cols.length,
  );
  addTextBlock(ws, next, 'Notes', report.notes.length > 0 ? report.notes : ['None.'], cols.length);
}

// ---------------------------------------------------------------------------------------------------------------
// Findings_by_Provider
// ---------------------------------------------------------------------------------------------------------------

function buildFindingsSheet(ws: ExcelJS.Worksheet, report: CompareReport): void {
  const cols: Col<CompareFindingRow>[] = [
    { header: 'Provider', width: 28, value: (f) => f.provider },
    { header: 'Locale', width: 10, align: 'center', value: (f) => f.locale },
    { header: 'Segment', width: 12, value: (f) => f.segment_id ?? '(document)' },
    { header: 'Rule / category', width: 30, value: (f) => f.rule_or_category },
    { header: 'Severity', width: 10, align: 'center', value: (f) => f.severity, style: (f) => ({ fill: SEVERITY_FILL[f.severity] }) },
    { header: 'Evidence', width: 28, value: (f) => f.evidence },
    { header: 'Explanation', width: 60, value: (f) => f.explanation },
    { header: 'Source span', width: 30, value: (f) => f.source_span },
    { header: 'Target span', width: 30, value: (f) => f.target_span },
    { header: 'Suggested fix', width: 40, value: (f) => f.suggested_fix },
    { header: 'Origin', width: 14, value: (f) => f.origin },
    { header: 'Status', width: 10, align: 'center', value: (f) => f.status },
  ];
  addTable(ws, cols, report.findings, 2);
}

// ---------------------------------------------------------------------------------------------------------------
// Cost_Latency
// ---------------------------------------------------------------------------------------------------------------

interface CostView {
  provider: string;
  role: string;
  stage: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
}

const toCostView = (row: CompareCostRow): CostView => ({ ...row, role: costRole(row.stage) });

function sumCostViews(provider: string, role: string, rows: readonly CompareCostRow[]): CostView {
  const total = { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, latency_ms: 0 };
  for (const row of rows) {
    total.calls += row.calls;
    total.input_tokens += row.input_tokens;
    total.output_tokens += row.output_tokens;
    total.cost_usd += row.cost_usd;
    total.latency_ms += row.latency_ms;
  }
  return { provider, role, stage: 'all', ...total, cost_usd: round(total.cost_usd, 6), latency_ms: round(total.latency_ms, 3) };
}

function buildCostSheet(ws: ExcelJS.Worksheet, report: CompareReport): void {
  const cols: Col<CostView>[] = [
    { header: 'Provider', width: 30, value: (r) => r.provider },
    { header: 'Role', width: 11, align: 'center', value: (r) => r.role },
    { header: 'Stage', width: 18, value: (r) => r.stage },
    { header: 'Calls', width: 8, numFmt: '0', value: (r) => r.calls },
    { header: 'Input tokens', width: 14, numFmt: '#,##0', value: (r) => r.input_tokens },
    { header: 'Output tokens', width: 14, numFmt: '#,##0', value: (r) => r.output_tokens },
    { header: 'Cost USD', width: 12, numFmt: COST_FORMAT, value: (r) => r.cost_usd },
    { header: 'Latency ms (sum of calls)', width: 16, numFmt: '#,##0', value: (r) => r.latency_ms },
    { header: 'Avg latency ms per call', width: 16, numFmt: '#,##0', value: (r) => (r.calls > 0 ? round(r.latency_ms / r.calls, 1) : null) },
  ];
  const emphasise: RowStyle<CostView> = (r) => (r.stage === 'all' ? { bold: true, fill: COLOR.total } : undefined);
  let next = addTable(ws, cols, report.cost_latency.map(toCostView), 0, emphasise) + 2;

  const judgeRows = report.cost_latency.filter((r) => costRole(r.stage) === 'judge');
  const totals: CostView[] = [];
  const judgeLabel = judgeRows[0]?.provider;
  if (judgeLabel !== undefined) totals.push(sumCostViews(judgeLabel, 'judge', judgeRows));
  const t = report.totals;
  totals.push({
    provider: 'All calls in this comparison',
    role: 'all',
    stage: 'all',
    calls: t.calls,
    input_tokens: t.input_tokens,
    output_tokens: t.output_tokens,
    cost_usd: t.cost_usd,
    latency_ms: t.latency_ms,
  });
  writeTitle(ws, next, 'Totals');
  writeHeader(ws, next + 1, cols);
  writeBody(ws, next + 2, cols, totals, () => ({ bold: true, fill: COLOR.total }));
  next += totals.length + 3;

  const costNotes = report.notes.filter((n) => /^(?:JUDGE_COST_SHARED|PRICING_UNKNOWN):/.test(n));
  addTextBlock(
    ws,
    next,
    'How to read this sheet',
    [
      'Role candidate: translation, localization and repair, billed per candidate. The all row of a candidate totals these stages only.',
      'Role judge: validation and back-translation, done by the same fixed judge for every candidate. One shared bill, never part of a candidate total.',
      'Role pipeline: work that is the same for every candidate (language detection).',
      'Latency is the sum of call latencies. Calls overlap, so it is longer than the wall-clock time. Cost counts the calls with known pricing only.',
      ...costNotes,
    ],
    cols.length,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Segment_Diff
// ---------------------------------------------------------------------------------------------------------------

function buildDiffSheet(ws: ExcelJS.Worksheet, report: CompareReport): void {
  const outputOf = (row: CompareSegmentDiffRow, provider: string): string | null => row.outputs[provider] ?? null;
  /** The reference other outputs are compared with: the first provider (column order) that produced anything for the segment. */
  const baselineOf = (row: CompareSegmentDiffRow): string | null => report.providers.map((p) => outputOf(row, p)).find((text) => text !== null) ?? null;

  const providerCols = report.providers.map(
    (provider): Col<CompareSegmentDiffRow> => ({
      header: provider,
      width: 50,
      value: (row) => outputOf(row, provider) ?? NO_OUTPUT,
      style: (row) => {
        const text = outputOf(row, provider);
        if (text === null) return { fill: COLOR.missing, fontColor: COLOR.missingFont };
        return text === baselineOf(row) ? undefined : { fill: COLOR.changed };
      },
    }),
  );
  const cols: Col<CompareSegmentDiffRow>[] = [
    { header: 'Locale', width: 10, align: 'center', value: (r) => r.locale },
    { header: 'Segment', width: 12, value: (r) => r.segment_id },
    { header: 'Source', width: 50, value: (r) => r.source_text },
    ...providerCols,
    { header: 'Identical', width: 11, align: 'center', value: (r) => (r.identical ? 'yes' : 'no') },
  ];
  const last = addTable(ws, cols, report.segment_diff, 2);
  addTextBlock(
    ws,
    last + 2,
    'Legend',
    [
      'Identical: yes when every provider that produced an output gave exactly the same text.',
      'Yellow: the output differs from the first provider column that has an output for this segment.',
      `Red, ${NO_OUTPUT}: the provider produced no output for this segment (PROVIDER_ERROR or NOT_PROCESSED).`,
    ],
    cols.length,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------------------------------------------

/** Tabs in the order of spec §6.5 item 5. */
export function buildComparisonWorkbook(report: CompareReport): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'locale-engine';
  workbook.title = `Model comparison ${report.compare_id}`;
  const created = new Date(report.created_at);
  if (!Number.isNaN(created.getTime())) {
    workbook.created = created;
    workbook.modified = created;
  }
  buildScoresSheet(workbook.addWorksheet('Scores_by_Provider'), report);
  buildFindingsSheet(workbook.addWorksheet('Findings_by_Provider'), report);
  buildCostSheet(workbook.addWorksheet('Cost_Latency'), report);
  buildDiffSheet(workbook.addWorksheet('Segment_Diff'), report);
  return workbook;
}
