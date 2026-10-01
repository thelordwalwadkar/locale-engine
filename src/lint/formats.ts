/**
 * Locale formatting of numbers, currency amounts and numeric dates (spec §4.4, DDR-003, A-012).
 *  - `normalizeFormats` rewrites the counterparts of SOURCE entities in the target to the target locale's convention and logs one
 *    FORMAT_CHANGE per difference. Only existing separators, the currency position/spacing/symbol and the numeric date shape change:
 *    digits, grouping, units and words never do.
 *  - `formatOffences` backs the `format` rule: every target token of an aspect must follow the locale's convention.
 */
import { languageOf, type CommonConfig, type Formatting, type ResolvedLocaleProfile, type Span } from '../schemas/index.js';
import { escapeLiteral, mapPlainSpan, plainText, plainTextWithMap, tokenizeInline } from '../util/inline.js';
import { brandForms, extractEntities, type CurrencyLayout, type Entity, type NumericDate } from './entities.js';
import { describeSeparator, formatNumber, numberProblems } from './numbers.js';
import type { FormatChangeDraft, FormatNormalization, LintContext, NormalizeFormatsInput } from './types.js';

type FormatAspect = 'number' | 'currency' | 'date';

const NBSP = ' ';

function aspectOf(e: Entity): FormatAspect | null {
  if (e.kind === 'currency') return 'currency';
  if (e.kind === 'date') return 'date';
  if (e.kind === 'number' || e.kind === 'unit') return 'number';
  return null;
}

/** The part of an entity its spelling refers to: the number token of a number / quantity, the whole amount or date otherwise. */
function spelledPart(e: Entity): { raw: string; start: number; end: number } {
  return aspectOf(e) === 'number' && e.number ? e.number : e;
}

/** The locale's `format` rule id for an aspect (stamped on every FORMAT_CHANGE of that aspect). */
function formatRuleId(profile: ResolvedLocaleProfile, aspect: FormatAspect): string {
  const rule = profile.effective_rules.find((r) => r.type === 'format' && r.aspect === aspect);
  return rule?.id ?? `FORMAT-${aspect.toUpperCase()}`;
}

function isAlphabetic(marker: string): boolean {
  return /^\p{L}+$/u.test(marker);
}

/** An amount in the locale's layout: symbol per `common.currency.symbols`, position, spacing (codes such as CHF always get a space). */
function currencyText(numberText: string, code: string, formatting: Formatting, common: CommonConfig): string {
  const cur = formatting.currency;
  const marker = common.currency.symbols[code] ?? code;
  const space = cur.space === 'nbsp' ? NBSP : ' ';
  const gap = isAlphabetic(marker) ? space : cur.space === 'none' ? '' : space;
  return cur.position === 'before' ? `${marker}${gap}${numberText}` : `${numberText}${gap}${marker}`;
}

function dateText(d: NumericDate, formatting: Formatting): string {
  const shape = formatting.date;
  const sep = shape.numeric.charAt(2);
  const pad = (s: string): string => (shape.zero_pad && s.length === 1 ? `0${s}` : s);
  return `${pad(d.day)}${sep}${pad(d.month)}${sep}${d.year}`;
}

/** Target-locale spelling of the entity's `spelledPart`, or null when the entity is never reformatted (opaque tokens, codes, …). */
function targetSpelling(e: Entity, formatting: Formatting, common: CommonConfig): string | null {
  const aspect = aspectOf(e);
  if (aspect === 'date') return e.date ? dateText(e.date, formatting) : null;
  const p = e.number?.parsed;
  if (aspect === null || !p || p.opaque) return null;
  const n = formatNumber(p, formatting.number);
  if (aspect === 'number') return n;
  return e.currency ? currencyText(n, e.currency, formatting, common) : null;
}

function layoutProblems(layout: CurrencyLayout, cur: Formatting['currency']): string[] {
  const out: string[] = [];
  if (layout.position !== cur.position && !cur.accept_alternate_position) {
    out.push(`"${layout.marker}" ${layout.position} the amount (this locale writes it ${cur.position} the amount)`);
  }
  const needsSpace = isAlphabetic(layout.marker) || cur.space !== 'none';
  if (needsSpace && layout.gap === '') out.push(`no space between "${layout.marker}" and the amount`);
  if (!needsSpace && layout.gap !== '') out.push(`a space between "${layout.marker}" and the amount`);
  return out;
}

interface FormatOffence {
  entity: Entity;
  /** The offending token (plain-text offsets). */
  part: { raw: string; start: number; end: number };
  problems: string[];
  expected: string;
}

