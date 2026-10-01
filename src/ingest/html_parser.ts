/**
 * HTML -> typed blocks (spec §7 Phase 3). Pure: no network, nothing is executed, page text is never interpreted as instructions.
 *
 * Pipeline: read <head> metadata -> drop hidden / script-like junk -> drop boilerplate (nav, footer, aside, cookie banners …)
 * -> pick the main-content container (<main>/<article>/[role=main], else the smallest subtree that holds most of the text)
 * -> walk it in document order and emit `heading | paragraph | list_item | table_cell | alt | anchor` blocks whose text carries
 * inline markup as placeholders (format owned by `src/util/inline.ts`).
 *
 * Quality bar: dropping boilerplate is preferred over keeping it, but real content must survive. Three guards follow from that:
 *  - class/id based junk removal never removes an element that holds the page's <h1> or more than half of the text (layout wrappers
 *    such as `has-sidebar`, `modal-open`, ASP.NET's page-wide <form>);
 *  - a <header> that contains a heading (article headers, hero sections) is kept unless it also holds the site navigation;
 *  - when the page's <h1> was lost with a dropped element it is re-inserted as the first block.
 */
import { load } from 'cheerio';
import { EngineError } from '../util/errors.js';
import { INLINE_TAGS, type BlockType, type InlineTag, type InlineTagName, type SegmentGroup } from '../schemas/index.js';
import { escapeLiteral, plainText } from '../util/inline.js';
import {
  ancestors,
  attr,
  childElements,
  childNodes,
  hasDescendant,
  isElement,
  isText,
  textMass,
  type CheerioRoot,
  type DomElement,
  type DomNode,
} from './dom.js';

export type RawBlockType = Exclude<BlockType, 'meta'>;

export interface RawBlock {
  block_type: RawBlockType;
  /** Text with inline placeholders; literal `<`/`>` stored as `&lt;`/`&gt;`. */
  text: string;
  inline: Record<string, InlineTag>;
  level?: number;
  group?: SegmentGroup;
  href?: string;
  src?: string;
}

export interface ParsedHtml {
  /** `<html lang>` (or `xml:lang`, or `<meta http-equiv="content-language">`), trimmed, as written. */
  html_lang?: string;
  /** `<meta property="og:locale">`, as written. */
  og_locale?: string;
  title?: string;
  meta_description?: string;
  meta_keywords?: string;
  og_title?: string;
  og_description?: string;
  canonical?: string;
  /** Slug given by markdown front matter (never produced from HTML). */
  slug?: string;
  /** Plain text of the first level-1 heading of the extracted content. */
  h1?: string;
  blocks: RawBlock[];
  warnings: string[];
}

