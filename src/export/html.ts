/**
 * Self-contained HTML5 document of one locale (`<locale>/page.html`). Blocks are rebuilt from the segment metadata, every block
 * carries its `segment_id`, and all source text is treated as untrusted: text and attribute values are escaped, event-handler
 * attributes are dropped and script-capable URLs are replaced (see `safe.ts`).
 */
import type { PageJson, SegmentResult } from '../schemas/index.js';
import { escapeHtml, escapeHtmlAttr, plainText, renderInlineHtml } from '../util/inline.js';
import { buildBlocks, type Block, type ListItem, type TableRow } from './blocks.js';
import { firstH1, metaNotes, resolvedMeta, unresolvedMarker } from './model.js';
import { BLOCKED_URL, commentSafe, isActiveUrl, safeInline } from './safe.js';

type TableBlock = Extract<Block, { kind: 'table' }>;

/** Minimal styling so the page reads well when opened; review flags and unresolved segments stand out. */
const CSS_LINES = [
  'body{margin:0;background:#fff;color:#1b1b1b;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}',
  'main{max-width:48rem;margin:2rem auto;padding:0 1rem}',
  'h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.6em 0 .5em}',
  'table{border-collapse:collapse;margin:1rem 0;max-width:100%}',
  'th,td{border:1px solid #c9c9c9;padding:.35rem .65rem;text-align:left;vertical-align:top}',
  'thead th{background:#f1f1f1}',
  'figure{margin:1rem 0}img{max-width:100%;height:auto}',
  '.cta a{display:inline-block;padding:.5rem 1.1rem;border-radius:4px;background:#0b5cad;color:#fff;text-decoration:none}',
  '[data-review="true"]{border-left:3px solid #e0a800;padding-left:.6rem}',
  '.locale-error{padding:0 .3rem;border-radius:2px;background:#fde8e8;color:#9b1c1c;font-weight:600}',
];

const pad = (level: number): string => '  '.repeat(level);

/** ` id`, `data-verdict` (when the segment was validated) and `data-review` (when a human must look at it). */
function blockAttrs(seg: SegmentResult): string {
  const verdict = seg.validation?.verdict;
  return [
    ` id="${escapeHtmlAttr(seg.segment_id)}"`,
    verdict ? ` data-verdict="${escapeHtmlAttr(verdict)}"` : '',
    seg.requires_human_review ? ' data-review="true"' : '',
  ].join('');
}

function contentHtml(seg: SegmentResult): string {
  const marker = unresolvedMarker(seg);
  if (marker) return `<span class="locale-error">${escapeHtml(marker)}</span>`;
  return renderInlineHtml(seg.final_text ?? '', safeInline(seg.inline));
}

/** ` href="…"`; a script-capable URL is replaced by `#` and kept, inert, in `data-blocked-href`. */
function hrefAttr(href: string): string {
  return isActiveUrl(href) ? ` href="${BLOCKED_URL}" data-blocked-href="${escapeHtmlAttr(href)}"` : ` href="${escapeHtmlAttr(href)}"`;
}

function srcAttr(src: string): string {
  return isActiveUrl(src, { image: true }) ? ` src="${BLOCKED_URL}" data-blocked-src="${escapeHtmlAttr(src)}"` : ` src="${escapeHtmlAttr(src)}"`;
}

function figureHtml(seg: SegmentResult): string {
  if (unresolvedMarker(seg) !== null) return `<figure${blockAttrs(seg)}>${contentHtml(seg)}</figure>`;
  const alt = plainText(seg.final_text ?? '');
  // An image block without a src cannot be an <img> (invalid HTML), so the alt text is kept visible as a caption.
  if (seg.src === undefined) return `<figure${blockAttrs(seg)}><figcaption>${escapeHtml(alt)}</figcaption></figure>`;
  return `<figure${blockAttrs(seg)}><img${srcAttr(seg.src)} alt="${escapeHtmlAttr(alt)}"></figure>`;
}

function anchorHtml(seg: SegmentResult): string {
  const inner = contentHtml(seg);
  const linked = seg.href === undefined || unresolvedMarker(seg) !== null ? inner : `<a${hrefAttr(seg.href)}>${inner}</a>`;
  return `<p class="cta"${blockAttrs(seg)}>${linked}</p>`;
}

