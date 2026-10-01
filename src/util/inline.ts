/**
 * Inline-markup codec — the ONLY place that knows how segment text encodes inline HTML (see `schemas/segment.ts`).
 *
 * Format:  `Bekijk onze <a1>centrifugaalpompen</a1> en <strong2>dompelpompen</strong2>.<br3/>`
 *   - paired placeholders `<tag><n>` … `</tag><n>`, self-closing `<tag><n>/>`; tag ∈ INLINE_TAGS, n unique per segment
 *   - literal `<` / `>` in prose are stored as `&lt;` / `&gt;` (nothing else is escaped; `&` stays `&`)
 *   - attributes (href, title…) live in the segment's `inline` map, never in the text
 */
import type { InlineTag } from '../schemas/segment.js';

const TAGS = 'a|strong|b|em|i|u|sup|sub|br|code|abbr|small|mark';

/** Global regex source for one placeholder token. Groups: 1 = "/" (closing), 2 = tag, 3 = n, 4 = "/" (self-closing). */
export const INLINE_TOKEN_SOURCE = `<(\\/?)(${TAGS})(\\d+)(\\/?)>`;

export type InlineToken =
  | { kind: 'text'; text: string; start: number; end: number }
  | { kind: 'open' | 'close' | 'self'; tag: string; n: number; key: string; raw: string; start: number; end: number };

/** `a` + 1 -> `a1` (the key into a segment's `inline` map). */
export function inlineKey(tag: string, n: number): string {
  return `${tag}${n}`;
}

/** Split text into text runs and placeholder tokens (offsets are UTF-16 indices into `text`). */
export function tokenizeInline(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  const re = new RegExp(INLINE_TOKEN_SOURCE, 'g');
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index), start: last, end: m.index });
    const closing = m[1] === '/';
    const selfClosing = m[4] === '/';
    const tag = m[2] ?? '';
    const n = Number(m[3]);
    const kind: 'open' | 'close' | 'self' = selfClosing ? 'self' : closing ? 'close' : 'open';
    out.push({ kind, tag, n, key: inlineKey(tag, n), raw: m[0], start: m.index, end: m.index + m[0].length });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last), start: last, end: text.length });
  return out;
}

export function escapeLiteral(s: string): string {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function unescapeLiteral(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Text without placeholders, with `&lt;`/`&gt;` decoded. This is what linters, detectors and word counters see. */
export function plainText(text: string): string {
  return plainTextWithMap(text).plain;
}

export interface PlainMap {
  /** The original placeholder-bearing text this map was built from. */
  source: string;
  plain: string;
  /** starts[i] / ends[i]: UTF-16 range in the ORIGINAL (placeholder-bearing) text that produced plain[i]. */
  starts: number[];
  ends: number[];
}

/** Like `plainText`, plus a per-character map back to the placeholder-bearing text (for span-scoped repair). */
export function plainTextWithMap(text: string): PlainMap {
  const starts: number[] = [];
  const ends: number[] = [];
  let plain = '';
  for (const tok of tokenizeInline(text)) {
    if (tok.kind !== 'text') continue;
    const re = /&lt;|&gt;/g;
    let last = 0;
    const push = (s: string, from: number) => {
      for (let i = 0; i < s.length; i++) {
        starts.push(from + i);
        ends.push(from + i + 1);
      }
      plain += s;
    };
    for (let m = re.exec(tok.text); m; m = re.exec(tok.text)) {
      if (m.index > last) push(tok.text.slice(last, m.index), tok.start + last);
      plain += m[0] === '&lt;' ? '<' : '>';
      starts.push(tok.start + m.index);
      ends.push(tok.start + m.index + m[0].length);
      last = m.index + m[0].length;
    }
    if (last < tok.text.length) push(tok.text.slice(last), tok.start + last);
  }
  return { source: text, plain, starts, ends };
}

/**
 * Expand [start, end) of placeholder-bearing text until every placeholder pair is either fully inside or fully outside, so that
 * replacing the span can never leave an unbalanced tag behind.
 */
export function balanceSpan(source: string, start: number, end: number): { start: number; end: number } {
  const toks = tokenizeInline(source).filter((t) => t.kind !== 'text') as Array<Extract<InlineToken, { kind: 'open' | 'close' | 'self' }>>;
  const opens = new Map<string, (typeof toks)[number]>();
  const closes = new Map<string, (typeof toks)[number]>();
  for (const t of toks) {
    if (t.kind === 'open') opens.set(t.key, t);
    else if (t.kind === 'close') closes.set(t.key, t);
  }
  let s = start;
  let e = end;
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of toks) {
      if (t.start < s || t.end > e) continue;
      if (t.kind === 'open') {
        const c = closes.get(t.key);
        if (c && c.end > e) {
          e = c.end;
          changed = true;
        }
      } else if (t.kind === 'close') {
        const o = opens.get(t.key);
        if (o && o.start < s) {
          s = o.start;
          changed = true;
        }
      }
    }
  }
  return { start: s, end: e };
}

/**
 * Map a span [start, end) of the PLAIN text to a span of the original text. Placeholders strictly at the span boundaries are
 * excluded; placeholders inside it are included, and the span is expanded so no placeholder pair is split (see `balanceSpan`).
 */
