import { createHash } from 'node:crypto';
import { plainText } from './inline.js';

/** First 12 hex chars of sha1(text). Used for `segment.hash` and cache keys. */
export function hashText(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12);
}

/** Words = whitespace-delimited tokens of the PLAIN text (placeholders removed, `&lt;` decoded). */
export function wordCount(text: string): number {
  const p = plainText(text).trim();
  return p === '' ? 0 : p.split(/\s+/).length;
}

/** Number of Unicode code points (not UTF-16 units) of the plain text. Used by length rules (title <= 60). */
export function charLength(text: string): number {
  return Array.from(plainText(text)).length;
}

export function normalizeWhitespace(s: string): string {
  return s.replace(/[\s  ]+/g, ' ').trim();
}

/** Escape a string for literal use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whitespace-free runs longer than this are never prose (minified data, base64, …); skipping them keeps the scan linear. */
const MAX_WORD_LENGTH = 256;
const URL_LIKE = /^(?:https?:\/\/|www\.)/i;
const EMAIL_LIKE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * true when the text contains at least one natural-language word: letters only, >= 3 letters, not a known symbol unit.
 * Segments failing this (numbers, codes, units, URLs) skip the LLM and are only format-normalised.
 * Works token by token (whitespace-delimited) so that hostile input cannot trigger regex backtracking.
 */
export function hasNaturalLanguage(text: string, symbolUnits: readonly string[] = []): boolean {
  const units = new Set(symbolUnits.map((u) => u.toLowerCase()));
  for (const chunk of plainText(text).split(/\s+/)) {
    if (chunk.length === 0 || chunk.length > MAX_WORD_LENGTH) continue;
    const token = chunk.replace(/^[("'[<]+/, '');
    if (URL_LIKE.test(token) || EMAIL_LIKE.test(token)) continue;
    for (const t of token.split(/[^\p{L}\p{N}°³²µ%/'’-]+/u)) {
      if (/^\p{L}{3,}$/u.test(t) && !units.has(t.toLowerCase())) return true;
    }
  }
  return false;
}

/** Copy the capitalisation pattern of `sample` onto `replacement`: ALLCAPS -> upper, Capitalised -> capitalise first letter, else unchanged. */
export function matchCase(sample: string, replacement: string): string {
  if (sample === '' || replacement === '') return replacement;
  const letters = sample.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return replacement.toUpperCase();
  const first = sample.match(/\p{L}/u)?.[0];
  if (first && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/** Clamp to [min, max] and round to `digits` decimals. */
export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