export interface ParseHtmlOptions {
  /** Used to make a relative `<link rel="canonical">` absolute. Everything else (hrefs, srcs) is kept verbatim. */
  baseUrl?: string;
  /** The input is a converted fragment (markdown, .docx), not a web page: no page chrome is expected, so no isolation warning. */
  fragment?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------

const INLINE_PLACEHOLDER_TAGS = new Set<string>(INLINE_TAGS);

/** Never content, wherever they are. */
const ALWAYS_REMOVE =
  'script, style, noscript, template, svg, iframe, object, embed, canvas, audio, video, select, textarea, input, datalist, dialog, ' +
  '[hidden], [aria-hidden="true"], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;

/** ARIA landmark equivalents of <nav>, <footer>, <aside>, <form role=search> and the site <header>. */
const JUNK_ROLES = new Set(['navigation', 'contentinfo', 'complementary', 'search', 'banner']);
const JUNK_CLASS = /cookie|consent|gdpr|banner|popup|modal|newsletter|breadcrumb|sidebar|share|social/i;

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'legend', 'li', 'main',
  'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
/** Blocks whose content is one run of inline text (unless they contain further blocks). */
const LEAF_TAGS = new Set(['p', 'pre', 'address', 'figcaption', 'summary', 'caption', 'dt', 'dd', 'li', 'legend']);
/** No content of their own. */
const SKIP_TAGS = new Set(['hr', 'head', 'title', 'meta', 'link', 'base', 'source', 'track', 'param']);
/** Generic wrappers the density descent may enter. */
const DESCENDABLE = new Set(['div', 'section', 'article', 'main', 'center']);
/** Non-semantic wrappers that may surround a call-to-action link. */
const LINK_WRAPPERS = new Set(['span', 'button', 'font']);

/** A semantic container is used only when it holds at least this share of the (cleaned) page text. */
const SEMANTIC_MIN_SHARE = 0.3;
/** The density descent enters a child only when it holds at least this share of its parent's text. */
const DESCENT_SHARE = 0.8;
/**
 * Real pages nest well below 300 levels. parse5 and every recursive walk degrade quadratically in the thousands and finally overflow
 * the stack, so a page nested deeper than this is refused up front (it is broken or hostile).
 */
const MAX_NESTING = 1000;
const NESTING_TAGS = new Set([
  'div', 'span', 'section', 'article', 'main', 'a', 'b', 'i', 'u', 'em', 'strong', 'small', 'font', 'center', 'blockquote', 'ul', 'ol', 'dl',
  'table', 'tbody', 'thead', 'tfoot', 'form', 'header', 'footer', 'nav', 'aside', 'figure', 'details', 'label', 'button', 'sup', 'sub', 'code',
  'mark', 'abbr',
]);
const FILENAME_ALT = /^[\w\- ]+\.(?:jpe?g|png|gif|webp|svg|avif|bmp|tiff?)$/i;

// ---------------------------------------------------------------------------------------------------------------
// Text and attribute helpers
// ---------------------------------------------------------------------------------------------------------------

/** Soft hyphens and zero-width spaces are invisible formatting hints; all other whitespace (incl. NBSP) becomes one space. */
export function collapseSpace(s: string): string {
  return s.replace(/[­​⁠﻿]/g, '').replace(/\s+/g, ' ');
}

function cleaned(s: string | undefined): string | undefined {
  const t = collapseSpace(s ?? '').trim();
  return t === '' ? undefined : t;
}

/**
 * `javascript:`, `vbscript:` and `data:` link targets are code, not links. Browsers ignore whitespace and control characters inside
 * the scheme, so those are stripped before testing.
 */
export function isUnsafeUrl(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000- \u007f-\u009f]+/g, '').toLowerCase();
  return /^(?:javascript|vbscript|data):/.test(v);
}

function usableHref(el: DomElement): string | undefined {
  const href = attr(el, 'href');
  if (href === undefined || href.trim() === '' || isUnsafeUrl(href)) return undefined;
  return href;
}

/** Attributes kept verbatim in the side table; `undefined` = an `<a>` without a usable target, which is flattened to its text. */
function inlineAttrs(el: DomElement): Record<string, string> | undefined {
  if (el.name === 'a') {
    const href = usableHref(el);
    if (href === undefined) return undefined;
    const attrs: Record<string, string> = { href };
    for (const name of ['title', 'target', 'rel']) {
      const v = attr(el, name);
      if (v !== undefined && v.trim() !== '') attrs[name] = v;
    }
    return attrs;
  }
  if (el.name === 'abbr') {
    const title = attr(el, 'title');
    return title !== undefined && title.trim() !== '' ? { title } : {};
  }
  return {};
}

// ---------------------------------------------------------------------------------------------------------------
// Inline content -> text with placeholders
// ---------------------------------------------------------------------------------------------------------------

type Tok =
  | { k: 'text'; s: string }
  | { k: 'open'; id: number; tag: InlineTagName; attrs: Record<string, string> }
  | { k: 'close'; id: number }
  /** `sep`: a separator inserted between block-level children, as opposed to a real <br>. */
  | { k: 'br'; id: number; sep: boolean };

interface Built {
  text: string;
  inline: Record<string, InlineTag>;
  images: DomElement[];
}

function trimTrailingSpace(toks: Tok[]): void {
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i] as Tok;
    if (t.k === 'br') return;
    if (t.k !== 'text') continue;
    if (t.s.endsWith(' ')) {
      const s = t.s.slice(0, -1);
      if (s === '') toks.splice(i, 1);
      else toks[i] = { k: 'text', s };
    }
    return;
  }
}

