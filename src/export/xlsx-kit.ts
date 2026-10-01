/**
 * House style for every worksheet the engine writes (the owner's Excel conventions): bold filled header row, frozen header row
 * (and frozen first columns where useful), autofilter over the data, content-based column widths capped at 60, wrapped text,
 * real numbers / dates / booleans as typed cells. An empty table still gets its header, filter and freeze, and no "none" row.
 */
import type ExcelJS from 'exceljs';

export type CellInput = string | number | boolean | Date | null | undefined;

/** ARGB colours (`FFRRGGBB`) for one cell. */
export interface CellStyle {
  fill?: string;
  font?: string;
}

export interface Column<Row> {
  header: string;
  value: (row: Row) => CellInput;
  numFmt?: string;
  /** Lower bound for the content-based width. */
  minWidth?: number;
  /** Colour-coding for one cell (verdicts, severities, unresolved markers). */
  style?: (row: Row, value: CellInput) => CellStyle | undefined;
}

export interface TableOptions {
  /** Row of the header; rows above it stay free for a block the caller writes itself. Default 1. */
  headerRow?: number;
  /** Number of columns frozen at the left. Default 0. */
  freezeColumns?: number;
}

const MIN_WIDTH = 8;
const MAX_WIDTH = 60;
/** Excel's hard limit is 32 767 characters per cell; a longer string makes Excel report the file as corrupt. */
const MAX_CELL_CHARS = 32_000;
const DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss';
const FONT = { name: 'Calibri', size: 11 };

/** First characters that make Excel read a cell as a formula once it is edited or exported to CSV (OWASP "formula injection"). */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Formula-injection guard, the ONE approach used by every tab. Cells are always written as plain string values (never as a
 * formula object), and a string that starts with `=`, `+`, `-`, `@`, TAB or CR gets a single leading space. Excel treats
 * " =1+1" as text even after the cell is edited or the sheet is saved as CSV, and unlike a leading apostrophe the guard does not
 * show up as a stray character. (exceljs cannot set the `quotePrefix` style that Excel's own apostrophe uses.)
 */
function guardFormula(text: string): string {
  return FORMULA_LEAD.test(text) ? ` ${text}` : text;
}

function clampLength(text: string): string {
  if (text.length <= MAX_CELL_CHARS) return text;
  let end = MAX_CELL_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // never cut a surrogate pair in half
  return `${text.slice(0, end)}… [truncated, ${text.length - end} more characters]`;
}

function solidFill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

/** Writes one value with the right cell type; `null`, `undefined` and the empty string leave the cell blank. */
export function putValue(cell: ExcelJS.Cell, value: CellInput, numFmt?: string): void {
  if (value === null || value === undefined || value === '') return;
  if (typeof value === 'string') {
    cell.value = clampLength(guardFormula(value));
  } else if (typeof value === 'number' && !Number.isFinite(value)) {
    cell.value = String(value); // Excel cannot store NaN / Infinity
  } else {
    cell.value = value;
    const format = numFmt ?? (value instanceof Date ? DATE_FORMAT : undefined);
    if (format) cell.numFmt = format;
  }
}

const HEADER_STYLE: Partial<ExcelJS.Style> = {
  font: { ...FONT, bold: true, color: { argb: 'FFFFFFFF' } },
  fill: solidFill('FF1F4E78'),
  alignment: { vertical: 'middle', wrapText: true },
  border: { bottom: { style: 'thin', color: { argb: 'FF0B2A45' } } },
};

/** Width in characters of the longest line a cell would show (wrapped text is measured per line). */
function displayLength(value: CellInput): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.split('\n').reduce((longest, line) => Math.max(longest, line.length), 0);
  if (value instanceof Date) return DATE_FORMAT.length;
  return String(value).length;
}

/** Writes a header row and the data below it, then applies freeze panes, autofilter and column widths. */
export function writeTable<Row>(ws: ExcelJS.Worksheet, columns: readonly Column<Row>[], rows: readonly Row[], opts: TableOptions = {}): void {
  const headerRow = opts.headerRow ?? 1;
  const freezeColumns = opts.freezeColumns ?? 0;

  const header = ws.getRow(headerRow);
  header.height = 22;
  columns.forEach((column, i) => {
    const cell = header.getCell(i + 1);
    cell.value = column.header;
    cell.style = HEADER_STYLE;
  });

  // Room for the filter button next to the header text.
  const widths = columns.map((column) => Math.max(column.minWidth ?? MIN_WIDTH, column.header.length + 4));
  rows.forEach((row, r) => {
    const excelRow = ws.getRow(headerRow + 1 + r);
    columns.forEach((column, i) => {
      const value = column.value(row);
      const cell = excelRow.getCell(i + 1);
      putValue(cell, value, column.numFmt);
      cell.alignment = { vertical: 'top', wrapText: true };
      const style = column.style?.(row, value);
      if (style?.fill) cell.fill = solidFill(style.fill);
      if (style?.font) cell.font = { ...FONT, color: { argb: style.font } };
      widths[i] = Math.max(widths[i] as number, displayLength(value) + 2);
    });
  });
  columns.forEach((_, i) => {
    ws.getColumn(i + 1).width = Math.min(MAX_WIDTH, widths[i] as number);
  });

  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow + rows.length, column: columns.length } };
  ws.views = [{ state: 'frozen', ySplit: headerRow, ...(freezeColumns > 0 ? { xSplit: freezeColumns } : {}) }];
}
