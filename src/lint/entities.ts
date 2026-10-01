/**
 * Deterministic entity extraction (ARCHITECTURE P2, DDR-003) on PLAIN text. Kinds are extracted in a fixed order and every match
 * consumes its span, so later kinds never match inside earlier ones:
 *   url, email, numeric date, phone, currency amount, product code, brand, number (+ adjacent symbol unit).
 * A number with a symbol unit is one entity of kind `unit` (`450 m³/h`); a bare number is kind `number`.
 */
import { doNotTranslateForms } from '../config/glossary.js';
import type { CommonConfig, Glossary } from '../schemas/index.js';
import { matchAll } from '../util/regex.js';
import { escapeRegExp } from '../util/text.js';
import { canStartNumber, isDigit, parseNumber, readNumberEnd, type ParsedNumber } from './numbers.js';
import { rulePattern } from './patterns.js';

type EntityKind = 'url' | 'email' | 'date' | 'phone' | 'currency' | 'product_code' | 'brand' | 'number' | 'unit';

interface NumberPart {
  raw: string;
  /** Plain-text offsets of the number token alone. */
  start: number;
  end: number;
  parsed: ParsedNumber;
}

export interface NumericDate {
  day: string;
  month: string;
  year: string;
  sep: string;
}

export interface CurrencyLayout {
  position: 'before' | 'after';
  /** Symbol or code as written (`€`, `CHF`, `EUR`). */
  marker: string;
  /** Whitespace between marker and number as written ('' when none). */
  gap: string;
}

export interface Entity {
  kind: EntityKind;
  raw: string;
  /** Plain-text offsets. */
  start: number;
  end: number;
  /** Canonical value: `ParsedNumber.value` for number / unit / currency, `d.m.y` for dates. */
  value?: string;
  /** Symbol unit of a `unit` entity. */
  unit?: string;
  /** ISO code of a `currency` entity. */
  currency?: string;
  /** The number token of a number / unit / currency entity. */
  number?: NumberPart;
  date?: NumericDate;
  layout?: CurrencyLayout;
}

interface ExtractOptions {
  /** Language whose separator convention resolves ambiguous numbers such as `1.250`. */
  lang: string;
  common: CommonConfig;
  /** Do-not-translate glossary forms (brands, abbreviations), longest first — see `brandForms`. */
  brands: readonly string[];
}

const MASK = '\u0000';
const GAP = new Set([' ', ' ', ' ', ' ']);
const WORD = /[\p{L}\p{N}_]/u;
const LETTER = /\p{L}/u;
/** Day and month of 1–2 digits, the same separator twice, a 2- or 4-digit year. */
const DATE_RE = /(?<![\p{L}\p{N}_])(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})(?!\p{N})/gu;

interface Marker {
  marker: string;
  code: string;
  alpha: boolean;
}
interface Tables {
  markers: Marker[];
  units: string[];
}
const tableCache = new WeakMap<CommonConfig, Tables>();
const brandCache = new WeakMap<Glossary, string[]>();

function tables(common: CommonConfig): Tables {
  let t = tableCache.get(common);
  if (!t) {
    const byMarker = new Map<string, string>();
    for (const [code, symbol] of Object.entries(common.currency.symbols)) byMarker.set(symbol, code);
    for (const code of Object.keys(common.currency.symbols)) if (!byMarker.has(code)) byMarker.set(code, code);
    const markers = [...byMarker].map(([marker, code]) => ({ marker, code, alpha: /^\p{L}+$/u.test(marker) }));
    markers.sort((a, b) => b.marker.length - a.marker.length);
    const units = [...new Set(common.entities.symbol_units)].sort((a, b) => b.length - a.length);
    t = { markers, units };
    tableCache.set(common, t);
  }
  return t;
}

/** Do-not-translate forms of the glossary, longest first (cached per glossary). */
export function brandForms(glossary: Glossary): string[] {
  let forms = brandCache.get(glossary);
  if (!forms) {
    forms = doNotTranslateForms(glossary);
    brandCache.set(glossary, forms);
  }
  return forms;
}

