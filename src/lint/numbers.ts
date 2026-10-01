/**
 * Number tokens (DDR-003, A-012): scanning, parsing with a language's separator convention, and writing a parsed number in a
 * target locale's convention. Values stay digit strings end to end, so nothing is ever rounded or re-grouped by accident.
 */
import { languageOf, type Formatting } from '../schemas/index.js';

type NumberFormat = Formatting['number'];

/** Separators that can only group thousands (Swiss apostrophes, spaces). */
const THOUSANDS_ONLY = new Set(["'", '’', ' ', ' ', ' ', ' ']);

export interface ParsedNumber {
  /** The token as written (a dash-decimal suffix included). */
  raw: string;
  /** Canonical value: integer digits, then `.` and the decimal digits as written (`1250.00`); `1250` without decimals. */
  value: string;
  intDigits: string;
  frac: string | null;
  /** A thousands separator is present. */
  grouped: boolean;
  /** `1.250,-` notation: no decimals, written with a dash. */
  dashDecimal: boolean;
  /** Distinct thousands separators as written. */
  thousandsSeps: string[];
  /** Decimal separator as written (also the separator in front of a dash-decimal), or null. */
  decimalSep: string | null;
  /** The dash of a dash-decimal as written (`-`, `–`, `—`, `--`). */
  dash: string | null;
  /**
   * Multi-digit integer part with a leading zero (`05`, `01.10`, `0800`). Such tokens are day-month pairs, codes or prefixes rather
   * than quantities: they are compared byte-identically and never reformatted.
   */
  opaque: boolean;
}

export const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

function isThousandsOnlySeparator(c: string | undefined): boolean {
  return c !== undefined && THOUSANDS_ONLY.has(c);
}

/** `.` or `,`: the decimal separator of the language (`en` writes `1,234.5`; nl/de/it write `1.234,5`). */
function languageDecimal(lang: string): '.' | ',' {
  return languageOf(lang) === 'en' ? '.' : ',';
}

function lastCodePointBefore(text: string, i: number): string {
  return Array.from(text.slice(Math.max(0, i - 2), i)).pop() ?? '';
}

/** A digit at `i` starts a number unless it is glued to a word (`m3`, `H2O`, `DN50`); `3x400` still counts as two numbers. */
export function canStartNumber(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = lastCodePointBefore(text, i);
  if (isDigit(prev)) return false;
  if (!/[\p{L}_]/u.test(prev)) return true;
  return (prev === 'x' || prev === 'X') && isDigit(text[i - 2]);
}

function dashLength(text: string, i: number): number {
  if (text.startsWith('--', i)) return 2;
  const c = text[i];
  return c === '-' || c === '–' || c === '—' ? 1 : 0;
}

/**
 * End (exclusive) of the number token starting at `start`: digit groups joined by `.` / `,` (any group size), or by apostrophes /
 * spaces in front of exactly three digits while the grouping so far is valid; optionally a dash-decimal suffix (`,-`, `.–`).
 */
export function readNumberEnd(text: string, start: number): number {
  let j = start;
  while (isDigit(text[j])) j++;
  const firstLen = j - start;
  const groupable = firstLen <= 3 && !(firstLen > 1 && text[start] === '0');
  let pointOrComma = false;
  while (j < text.length) {
    const c = text[j];
    if (c === '.' || c === ',') {
      if (isDigit(text[j + 1])) {
        j++;
        while (isDigit(text[j])) j++;
        pointOrComma = true;
        continue;
      }
      const dash = dashLength(text, j + 1);
      if (dash > 0 && !isDigit(text[j + 1 + dash])) j += 1 + dash;
      break;
    }
    const threeDigits = isDigit(text[j + 1]) && isDigit(text[j + 2]) && isDigit(text[j + 3]) && !isDigit(text[j + 4]);
    if (isThousandsOnlySeparator(c) && !pointOrComma && groupable && threeDigits) {
      j += 4;
      continue;
    }
    break;
  }
  return j;
}

function validGrouping(groups: string[]): boolean {
  const [first, ...rest] = groups;
  return first !== undefined && first.length >= 1 && first.length <= 3 && first !== '0' && rest.every((g) => g.length === 3);
}

/** Index into `seps` of the decimal separator; -1 when there is none; undefined when the token is contradictory. */
function decimalIndex(groups: string[], seps: string[], lang: string, dashSep: string | null): number | undefined {
  const marks = seps.flatMap((s, i) => (s === '.' || s === ',' ? [{ s, i }] : []));
  if (dashSep !== null) return marks.some((m) => m.s === dashSep) ? undefined : -1;
  const last = marks[marks.length - 1];
  if (last === undefined) return -1;
  const dots = marks.filter((m) => m.s === '.').length;
  if (dots > 0 && dots < marks.length) {
    // both `.` and `,`: the last one is the decimal separator and occurs once, the other one groups thousands
    const sameKind = marks.filter((m) => m.s === last.s).length;
    return sameKind === 1 && last.i === seps.length - 1 ? last.i : undefined;
  }
  if (seps.some((s) => THOUSANDS_ONLY.has(s))) {
    // apostrophes / spaces group the thousands, so a single point or comma after them is the decimal separator
    return marks.length === 1 && last.i === seps.length - 1 ? last.i : undefined;
  }
  if (marks.length > 1) return -1;
  const before = groups[last.i] ?? '';
  const after = groups[last.i + 1] ?? '';
  const couldGroup = after.length === 3 && before.length >= 1 && before.length <= 3 && !before.startsWith('0');
  if (!couldGroup) return last.i;
  // `1.250` / `1,250`: genuinely ambiguous, resolved with the convention of the text's language
  return last.s === languageDecimal(lang) ? last.i : -1;
}