/** Drops the open/close tokens of pairs that enclose no visible text (the tokens in between stay). One linear pass. */
function removeEmptyPairs(toks: Tok[]): Tok[] {
  const stack: Array<{ id: number; hasText: boolean }> = [];
  const empty = new Set<number>();
  for (const t of toks) {
    if (t.k === 'open') stack.push({ id: t.id, hasText: false });
    else if (t.k === 'text') {
      const top = stack[stack.length - 1];
      if (top && t.s.trim() !== '') top.hasText = true;
    } else if (t.k === 'close') {
      const top = stack.pop();
      if (!top) continue;
      if (!top.hasText) empty.add(top.id);
      else {
        const parent = stack[stack.length - 1];
        if (parent) parent.hasText = true;
      }
    }
  }
  return empty.size === 0 ? toks : toks.filter((t) => !((t.k === 'open' || t.k === 'close') && empty.has(t.id)));
}

/** No line break at the start or end, and no separator right after another break. One linear pass. */
function tidyBreaks(toks: readonly Tok[]): Tok[] {
  const out: Tok[] = [];
  let seenText = false;
  let afterBreak = false;
  for (const t of toks) {
    if (t.k === 'text') {
      seenText = true;
      afterBreak = false;
      out.push(t);
    } else if (t.k === 'br') {
      if (!seenText || (afterBreak && t.sep)) continue;
      afterBreak = true;
      out.push(t);
    } else out.push(t);
  }
  let lastText = out.length - 1;
  while (lastText >= 0 && (out[lastText] as Tok).k !== 'text') lastText--;
  return out.filter((t, i) => !(t.k === 'br' && i > lastText));
}

function simplify(input: readonly Tok[]): Tok[] {
  const toks: Tok[] = [];
  let spaceBefore = true; // output so far ends with a space, a line break or nothing: a further leading space is redundant
  for (const t of input) {
    if (t.k === 'text') {
      const s: string = spaceBefore && t.s.startsWith(' ') ? t.s.slice(1) : t.s;
      if (s === '') continue;
      toks.push({ k: 'text', s });
      spaceBefore = s.endsWith(' ');
    } else if (t.k === 'br') {
      trimTrailingSpace(toks);
      toks.push(t);
      spaceBefore = true;
    } else toks.push(t);
  }
  trimTrailingSpace(toks);
  return tidyBreaks(removeEmptyPairs(toks));
}

/** Numbers placeholders `tag + n` in order of appearance (n unique per block) and builds the side table. */
function render(toks: readonly Tok[], images: DomElement[]): Built {
  const keys = new Map<number, string>();
  const inline: Record<string, InlineTag> = {};
  let n = 0;
  let text = '';
  for (const t of toks) {
    if (t.k === 'text') text += escapeLiteral(t.s);
    else if (t.k === 'open') {
      const key = `${t.tag}${++n}`;
      keys.set(t.id, key);
      inline[key] = { tag: t.tag, attrs: t.attrs };
      text += `<${key}>`;
    } else if (t.k === 'close') text += `</${keys.get(t.id) ?? ''}>`;
    else {
      const key = `br${++n}`;
      inline[key] = { tag: 'br', attrs: {} };
      text += `<${key}/>`;
    }
  }
  return { text, inline, images };
}

function buildInline(nodes: readonly DomNode[]): Built {
  const toks: Tok[] = [];
  const images: DomElement[] = [];
  let nextId = 0;
  const pushBreak = (sep: boolean): void => void toks.push({ k: 'br', id: ++nextId, sep });

  const visit = (node: DomNode): void => {
    if (isText(node)) {
      toks.push({ k: 'text', s: collapseSpace(node.data) });
      return;
    }
    if (!isElement(node)) return;
    const name = node.name;
    if (name === 'br') return pushBreak(false);
    if (name === 'img') {
      images.push(node);
      return;
    }
    if (SKIP_TAGS.has(name)) return;
    if (INLINE_PLACEHOLDER_TAGS.has(name)) {
      const attrs = inlineAttrs(node);
      if (attrs === undefined) return childNodes(node).forEach(visit);
      const id = ++nextId;
      toks.push({ k: 'open', id, tag: name as InlineTagName, attrs });
      childNodes(node).forEach(visit);
      toks.push({ k: 'close', id });
      return;
    }
    if (BLOCK_TAGS.has(name)) {
      pushBreak(true);
      childNodes(node).forEach(visit);
      pushBreak(true);
      return;
    }
    childNodes(node).forEach(visit);
  };
  nodes.forEach(visit);
  return render(simplify(toks), images);
}

