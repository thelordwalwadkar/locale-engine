/**
 * Turns the flat, ordered segment list of a locale into the block structure the Markdown and HTML renderers share: list items
 * become (possibly nested) lists, table cells become tables. Meta segments are page metadata, not body content, and are skipped.
 */
import type { SegmentGroup, SegmentResult } from '../schemas/index.js';
import { bySourceOrder } from './model.js';

export interface ListItem {
  seg: SegmentResult;
  /** 0 = top level; never more than one level deeper than the item before it, so the nesting is always well formed. */
  depth: number;
  ordered: boolean;
}

export interface TableRow {
  /** Dense: a position without a segment is `undefined`. */
  cells: Array<SegmentResult | undefined>;
}

export type Block =
  | { kind: 'heading'; seg: SegmentResult; level: number }
  | { kind: 'paragraph'; seg: SegmentResult }
  | { kind: 'figure'; seg: SegmentResult }
  | { kind: 'anchor'; seg: SegmentResult }
  | { kind: 'list'; groupId: string | undefined; items: ListItem[] }
  /** `headerRows` = number of leading rows made only of header cells (HTML `<thead>`; Markdown can show one). */
  | { kind: 'table'; groupId: string; rows: TableRow[]; headerRows: number };

/** Heading level used when a heading segment carries none (the segmenter always sets one; this only guards damaged input). */
const DEFAULT_HEADING_LEVEL = 2;

function listGroup(seg: SegmentResult): SegmentGroup | undefined {
  return seg.group?.kind === 'list' ? seg.group : undefined;
}

function tableGroup(seg: SegmentResult): SegmentGroup | undefined {
  return seg.block_type === 'table_cell' && seg.group?.kind === 'table' ? seg.group : undefined;
}

/**
 * A list run is the maximal stretch of consecutive list items that belong to one list: items of the same group id, plus nested
 * items (depth > 0) whatever id the segmenter gave the inner list. Two adjacent top-level lists have different ids and stay apart.
 */
function listRun(body: readonly SegmentResult[], start: number): SegmentResult[] {
  const rootId = listGroup(body[start] as SegmentResult)?.id ?? '';
  let end = start + 1;
  for (; end < body.length; end++) {
    const seg = body[end] as SegmentResult;
    if (seg.block_type !== 'list_item') break;
    const group = listGroup(seg);
    const nested = (group?.depth ?? 0) > 0;
    if (!nested && (group?.id ?? '') !== rootId) break;
  }
  return body.slice(start, end);
}

function listBlock(run: readonly SegmentResult[]): Block {
  let previousDepth = -1;
  const items = run.map((seg): ListItem => {
    const group = listGroup(seg);
    const depth = Math.min(group?.depth ?? 0, previousDepth + 1);
    previousDepth = depth;
    return { seg, depth, ordered: group?.ordered ?? false };
  });
  const rootId = listGroup(run[0] as SegmentResult)?.id;
  return { kind: 'list', groupId: rootId, items };
}

function tableBlock(groupId: string, cells: readonly SegmentResult[]): Block {
  const rows = new Map<number, SegmentResult[]>();
  let currentRow = 0;
  for (const seg of cells) {
    const group = tableGroup(seg);
    // Cells without coordinates are appended to the row that is being filled.
    const rowIndex = group?.row ?? currentRow;
    currentRow = rowIndex;
    const row = rows.get(rowIndex) ?? [];
    let col = group?.col ?? row.length;
    while (row[col] !== undefined) col++;
    row[col] = seg;
    rows.set(rowIndex, row);
  }
  const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => Array.from(row));
  const width = Math.max(0, ...ordered.map((row) => row.length));
  const tableRows = ordered.map((row): TableRow => ({ cells: Array.from({ length: width }, (_, i) => row[i]) }));

  let headerRows = 0;
  for (const row of tableRows) {
    const present = row.cells.filter((c): c is SegmentResult => c !== undefined);
    if (present.length === 0 || !present.every((c) => tableGroup(c)?.header === true)) break;
    headerRows++;
  }
  return { kind: 'table', groupId, rows: tableRows, headerRows };
}

/**
 * Body blocks of a locale in document order. A `table_cell` without table coordinates is rendered as a paragraph and a
 * `list_item` without list metadata as an unordered list, so damaged input is never dropped.
 */
export function buildBlocks(segments: readonly SegmentResult[]): Block[] {
  const body = bySourceOrder(segments).filter((seg) => seg.block_type !== 'meta');
  const blocks: Block[] = [];
  let i = 0;
  while (i < body.length) {
    const seg = body[i] as SegmentResult;
    if (seg.block_type === 'list_item') {
      const run = listRun(body, i);
      blocks.push(listBlock(run));
      i += run.length;
      continue;
    }
    const table = tableGroup(seg);
    if (table) {
      let end = i + 1;
      while (end < body.length && tableGroup(body[end] as SegmentResult)?.id === table.id) end++;
      blocks.push(tableBlock(table.id, body.slice(i, end)));
      i = end;
      continue;
    }
    switch (seg.block_type) {
      case 'heading':
        blocks.push({ kind: 'heading', seg, level: Math.min(6, Math.max(1, seg.level ?? DEFAULT_HEADING_LEVEL)) });
        break;
      case 'alt':
        blocks.push({ kind: 'figure', seg });
        break;
      case 'anchor':
        blocks.push({ kind: 'anchor', seg });
        break;
      default:
        blocks.push({ kind: 'paragraph', seg });
    }
    i++;
  }
  return blocks;
}
