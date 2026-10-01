/**
 * Structure-preserving Markdown of one locale (`<locale>/page.md`): YAML front matter, then the body blocks in document order.
 * Only constructs that would change the BLOCK structure are escaped (a leading `#`, `-`, `1.`, `>`; `|` inside table cells; a raw
 * `<`). Inline punctuation is left alone so the file stays readable for the people who proof-read it.
 */
import { Document, isScalar } from 'yaml';
import type { InlineTag, PageJson, SegmentResult } from '../schemas/index.js';
import { plainText, renderInlineMarkdown, tokenizeInline } from '../util/inline.js';
import { round } from '../util/text.js';
import { buildBlocks, type Block, type TableRow } from './blocks.js';
import { NOT_VALIDATED_LABEL, isUnvalidated, metaNotes, resolvedMeta, unresolvedMarker } from './model.js';
import { BLOCKED_URL, commentSafe, isActiveUrl, safeInline } from './safe.js';

type ListBlock = Extract<Block, { kind: 'list' }>;
type TableBlock = Extract<Block, { kind: 'table' }>;

export interface EscapeOptions {
  /** Inside a GFM table cell, where `|` ends the cell. */
  cell?: boolean;
  /** Inside link text or image alt text, where brackets end it. */
  brackets?: boolean;
}

/** Escapes one run of plain text (no inline placeholders in it). */
function escapeRun(run: string, opts: EscapeOptions): string {
  let out = run
    // Newlines are not content (hard breaks are <br> placeholders) and a blank line would split the block.
    .replace(/\s*[\r\n]+\s*/g, ' ')
    // A backslash before punctuation would be read as an escape and vanish.
    .replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')
    // A literal "<" (stored as &lt;, or sloppy model output) must never become raw HTML.
    .replace(/&lt;|</g, '\\<');
  if (opts.cell) out = out.replace(/\|/g, '\\|');
  if (opts.brackets) out = out.replace(/[[\]]/g, '\\$&');
  return out;
}

/** Plain text (finding explanations, references) made safe to embed in a Markdown line or table cell. */
export function escapeMarkdownText(text: string, opts: EscapeOptions = {}): string {
  return escapeRun(text, opts);
}

/** Segment text with its inline placeholders left intact and only the text runs escaped. */
function escapeText(text: string, opts: EscapeOptions): string {
  return tokenizeInline(text)
    .map((tok) => (tok.kind === 'text' ? escapeRun(tok.text, opts) : tok.raw))
    .join('');
}

/** Inline code span that survives backticks in its content. */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Link destination: raw spaces, parentheses, angle brackets and pipes would end the link or table cell early. */
function markdownUrl(url: string): string {
  return url.replace(/[\s()<>|]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c)));
}

function markdownInline(inline: Record<string, InlineTag>): Record<string, InlineTag> {
  const safe = safeInline(inline);
  for (const def of Object.values(safe)) {
    const href = def.attrs['href'];
    if (href !== undefined) def.attrs['href'] = markdownUrl(href);
  }
  return safe;
}

function inlineOf(seg: SegmentResult, opts: EscapeOptions = {}): string {
  return renderInlineMarkdown(escapeText(seg.final_text ?? '', opts), markdownInline(seg.inline));
}

/** A rendered fragment as one physical line: the hard breaks `renderInlineMarkdown` emits become `<br>`. */
const oneLine = (markdown: string): string => markdown.replace(/ {2}\n/g, '<br>').trimEnd();