function isEmpty(built: Built): boolean {
  return plainText(built.text).trim() === '';
}

// ---------------------------------------------------------------------------------------------------------------
// Block walker
// ---------------------------------------------------------------------------------------------------------------

interface WalkState {
  blocks: RawBlock[];
  lists: number;
  tables: number;
}

interface ListGroup {
  id: string;
  next: number;
}

function altBlock(img: DomElement): RawBlock | undefined {
  const role = attr(img, 'role');
  if (role === 'presentation' || role === 'none') return undefined;
  const alt = cleaned(attr(img, 'alt'));
  if (alt === undefined || FILENAME_ALT.test(alt)) return undefined;
  let src = attr(img, 'src');
  if (src === undefined || src.trim() === '' || src.startsWith('data:')) {
    // lazy-loading placeholders keep the real image in a data attribute
    src = attr(img, 'data-src') ?? attr(img, 'data-lazy-src') ?? attr(img, 'data-original') ?? src;
  }
  const block: RawBlock = { block_type: 'alt', text: escapeLiteral(alt), inline: {} };
  if (src !== undefined && src.trim() !== '') block.src = src;
  return block;
}

function pushImages(st: WalkState, images: readonly DomElement[]): void {
  for (const img of images) {
    const block = altBlock(img);
    if (block) st.blocks.push(block);
  }
}

/** Carries text or a link: whitespace, line breaks and images do not count (images become their own `alt` blocks). */
function meaningful(n: DomNode): boolean {
  if (isText(n)) return n.data.trim() !== '';
  return !(isElement(n) && (n.name === 'br' || n.name === 'img'));
}

/** The one `<a href>` a run consists of (optionally inside a non-semantic wrapper such as `<span>` or `<button>`). */
function soleLink(node: DomNode): DomElement | undefined {
  let cur: DomNode = node;
  for (let depth = 0; depth < 4; depth++) {
    if (!isElement(cur)) return undefined;
    if (cur.name === 'a') return usableHref(cur) !== undefined ? cur : undefined;
    if (!LINK_WRAPPERS.has(cur.name)) return undefined;
    const inner = childNodes(cur).filter(meaningful);
    if (inner.length !== 1) return undefined;
    cur = inner[0] as DomNode;
  }
  return undefined;
}

function emitAnchor(a: DomElement, st: WalkState): void {
  const built = buildInline(childNodes(a));
  if (!isEmpty(built)) st.blocks.push({ block_type: 'anchor', text: built.text, inline: built.inline, href: usableHref(a) ?? '' });
  pushImages(st, built.images);
}

/** A run of inline nodes that forms one block: a call-to-action link, or else a paragraph. */
function emitRun(nodes: readonly DomNode[], st: WalkState): void {
  const significant = nodes.filter(meaningful);
  if (significant.length === 1) {
    const only = significant[0] as DomNode;
    const link = soleLink(only);
    // a button without a link target is UI chrome, not page content
    if (link !== undefined || (isElement(only) && only.name === 'button')) {
      for (const n of nodes) {
        if (n !== only) pushImages(st, buildInline([n]).images);
        else if (link !== undefined) emitAnchor(link, st);
      }
      return;
    }
  }
  const built = buildInline(nodes);
  if (!isEmpty(built)) st.blocks.push({ block_type: 'paragraph', text: built.text, inline: built.inline });
  pushImages(st, built.images);
}

function hasBlockDescendant(el: DomElement): boolean {
  return hasDescendant(el, (e) => BLOCK_TAGS.has(e.name));
}

function startsBlock(el: DomElement): boolean {
  return BLOCK_TAGS.has(el.name) || hasBlockDescendant(el);
}