export function mapPlainSpan(map: PlainMap, start: number, end: number): { start: number; end: number } {
  if (map.plain.length === 0) return { start: 0, end: 0 };
  const s = Math.min(Math.max(start, 0), map.plain.length);
  const e = Math.min(Math.max(end, s), map.plain.length);
  if (s === e) {
    const at = s < map.starts.length ? (map.starts[s] ?? 0) : (map.ends[map.ends.length - 1] ?? 0);
    return { start: at, end: at };
  }
  const raw = { start: map.starts[s] ?? 0, end: map.ends[e - 1] ?? map.ends[map.ends.length - 1] ?? 0 };
  return balanceSpan(map.source, raw.start, raw.end);
}

/** Sorted multiset of placeholder tokens, e.g. `["close:a1","open:a1","self:br3"]`. */
export function placeholderSignature(text: string): string[] {
  return tokenizeInline(text)
    .filter((t) => t.kind !== 'text')
    .map((t) => `${t.kind}:${(t as { key: string }).key}`)
    .sort();
}

export interface InlineVerification {
  ok: boolean;
  /** Tokens present in the source but absent (or fewer) in the target. */
  missing: string[];
  /** Tokens present in the target but not in the source (invented or duplicated). */
  extra: string[];
  /** Nesting problems in the target (overlap, unclosed, unopened). */
  unbalanced: string[];
}

/** Check that every source placeholder survives exactly once in the target and the target is properly nested. Order may change. */
export function verifyInline(source: string, target: string): InlineVerification {
  const count = (sig: string[]) => {
    const m = new Map<string, number>();
    for (const s of sig) m.set(s, (m.get(s) ?? 0) + 1);
    return m;
  };
  const src = count(placeholderSignature(source));
  const tgt = count(placeholderSignature(target));
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [k, v] of src) {
    const t = tgt.get(k) ?? 0;
    for (let i = t; i < v; i++) missing.push(k);
  }
  for (const [k, v] of tgt) {
    const s = src.get(k) ?? 0;
    for (let i = s; i < v; i++) extra.push(k);
  }
  const unbalanced: string[] = [];
  const stack: string[] = [];
  for (const tok of tokenizeInline(target)) {
    if (tok.kind === 'open') stack.push(tok.key);
    else if (tok.kind === 'close') {
      const top = stack.pop();
      if (top !== tok.key) unbalanced.push(top === undefined ? `unopened </${tok.key}>` : `</${tok.key}> closes <${top}>`);
    }
  }
  for (const k of stack) unbalanced.push(`unclosed <${k}>`);
  return { ok: missing.length === 0 && extra.length === 0 && unbalanced.length === 0, missing, extra, unbalanced };
}

/** Remove all placeholders, keep inner text (no entity decoding). */
export function stripPlaceholders(text: string): string {
  return tokenizeInline(text)
    .filter((t): t is Extract<InlineToken, { kind: 'text' }> => t.kind === 'text')
    .map((t) => t.text)
    .join('');
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeHtmlAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function attrString(attrs: Record<string, string> | undefined): string {
  if (!attrs) return '';
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeHtmlAttr(v)}"`)
    .join('');
}

/**
 * Render segment text to an HTML fragment. Text is HTML-escaped; placeholders become real tags with the attributes from
 * `inline`. Unknown / unbalanced placeholders are dropped rather than emitted as broken markup.
 */
export function renderInlineHtml(text: string, inline: Record<string, InlineTag> = {}): string {
  const toks = tokenizeInline(text);
  const opened: string[] = [];
  let out = '';
  // Pre-compute which opens have a matching close so unbalanced ones are dropped.
  const closes = new Set(toks.filter((t) => t.kind === 'close').map((t) => (t as { key: string }).key));
  for (const t of toks) {
    if (t.kind === 'text') {
      out += escapeHtml(unescapeLiteral(t.text));
    } else if (t.kind === 'self') {
      const def = inline[t.key];
      out += `<${def?.tag ?? t.tag}${attrString(def?.attrs)} />`;
    } else if (t.kind === 'open') {
      if (!closes.has(t.key)) continue;
      const def = inline[t.key];
      opened.push(t.key);
      out += `<${def?.tag ?? t.tag}${attrString(def?.attrs)}>`;
    } else {
      const idx = opened.lastIndexOf(t.key);
      if (idx === -1) continue;
      opened.splice(idx, 1);
      out += `</${inline[t.key]?.tag ?? t.tag}>`;
    }
  }
  return out;
}

/** Render segment text to Markdown (links and emphasis native; other inline tags as HTML). */
export function renderInlineMarkdown(text: string, inline: Record<string, InlineTag> = {}): string {
  const toks = tokenizeInline(text);
  const closes = new Set(toks.filter((t) => t.kind === 'close').map((t) => (t as { key: string }).key));
  let out = '';
  for (const t of toks) {
    if (t.kind === 'text') {
      out += unescapeLiteral(t.text);
      continue;
    }
    const def = inline[t.key];
    const tag = def?.tag ?? t.tag;
    if (t.kind === 'self') {
      out += tag === 'br' ? '  \n' : '';
      continue;
    }
    if (t.kind === 'open' && !closes.has(t.key)) continue;
    const opening = t.kind === 'open';
    switch (tag) {
      case 'a':
        out += opening ? '[' : `](${def?.attrs?.['href'] ?? ''})`;
        break;
      case 'strong':
      case 'b':
        out += '**';
        break;
      case 'em':
      case 'i':
        out += '*';
        break;
      case 'code':
        out += '`';
        break;
      default:
        out += opening ? `<${tag}${attrString(def?.attrs)}>` : `</${tag}>`;
    }
  }
  return out;
}
