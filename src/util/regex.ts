/**
 * The regex dialect of the YAML rule files (see the header of `src/schemas/locale.ts`).
 *
 * JavaScript's `\b` is ASCII-only even with the `u` flag ("ä" counts as a non-word character), which silently breaks word
 * boundaries for German/Italian text. `expandPattern` rewrites every `\b` outside a character class into a real Unicode word
 * boundary so rule authors can keep writing `\b`.
 */

const W = '[\\p{L}\\p{N}_]';
/** A Unicode-aware `\b`. */
export const UNICODE_WORD_BOUNDARY = `(?:(?<!${W})(?=${W})|(?<=${W})(?!${W}))`;

/** Rewrite `\b` (outside character classes) to `UNICODE_WORD_BOUNDARY`. Escapes and classes are copied verbatim. */
export function expandPattern(source: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string;
    if (c === '\\') {
      const next = source[i + 1] ?? '';
      if (next === 'b' && !inClass) out += UNICODE_WORD_BOUNDARY;
      else out += c + next;
      i++;
      continue;
    }
    if (c === '[' && !inClass) inClass = true;
    else if (c === ']' && inClass) inClass = false;
    out += c;
  }
  return out;
}

/**
 * Compile a rule pattern. Flags: `u` and `g` are always set; `i` is set unless `flags` is given (then `flags` REPLACES the default
 * `i`, e.g. `flags: ''` makes a case-sensitive rule). Throws a descriptive error for an invalid pattern.
 */
export function compilePattern(source: string, flags?: string): RegExp {
  const user = (flags ?? 'i').replace(/[gu]/g, '');
  const f = `${[...new Set(user)].join('')}gu`;
  try {
    return new RegExp(expandPattern(source), f);
  } catch (e) {
    throw new Error(`invalid rule pattern /${source}/ (${f}): ${(e as Error).message}`);
  }
}

/** All matches of `re` in `text` as [start, end, match, groups] — safe for zero-length matches. */
export function matchAll(re: RegExp, text: string): Array<{ start: number; end: number; text: string; groups: string[] }> {
  const out: Array<{ start: number; end: number; text: string; groups: string[] }> = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (let m = r.exec(text); m; m = r.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], groups: m.slice(1).map((g) => g ?? '') });
    if (m[0].length === 0) r.lastIndex++;
  }
  return out;
}