/** One list level starting at `from`; deeper items become nested lists inside the preceding `<li>`. Returns the next unread index. */
function listLines(items: readonly ListItem[], from: number, depth: number, indent: number, groupId?: string): { lines: string[]; next: number } {
  const tag = (items[from] as ListItem).ordered ? 'ol' : 'ul';
  const group = groupId === undefined ? '' : ` data-group="${escapeHtmlAttr(groupId)}"`;
  const lines = [`${pad(indent)}<${tag}${group}>`];
  let i = from;
  while (i < items.length && (items[i] as ListItem).depth >= depth) {
    const item = items[i] as ListItem;
    const open = `<li${blockAttrs(item.seg)}>${contentHtml(item.seg)}`;
    i++;
    if (i < items.length && (items[i] as ListItem).depth > depth) {
      const nested = listLines(items, i, depth + 1, indent + 2, (items[i] as ListItem).seg.group?.id);
      lines.push(`${pad(indent + 1)}${open}`, ...nested.lines, `${pad(indent + 1)}</li>`);
      i = nested.next;
    } else {
      lines.push(`${pad(indent + 1)}${open}</li>`);
    }
  }
  lines.push(`${pad(indent)}</${tag}>`);
  return { lines, next: i };
}

function tableLines(block: TableBlock, indent: number): string[] {
  const cellHtml = (seg: SegmentResult | undefined, inHead: boolean): string => {
    if (!seg) return '<td></td>';
    if (seg.group?.header !== true) return `<td${blockAttrs(seg)}>${contentHtml(seg)}</td>`;
    return `<th scope="${inHead ? 'col' : 'row'}"${blockAttrs(seg)}>${contentHtml(seg)}</th>`;
  };
  const rowLines = (row: TableRow, inHead: boolean, level: number): string[] => [
    `${pad(level)}<tr>`,
    ...row.cells.map((cell) => `${pad(level + 1)}${cellHtml(cell, inHead)}`),
    `${pad(level)}</tr>`,
  ];
  const head = block.rows.slice(0, block.headerRows);
  const body = block.rows.slice(block.headerRows);
  const lines = [`${pad(indent)}<table data-group="${escapeHtmlAttr(block.groupId)}">`];
  if (head.length > 0) lines.push(`${pad(indent + 1)}<thead>`, ...head.flatMap((r) => rowLines(r, true, indent + 2)), `${pad(indent + 1)}</thead>`);
  if (body.length > 0) lines.push(`${pad(indent + 1)}<tbody>`, ...body.flatMap((r) => rowLines(r, false, indent + 2)), `${pad(indent + 1)}</tbody>`);
  lines.push(`${pad(indent)}</table>`);
  return lines;
}

function blockLines(block: Block, indent: number): string[] {
  switch (block.kind) {
    case 'heading':
      return [`${pad(indent)}<h${block.level}${blockAttrs(block.seg)}>${contentHtml(block.seg)}</h${block.level}>`];
    case 'paragraph':
      return [`${pad(indent)}<p${blockAttrs(block.seg)}>${contentHtml(block.seg)}</p>`];
    case 'figure':
      return [`${pad(indent)}${figureHtml(block.seg)}`];
    case 'anchor':
      return [`${pad(indent)}${anchorHtml(block.seg)}`];
    case 'list':
      return listLines(block.items, 0, 0, indent, block.groupId).lines;
    case 'table':
      return tableLines(block, indent);
  }
}

/** Structure-preserving, self-contained HTML document of one locale (lang attribute, title, meta description, hreflang). */
export function renderHtml(page: PageJson): string {
  const { locale } = page;
  const meta = resolvedMeta(locale);
  const title = meta.title ?? firstH1(locale) ?? 'Untitled';
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    ...(meta.description === null ? [] : [`<meta name="description" content="${escapeHtmlAttr(meta.description)}">`]),
    '<meta name="generator" content="locale-engine">',
    // No URLs are known at export time, so no <link rel="alternate" hreflang> can be emitted; the code travels in data-hreflang.
    `<!-- hreflang: ${commentSafe(locale.hreflang)} -->`,
    // Meta segments are not body blocks, so a failed or review-flagged title/description/slug is flagged here.
    ...metaNotes(locale).map(({ field, note }) => `<!-- ${field}: ${commentSafe(note)} -->`),
    '<style>',
    ...CSS_LINES.map((line) => `${pad(1)}${line}`),
    '</style>',
  ];
  const body = buildBlocks(locale.segments).flatMap((block) => blockLines(block, 2));
  return [
    '<!doctype html>',
    `<html lang="${escapeHtmlAttr(locale.target_locale)}" data-hreflang="${escapeHtmlAttr(locale.hreflang)}">`,
    '<head>',
    ...head.map((line) => `${pad(1)}${line}`),
    '</head>',
    '<body>',
    `${pad(1)}<main>`,
    ...body,
    `${pad(1)}</main>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