function walkChildren(parent: DomElement, st: WalkState): void {
  let run: DomNode[] = [];
  const flush = (): void => {
    if (run.length > 0) emitRun(run, st);
    run = [];
  };
  for (const child of childNodes(parent)) {
    if (isText(child)) run.push(child);
    else if (!isElement(child)) continue;
    else if (startsBlock(child)) {
      flush();
      emitBlock(child, st);
    } else run.push(child);
  }
  flush();
}

function emitHeading(el: DomElement, st: WalkState): void {
  const built = buildInline(childNodes(el));
  if (!isEmpty(built)) {
    st.blocks.push({ block_type: 'heading', level: Number(el.name.slice(1)), text: built.text, inline: built.inline });
  }
  pushImages(st, built.images);
}

function emitListItem(li: DomElement, st: WalkState, depth: number, ordered: boolean, g: ListGroup): void {
  const own: DomNode[] = [];
  const nested: DomElement[] = [];
  for (const c of childNodes(li)) {
    if (isElement(c) && (c.name === 'ul' || c.name === 'ol' || c.name === 'menu' || c.name === 'table')) nested.push(c);
    else own.push(c);
  }
  const built = buildInline(own);
  if (!isEmpty(built)) {
    st.blocks.push({
      block_type: 'list_item',
      text: built.text,
      inline: built.inline,
      group: { kind: 'list', id: g.id, ordered, index: g.next++, depth },
    });
  }
  pushImages(st, built.images);
  for (const n of nested) {
    if (n.name === 'table') emitTable(n, st);
    else emitList(n, st, depth + 1, g);
  }
}

/** One group id per outermost list; nested items keep it and carry their own `depth` and `ordered`. */
function emitList(list: DomElement, st: WalkState, depth: number, group?: ListGroup): void {
  const ordered = list.name === 'ol';
  const g = group ?? { id: `${ordered ? 'ol' : 'ul'}-${++st.lists}`, next: 0 };
  for (const child of childElements(list)) {
    if (child.name === 'li') emitListItem(child, st, depth, ordered, g);
    else if (child.name === 'ul' || child.name === 'ol' || child.name === 'menu') emitList(child, st, depth + 1, g);
    else emitBlock(child, st);
  }
}

function collectRows(el: DomElement, inHead: boolean, out: Array<{ tr: DomElement; head: boolean }>): void {
  for (const child of childElements(el)) {
    if (child.name === 'tr') out.push({ tr: child, head: inHead });
    else if (child.name === 'thead' || child.name === 'tbody' || child.name === 'tfoot') {
      collectRows(child, inHead || child.name === 'thead', out);
    }
  }
}

/** Cells flatten everything they contain (nested lists and tables become line-separated text) so that one cell stays one segment. */
function emitTable(table: DomElement, st: WalkState): void {
  const id = `tbl-${++st.tables}`;
  const caption = childElements(table).find((c) => c.name === 'caption');
  if (caption) emitRun(childNodes(caption), st);
  const rows: Array<{ tr: DomElement; head: boolean }> = [];
  collectRows(table, false, rows);
  rows.forEach(({ tr, head }, row) => {
    let col = 0;
    for (const cell of childElements(tr)) {
      if (cell.name !== 'td' && cell.name !== 'th') continue;
      const built = buildInline(childNodes(cell));
      if (!isEmpty(built)) {
        st.blocks.push({
          block_type: 'table_cell',
          text: built.text,
          inline: built.inline,
          group: { kind: 'table', id, row, col, header: cell.name === 'th' || head },
        });
      }
      pushImages(st, built.images);
      col++;
    }
  });
}

function emitBlock(el: DomElement, st: WalkState): void {
  const name = el.name;
  if (SKIP_TAGS.has(name)) return;
  if (/^h[1-6]$/.test(name)) return emitHeading(el, st);
  if (name === 'ul' || name === 'ol' || name === 'menu') return emitList(el, st, 0);
  if (name === 'table') return emitTable(el, st);
  if (LEAF_TAGS.has(name) && !hasBlockDescendant(el)) return emitRun(childNodes(el), st);
  walkChildren(el, st);
}

// ---------------------------------------------------------------------------------------------------------------
// Boilerplate removal and container choice
// ---------------------------------------------------------------------------------------------------------------

function isHeadingEl(e: DomElement): boolean {
  return /^h[1-6]$/.test(e.name);
}