/** Backslash-escapes a leading character that would turn a line of text into another kind of block. */
function guardBlockStart(line: string): string {
  return line
    .trimStart()
    .replace(/^#{1,6}(?=\s|$)/, '\\$&')
    .replace(/^>/, '\\>')
    .replace(/^[-+*](?=\s|$)/, '\\$&')
    .replace(/^[-_*=](?=[-_*=\s]*$)/, '\\$&')
    .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
    .replace(/^(?=`{3}|~{3})/, '\\');
}

const review = (seg: SegmentResult): string => (seg.requires_human_review ? ` <!-- review: ${commentSafe(seg.segment_id)} -->` : '');

function headingMarkdown(seg: SegmentResult, level: number): string {
  const marker = unresolvedMarker(seg);
  if (marker) return `> ${marker}${review(seg)}`;
  return `${'#'.repeat(level)} ${oneLine(inlineOf(seg))}${review(seg)}`;
}

function paragraphMarkdown(seg: SegmentResult): string {
  const marker = unresolvedMarker(seg);
  if (marker) return `> ${marker}${review(seg)}`;
  const text = inlineOf(seg).split('\n').map(guardBlockStart).join('\n').trimEnd();
  return text === '' ? review(seg).trim() : `${text}${review(seg)}`;
}

function figureMarkdown(seg: SegmentResult): string {
  const marker = unresolvedMarker(seg);
  if (marker) return `> ${marker}${review(seg)}`;
  const alt = escapeRun(plainText(seg.final_text ?? ''), { brackets: true });
  const src = seg.src ?? '';
  return `![${alt}](${markdownUrl(isActiveUrl(src, { image: true }) ? BLOCKED_URL : src)})${review(seg)}`;
}

function anchorMarkdown(seg: SegmentResult): string {
  const marker = unresolvedMarker(seg);
  if (marker) return `> ${marker}${review(seg)}`;
  const text = oneLine(inlineOf(seg, { brackets: true }));
  if (seg.href === undefined) return `${guardBlockStart(text)}${review(seg)}`;
  return `[${text}](${markdownUrl(isActiveUrl(seg.href) ? BLOCKED_URL : seg.href)})${review(seg)}`;
}

function listMarkdown(block: ListBlock): string {
  const frames: Array<{ ordered: boolean; count: number; width: number }> = [];
  const lines: string[] = [];
  for (const { seg, depth, ordered } of block.items) {
    frames.length = Math.min(frames.length, depth + 1); // leaving a nested list closes it
    if (frames.length === depth) frames.push({ ordered, count: 0, width: 0 });
    const frame = frames[depth] as { ordered: boolean; count: number; width: number };
    frame.count++;
    const bullet = frame.ordered ? `${frame.count}.` : '-';
    frame.width = bullet.length + 1;
    // A nested item must start under the text of its parent item, whatever width the parent's marker has.
    const indent = frames
      .slice(0, depth)
      .map((f) => ' '.repeat(f.width))
      .join('');
    const text = unresolvedMarker(seg) ?? guardBlockStart(oneLine(inlineOf(seg)));
    lines.push(`${indent}${bullet} ${text}${review(seg)}`);
  }
  return lines.join('\n');
}

function tableMarkdown(block: TableBlock): string {
  const cell = (seg: SegmentResult | undefined): string => {
    if (!seg) return '';
    return `${unresolvedMarker(seg) ?? oneLine(inlineOf(seg, { cell: true }))}${review(seg)}`.trim();
  };
  const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  const width = block.rows[0]?.cells.length ?? 0;
  // GFM needs a header row: a table without one gets an empty header rather than promoting a data row.
  const hasHeader = block.headerRows > 0;
  const head = hasHeader ? (block.rows[0] as TableRow).cells.map(cell) : Array<string>(width).fill('');
  const body = block.rows.slice(hasHeader ? 1 : 0).map((r) => row(r.cells.map(cell)));
  return [row(head), row(Array<string>(width).fill('---')), ...body].join('\n');
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return headingMarkdown(block.seg, block.level);
    case 'paragraph':
      return paragraphMarkdown(block.seg);
    case 'figure':
      return figureMarkdown(block.seg);
    case 'anchor':
      return anchorMarkdown(block.seg);
    case 'list':
      return listMarkdown(block);
    case 'table':
      return tableMarkdown(block);
  }
}

/** YAML front matter; the `yaml` library does the quoting, so colons, quotes, `#` and look-alike scalars ("true", "123") survive. */
function frontMatter(page: PageJson, validationEnabled: boolean): string {
  const { locale } = page;
  const meta = resolvedMeta(locale);
  const doc = new Document({
    title: meta.title,
    description: meta.description,
    slug: meta.slug,
    hreflang: locale.hreflang,
    locale: locale.target_locale,
    verdict: locale.verdict,
    quality_score: isUnvalidated(locale, validationEnabled) ? NOT_VALIDATED_LABEL : round(locale.quality_score, 1),
    run_id: page.run_id,
    source_locale: page.source.source_locale,
  });
  // Meta segments are not body blocks, so a failed or review-flagged title/description/slug is flagged on its own line.
  for (const { field, note } of metaNotes(locale)) {
    const node = doc.get(field, true);
    if (isScalar(node)) node.comment = ` ${note.replace(/\s+/g, ' ')}`;
  }
  return `---\n${doc.toString({ lineWidth: 0 })}---`;
}

export interface MarkdownOptions {
  /**
   * `report.options.stages.validate`. A page.json carries no run options, so without this the front matter recognises a run that
   * skipped validation only by the locale's `NOT_VALIDATED` verdict reason. Default true.
   */
  validated?: boolean;
}

/** Structure-preserving Markdown of one locale. */
export function renderMarkdown(page: PageJson, opts: MarkdownOptions = {}): string {
  const blocks = buildBlocks(page.locale.segments);
  const body = blocks
    // Two lists that touch in the source would merge into one when the Markdown is rendered; an empty comment keeps them apart.
    .map((block, i) => (block.kind === 'list' && blocks[i - 1]?.kind === 'list' ? `<!-- -->\n\n${renderBlock(block)}` : renderBlock(block)))
    .filter((block) => block !== '');
  return `${[frontMatter(page, opts.validated ?? true), ...body].join('\n\n')}\n`;
}