/** Parse a number token with the separator convention of `lang`. Returns null for tokens that are not a well-formed number. */
export function parseNumber(raw: string, lang: string): ParsedNumber | null {
  const dashMatch = /([.,])(--|[-–—])$/.exec(raw);
  const body = dashMatch ? raw.slice(0, dashMatch.index) : raw;
  const groups: string[] = [];
  const seps: string[] = [];
  let cur = '';
  for (const ch of body) {
    if (isDigit(ch)) {
      cur += ch;
    } else {
      groups.push(cur);
      seps.push(ch);
      cur = '';
    }
  }
  groups.push(cur);
  if (groups.some((g) => g === '') || seps.some((s) => s !== '.' && s !== ',' && !THOUSANDS_ONLY.has(s))) return null;
  const dashSep = dashMatch?.[1] ?? null;
  const dash = dashMatch?.[2] ?? null;
  const first = groups[0] ?? '';
  if (first.length > 1 && first.startsWith('0')) {
    return { raw, value: body, intDigits: body, frac: null, grouped: false, dashDecimal: dash !== null, thousandsSeps: [], decimalSep: dashSep, dash, opaque: true };
  }
  const di = decimalIndex(groups, seps, lang, dashSep);
  if (di === undefined) return null;
  const intGroups = di === -1 ? groups : groups.slice(0, di + 1);
  const intSeps = di === -1 ? seps : seps.slice(0, di);
  if (intSeps.length > 0 && !validGrouping(intGroups)) return null;
  const intDigits = intGroups.join('');
  const frac = di === -1 ? null : (groups[di + 1] ?? null);
  return {
    raw,
    value: frac === null ? intDigits : `${intDigits}.${frac}`,
    intDigits,
    frac,
    grouped: intSeps.length > 0,
    dashDecimal: dash !== null,
    thousandsSeps: [...new Set(intSeps)],
    decimalSep: dashSep ?? (di === -1 ? null : (seps[di] ?? null)),
    dash,
    opaque: false,
  };
}

/** Comparison key: the numeric value regardless of trailing decimal zeros (`1250.00` = `1250`); opaque tokens compare as written. */
export function numericKey(p: ParsedNumber): string {
  if (p.opaque) return `#${p.raw}`;
  const int = p.intDigits.replace(/^0+(?=\d)/, '');
  const frac = (p.frac ?? '').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

function groupThousands(digits: string, sep: string): string {
  const parts: string[] = [];
  for (let e = digits.length; e > 0; e -= 3) parts.unshift(digits.slice(Math.max(0, e - 3), e));
  return parts.join(sep);
}

/**
 * The number in the target convention. Only existing separators are converted: grouping is kept exactly when the source grouped,
 * decimal digits are copied, a dash-decimal is kept (`keep`) or dropped (`drop`).
 */
export function formatNumber(p: ParsedNumber, fmt: NumberFormat): string {
  if (p.opaque) return p.raw;
  const int = p.grouped ? groupThousands(p.intDigits, fmt.thousands) : p.intDigits;
  if (p.frac !== null) return `${int}${fmt.decimal}${p.frac}`;
  if (p.dashDecimal && fmt.dash_decimal === 'keep') return `${int}${fmt.decimal}${p.dash ?? '-'}`;
  return int;
}

const SEPARATOR_NAMES: Record<string, string> = {
  '.': 'a full stop',
  ',': 'a comma',
  "'": 'an apostrophe',
  '’': 'a typographic apostrophe',
  ' ': 'a space',
  ' ': 'a no-break space',
  ' ': 'a narrow no-break space',
  ' ': 'a thin space',
};

export function describeSeparator(s: string): string {
  return SEPARATOR_NAMES[s] ?? `"${s}"`;
}

/** Why a written number does not follow `fmt` (empty when it does). Opaque tokens are never judged. */
export function numberProblems(p: ParsedNumber, fmt: NumberFormat): string[] {
  if (p.opaque) return [];
  const out: string[] = [];
  for (const s of p.thousandsSeps) if (!fmt.accepted_thousands.includes(s)) out.push(`${describeSeparator(s)} as thousands separator`);
  if (p.decimalSep !== null && p.decimalSep !== fmt.decimal) out.push(`${describeSeparator(p.decimalSep)} as decimal separator`);
  if (p.dashDecimal && fmt.dash_decimal === 'drop') out.push('the dash-decimal notation, which this locale does not use');
  return out;
}