function isNavEl(e: DomElement): boolean {
  return e.name === 'nav' || attr(e, 'role') === 'navigation';
}

/** Holds the page's headline or most of its text: junk-looking by name, but actually the layout. */
function isLayoutWrapper(el: DomElement, total: number): boolean {
  return hasDescendant(el, (e) => e.name === 'h1') || textMass(el) > total / 2;
}

function classAndId(el: DomElement): string {
  return `${attr(el, 'class') ?? ''} ${attr(el, 'id') ?? ''}`;
}

function shouldRemove(el: DomElement, total: number): boolean {
  const name = el.name;
  if (name === 'nav' || name === 'footer' || name === 'aside') return true;
  const role = attr(el, 'role')?.toLowerCase();
  if (role !== undefined && JUNK_ROLES.has(role)) return true;
  if (name === 'header') return !(hasDescendant(el, isHeadingEl) && !hasDescendant(el, isNavEl));
  if (name === 'form') return !isLayoutWrapper(el, total);
  if (name !== 'html' && name !== 'body' && JUNK_CLASS.test(classAndId(el))) return !isLayoutWrapper(el, total);
  return false;
}

function prune($: CheerioRoot, el: DomElement, total: number): void {
  for (const child of childElements(el)) {
    if (shouldRemove(child, total)) $(child).remove();
    else prune($, child, total);
  }
}

function removeAlwaysJunk($: CheerioRoot): void {
  $(ALWAYS_REMOVE).not('html, body').remove();
  $('[style]')
    .filter((_, el) => HIDDEN_STYLE.test(el.attribs['style'] ?? ''))
    .not('html, body')
    .remove();
}

function isBoilerplateAncestor(a: DomElement): boolean {
  if (a.name === 'nav' || a.name === 'footer' || a.name === 'aside' || a.name === 'form') return true;
  const role = attr(a, 'role')?.toLowerCase();
  if (role !== undefined && role !== 'banner' && JUNK_ROLES.has(role)) return true;
  return a.name !== 'html' && a.name !== 'body' && JUNK_CLASS.test(classAndId(a));
}

/** The page's first level-1 heading outside boilerplate, captured before pruning so it can be restored if pruning removes it. */
function captureHeading($: CheerioRoot): RawBlock | undefined {
  for (const el of $('h1').toArray()) {
    if (ancestors(el).some(isBoilerplateAncestor)) continue;
    const built = buildInline(childNodes(el));
    if (!isEmpty(built)) return { block_type: 'heading', level: 1, text: built.text, inline: built.inline };
  }
  return undefined;
}

function semanticCandidate($: CheerioRoot): DomElement | undefined {
  const mains = $('main, [role="main"]').toArray();
  const articles = $('article').toArray();
  const pool = mains.length > 0 ? mains : articles.length === 1 ? articles : [];
  let best: DomElement | undefined;
  let mass = 0;
  for (const el of pool) {
    const m = textMass(el);
    if (m > mass) {
      best = el;
      mass = m;
    }
  }
  return best;
}