/** Tokens of `aspect` checked against the locale convention, and the ones that do not follow it. */
export function formatOffences(entities: Entity[], aspect: FormatAspect, formatting: Formatting, common: CommonConfig): { checked: number; offences: FormatOffence[] } {
  let checked = 0;
  const offences: FormatOffence[] = [];
  for (const e of entities) {
    if (aspectOf(e) !== aspect) continue;
    const problems: string[] = [];
    if (e.date) {
      const sep = formatting.date.numeric.charAt(2);
      if (e.date.sep !== sep) problems.push(`${describeSeparator(e.date.sep)} between day, month and year (this locale writes ${formatting.date.numeric})`);
      if (formatting.date.zero_pad && (e.date.day.length < 2 || e.date.month.length < 2)) problems.push('a day or month without a leading zero');
    } else {
      const p = e.number?.parsed;
      if (!p || p.opaque) continue;
      problems.push(...numberProblems(p, formatting.number));
      if (e.layout) problems.push(...layoutProblems(e.layout, formatting.currency));
    }
    checked++;
    if (problems.length > 0) {
      offences.push({ entity: e, part: spelledPart(e), problems, expected: targetSpelling(e, formatting, common) ?? e.raw });
    }
  }
  return { checked, offences };
}

// ---------------------------------------------------------------------------------------------------------------
// Normaliser
// ---------------------------------------------------------------------------------------------------------------

function matchClass(e: Entity): string {
  if (e.kind === 'currency') return `currency:${e.currency ?? ''}`;
  return e.kind === 'date' ? 'date' : 'number';
}

/** Spelling a verbatim copy would have: the number token for numbers and amounts, the whole date. */
function verbatim(e: Entity): string {
  return e.kind === 'date' ? e.raw : (e.number?.raw ?? e.raw);
}

/** Same value written with the same digits, grouping and dash-decimal, only separators / layout may differ. */
function sameWrittenValue(s: Entity, t: Entity): boolean {
  if (s.kind === 'date' || t.kind === 'date') return s.value === t.value;
  const sp = s.number?.parsed;
  const tp = t.number?.parsed;
  return !!sp && !!tp && !tp.opaque && sp.value === tp.value && sp.grouped === tp.grouped && sp.dashDecimal === tp.dashDecimal;
}

/**
 * Counterpart of a source entity among the unused target entities of the same class. First tier: the model kept the source
 * spelling, or already wrote the target spelling (earliest occurrence wins, which keeps a second run stable when a target token is
 * both the copy of one source number and the conversion of another). Second tier: the same value in another spelling.
 */
function counterpart(s: Entity, expected: string, pool: Entity[], used: Set<Entity>): Entity | undefined {
  const candidates = pool.filter((t) => !used.has(t) && matchClass(t) === matchClass(s));
  return (
    candidates.find((t) => verbatim(t) === verbatim(s) || spelledPart(t).raw === expected) ?? candidates.find((t) => sameWrittenValue(s, t))
  );
}

function containsPlaceholder(text: string, span: Span): boolean {
  return tokenizeInline(text.slice(span.start, span.end)).some((t) => t.kind !== 'text');
}

/** Reformat separators / currency position / numeric dates of `target_text` to the target locale; logs one change per difference. */
export function normalizeFormats(input: NormalizeFormatsInput, ctx: Pick<LintContext, 'profile' | 'common' | 'glossary'>): FormatNormalization {
  const { profile, common } = ctx;
  const formatting = profile.formatting;
  const brands = brandForms(ctx.glossary);
  const sourceLang = input.source_lang || languageOf(input.source_locale);
  const sources = extractEntities(plainText(input.source_text), { lang: sourceLang, common, brands });
  const map = plainTextWithMap(input.target_text);
  const targets = extractEntities(map.plain, { lang: profile.language, common, brands }).filter((e) => aspectOf(e) !== null);
  const used = new Set<Entity>();
  const edits: Array<{ span: Span; text: string }> = [];
  const changes: FormatChangeDraft[] = [];

  for (const s of sources) {
    const expected = targetSpelling(s, formatting, common);
    const aspect = aspectOf(s);
    if (expected === null || aspect === null) continue;
    const t = counterpart(s, expected, targets, used);
    if (!t) continue; // unmatched source entities are left to the entity rule
    used.add(t);
    const from = spelledPart(s).raw;
    const part = spelledPart(t);
    const rule = formatRuleId(profile, aspect);
    if (part.raw === expected) {
      if (expected !== from) changes.push({ type: 'FORMAT_CHANGE', aspect, from, to: expected, rule, origin: 'llm' });
      continue;
    }
    const span = mapPlainSpan(map, part.start, part.end);
    if (containsPlaceholder(input.target_text, span)) continue; // never rewrite across inline markup; the format rule reports it
    edits.push({ span, text: escapeLiteral(expected) });
    const change: FormatChangeDraft = { type: 'FORMAT_CHANGE', aspect, from: expected === from ? part.raw : from, to: expected, rule, origin: 'deterministic' };
    if (part.raw !== from) change.note = `the model wrote "${part.raw}"`;
    changes.push(change);
  }

  let text = input.target_text;
  for (const e of [...edits].sort((a, b) => b.span.start - a.span.start)) {
    text = text.slice(0, e.span.start) + e.text + text.slice(e.span.end);
  }
  return { text, changes };
}