function codePointAt(text: string, i: number): string {
  const cp = text.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

function codePointBefore(text: string, i: number): string {
  return Array.from(text.slice(Math.max(0, i - 2), i)).pop() ?? '';
}

/** The plain text with consumed spans blanked out, so later kinds cannot match inside earlier ones. */
class Workspace {
  private readonly chars: string[];
  text: string;
  constructor(plain: string) {
    this.chars = plain.split('');
    this.text = plain;
  }
  take(start: number, end: number): void {
    for (let i = start; i < end; i++) this.chars[i] = MASK;
  }
  sync(): void {
    this.text = this.chars.join('');
  }
}

function validDate(day: string, month: string, year: string): boolean {
  const d = Number(day);
  const m = Number(month);
  if (d < 1 || d > 31 || m < 1 || m > 12) return false;
  // `2.5.10` reads as a version or section number; a two-digit year needs a zero-padded day and month (`30.09.26`)
  return year.length === 4 || (day.length === 2 && month.length === 2);
}

function currencyAround(text: string, start: number, end: number, markers: Marker[]): { start: number; end: number; code: string; layout: CurrencyLayout } | null {
  const gapBefore = GAP.has(text[start - 1] ?? '') ? (text[start - 1] as string) : '';
  const markEnd = start - gapBefore.length;
  for (const m of markers) {
    const ms = markEnd - m.marker.length;
    if (ms < 0 || text.slice(ms, markEnd) !== m.marker) continue;
    if (m.alpha && WORD.test(codePointBefore(text, ms))) continue;
    return { start: ms, end, code: m.code, layout: { position: 'before', marker: m.marker, gap: gapBefore } };
  }
  const gapAfter = GAP.has(text[end] ?? '') ? (text[end] as string) : '';
  const ms = end + gapAfter.length;
  for (const m of markers) {
    if (!text.startsWith(m.marker, ms)) continue;
    if (m.alpha && WORD.test(codePointAt(text, ms + m.marker.length))) continue;
    return { start, end: ms + m.marker.length, code: m.code, layout: { position: 'after', marker: m.marker, gap: gapAfter } };
  }
  return null;
}

function unitAt(text: string, pos: number, units: string[]): { unit: string; end: number } | null {
  const k = pos + (GAP.has(text[pos] ?? '') ? 1 : 0);
  for (const u of units) {
    if (text.startsWith(u, k) && !LETTER.test(codePointAt(text, k + u.length))) return { unit: u, end: k + u.length };
  }
  return null;
}

/**
 * Walk the number tokens of `text` (which may contain masked spans); `visit` returns where scanning continues. A token glued to a
 * word (`m3.5`, `X1.250`) is skipped whole, so its tail can never pass for a number of its own.
 */
function scanNumbers(text: string, visit: (start: number, end: number) => number, canStart = canStartNumber): void {
  let i = 0;
  while (i < text.length) {
    if (!isDigit(text[i])) {
      i++;
      continue;
    }
    const end = readNumberEnd(text, i);
    i = canStart(text, i) ? Math.max(visit(i, end), i + 1) : end;
  }
}

/** `EUR1.250`, `CHF1'250`: an alphabetic currency code may be glued to its amount. */
function afterGluedCode(markers: Marker[]): (text: string, i: number) => boolean {
  return (text, i) =>
    canStartNumber(text, i) ||
    markers.some((m) => m.alpha && i >= m.marker.length && text.slice(i - m.marker.length, i) === m.marker && !WORD.test(codePointBefore(text, i - m.marker.length)));
}

/** All entities of `plain`, sorted by position. Never throws on odd input; unparsable number tokens are opaque text. */
export function extractEntities(plain: string, opts: ExtractOptions): Entity[] {
  const ws = new Workspace(plain);
  const out: Entity[] = [];
  const cfg = opts.common.entities;
  const { markers, units } = tables(opts.common);
  const push = (e: Entity): void => {
    out.push(e);
    ws.take(e.start, e.end);
  };
  const byPattern = (source: string, kind: EntityKind, trim?: RegExp): void => {
    for (const m of matchAll(rulePattern(source, ''), ws.text)) {
      const end = m.start + (trim ? m.text.replace(trim, '') : m.text).length;
      if (end > m.start) push({ kind, raw: plain.slice(m.start, end), start: m.start, end });
    }
    ws.sync();
  };

  if (/https?:\/\/|www\./i.test(plain)) byPattern(cfg.url_pattern, 'url', /[.,;:!?]+$/u);
  if (plain.includes('@')) byPattern(cfg.email_pattern, 'email');

  for (const m of matchAll(DATE_RE, ws.text)) {
    const [day = '', sep = '', month = '', year = ''] = m.groups;
    if (!validDate(day, month, year)) continue;
    push({ kind: 'date', raw: m.text, start: m.start, end: m.end, value: `${Number(day)}.${Number(month)}.${Number(year)}`, date: { day, month, year, sep } });
  }
  ws.sync();

  for (const p of cfg.phone_patterns) byPattern(p, 'phone');

  const beforeCurrency = ws.text;
  scanNumbers(beforeCurrency, (start, end) => {
    const parsed = parseNumber(plain.slice(start, end), opts.lang);
    const hit = parsed ? currencyAround(ws.text, start, end, markers) : null;
    if (parsed && hit) {
      const number = { raw: plain.slice(start, end), start, end, parsed };
      push({ kind: 'currency', raw: plain.slice(hit.start, hit.end), start: hit.start, end: hit.end, value: parsed.value, currency: hit.code, number, layout: hit.layout });
      ws.sync();
    }
    return end;
  }, afterGluedCode(markers));

  // a code never ends with a hyphen: `N-3085-Pumpe` holds the code `N-3085`
  for (const p of cfg.product_code_patterns) byPattern(p, 'product_code', /-+$/u);

  for (const form of opts.brands) {
    if (!plain.includes(form.split(/\s+/u)[0] ?? form)) continue;
    const body = escapeRegExp(form).replace(/\s+/gu, '\\s+');
    byPattern(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'brand');
  }

  // After the brands ("ISO 9001" is a do-not-translate form): the number part of names and standard designations ("Industrie 4.0",
  // "EN 12845:2019") is opaque — never reformatted, compared verbatim.
  for (const p of cfg.protected_patterns ?? []) byPattern(p, 'product_code');

  const text = ws.text;
  scanNumbers(text, (start, end) => {
    const raw = plain.slice(start, end);
    const parsed = parseNumber(raw, opts.lang);
    if (!parsed) return end;
    const number = { raw, start, end, parsed };
    const unit = unitAt(text, end, units);
    if (unit) {
      out.push({ kind: 'unit', raw: plain.slice(start, unit.end), start, end: unit.end, value: parsed.value, unit: unit.unit, number });
      return unit.end;
    }
    out.push({ kind: 'number', raw, start, end, value: parsed.value, number });
    return end;
  });

  return out.sort((a, b) => a.start - b.start);
}

/** Entities that carry a numeric value (compared by value, reformatted by the normaliser). */
export function isNumeric(e: Entity): boolean {
  return e.kind === 'number' || e.kind === 'unit' || e.kind === 'currency' || e.kind === 'date';
}