/** Descends while one generic wrapper holds nearly all the text: the smallest subtree that contains the main content. */
function dominantContainer(body: DomElement): DomElement {
  let node = body;
  for (;;) {
    const total = textMass(node);
    if (total === 0) return node;
    let best: DomElement | undefined;
    let bestMass = 0;
    for (const child of childElements(node)) {
      const m = textMass(child);
      if (m > bestMass) {
        best = child;
        bestMass = m;
      }
    }
    if (best === undefined || !DESCENDABLE.has(best.name) || bestMass < DESCENT_SHARE * total) return node;
    node = best;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Head metadata
// ---------------------------------------------------------------------------------------------------------------

function readHead($: CheerioRoot, out: ParsedHtml, opts: ParseHtmlOptions): void {
  const content = (selector: string): string | undefined => cleaned($(selector).first().attr('content'));
  const htmlEl = $('html').first();
  const lang =
    cleaned(htmlEl.attr('lang')) ?? cleaned(htmlEl.attr('xml:lang')) ?? content('meta[http-equiv="content-language" i]');
  if (lang !== undefined) out.html_lang = lang;

  const headTitle = $('head title').first();
  const titleEl = headTitle.length > 0 ? headTitle : $('title').filter((_, e) => $(e).closest('svg').length === 0).first();
  const assign = <K extends 'title' | 'meta_description' | 'meta_keywords' | 'og_title' | 'og_description' | 'og_locale'>(
    key: K,
    value: string | undefined,
  ): void => {
    if (value !== undefined) out[key] = value;
  };
  assign('title', cleaned(titleEl.text()));
  assign('meta_description', content('meta[name="description" i]'));
  assign('meta_keywords', content('meta[name="keywords" i]'));
  assign('og_title', content('meta[property="og:title" i], meta[name="og:title" i]'));
  assign('og_description', content('meta[property="og:description" i], meta[name="og:description" i]'));
  assign('og_locale', content('meta[property="og:locale" i], meta[name="og:locale" i]'));

  const canonical = cleaned($('link[rel~="canonical" i]').first().attr('href'));
  if (canonical !== undefined) {
    let resolved = canonical;
    if (opts.baseUrl !== undefined) {
      try {
        resolved = new URL(canonical, opts.baseUrl).href;
      } catch {
        /* keep the value as written */
      }
    }
    out.canonical = resolved;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------

/** Net nesting of the tags that need an end tag, counted from the raw markup in one linear scan (script and style bodies skipped). */
function assertReasonableNesting(html: string): void {
  const lower = html.toLowerCase();
  const tag = /<(\/?)([a-z][a-z0-9-]*)[^>]*>/gi;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    const name = (m[2] ?? '').toLowerCase();
    if (m[1] === '' && (name === 'script' || name === 'style')) {
      const close = lower.indexOf(`</${name}`, tag.lastIndex);
      tag.lastIndex = close === -1 ? html.length : close;
      continue;
    }
    if (!NESTING_TAGS.has(name) || m[0].endsWith('/>')) continue;
    if (m[1] === '/') depth = Math.max(0, depth - 1);
    else if (++depth > MAX_NESTING) {
      throw new EngineError('INPUT_INVALID', `the page is nested too deeply to be read (more than ${MAX_NESTING} levels)`, { max_nesting: MAX_NESTING });
    }
  }
}

export function parseHtml(html: string, opts: ParseHtmlOptions = {}): ParsedHtml {
  assertReasonableNesting(html);
  try {
    return parseDocument(html, opts);
  } catch (e) {
    if (e instanceof RangeError) throw new EngineError('INPUT_INVALID', 'the page is nested too deeply to be read', undefined, e);
    throw e;
  }
}

function parseDocument(html: string, opts: ParseHtmlOptions): ParsedHtml {
  const $ = load(html);
  const out: ParsedHtml = { blocks: [], warnings: [] };
  readHead($, out, opts);

  const body = $('body').first().get(0) as DomElement | undefined;
  if (body === undefined) return out;

  removeAlwaysJunk($);
  const headline = captureHeading($);
  prune($, body, textMass(body));

  const semantic = semanticCandidate($);
  const bodyMass = textMass(body);
  let container: DomElement;
  let isolated = true;
  if (semantic !== undefined && textMass(semantic) >= SEMANTIC_MIN_SHARE * bodyMass) container = semantic;
  else {
    container = dominantContainer(body);
    isolated = container !== body;
  }

  const st: WalkState = { blocks: [], lists: 0, tables: 0 };
  walkChildren(container, st);
  if (headline !== undefined && !st.blocks.some((b) => b.block_type === 'heading' && b.level === 1)) st.blocks.unshift(headline);
  out.blocks = st.blocks;

  const first = st.blocks.find((b) => b.block_type === 'heading' && b.level === 1);
  if (first !== undefined) out.h1 = collapseSpace(plainText(first.text)).trim();

  if (st.blocks.length > 0) {
    if (!isolated && opts.fragment !== true) out.warnings.push('main content could not be isolated; the whole page body was used (navigation text may be included)');
    const words = st.blocks.reduce((n, b) => n + (plainText(b.text).trim().split(/\s+/).filter(Boolean).length), 0);
    if (words < 20) out.warnings.push(`very little text was extracted (${words} words); the page may render its content with JavaScript`);
  }
  return out;
}
