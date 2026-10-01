/**
 * `entity_preservation` (spec §4.4, DDR-003): multiset comparison of source and target entities of the rule's kinds.
 *  - numbers, amounts and numeric dates compare by VALUE (source read with the source language's convention, target with the target
 *    language's), so a correct separator reformat is not a failure (the `format` rule judges separators);
 *  - units, currencies, codes, brands, phones, URLs and e-mail addresses must survive as written (whitespace variants aside);
 *  - a number in the target that is in neither the source nor the market facts is a hallucinated figure.
 * A missing source entity is paired, when possible, with the unexplained target entity of the same class, so the finding can
 * point at the span to repair.
 */
import { evidenceTag } from '../../schemas/index.js';
import { brandForms, extractEntities, isNumeric, type Entity } from '../entities.js';
import { joinList, quote, violation, type RuleOutcome, type Violation } from '../draft.js';
import { numericKey } from '../numbers.js';
import type { RuleOf, SegmentView } from '../segment.js';

type Kind = RuleOf<'entity_preservation'>['kinds'][number];

function selected(e: Entity, kinds: ReadonlySet<Kind>): boolean {
  switch (e.kind) {
    case 'number':
    case 'currency':
    case 'date':
      return kinds.has('number');
    case 'unit':
      return kinds.has('number') || kinds.has('unit');
    default:
      return kinds.has(e.kind);
  }
}

const numClass = (e: Entity): string => (e.kind === 'date' ? 'date' : 'number');

function valueKey(e: Entity): string {
  if (e.kind === 'date') return `date|${e.value ?? e.raw}`;
  return `number|${e.number ? numericKey(e.number.parsed) : e.raw}`;
}

const exactKey = (e: Entity): string => `${valueKey(e)}|${e.unit ?? ''}|${e.currency ?? ''}`;
const textKey = (e: Entity): string => `${e.kind}|${e.raw.replace(/\s+/gu, ' ')}`;
/** Human-readable value, e.g. `1250` or `1.25`. */
const shownValue = (e: Entity): string => (e.number ? numericKey(e.number.parsed).replace(/^#/, '') : (e.value ?? e.raw));

function attributeProblem(s: Entity, t: Entity, numbersOn: boolean, unitsOn: boolean): string | null {
  if (s.kind === 'unit' && unitsOn && t.unit !== s.unit) {
    return t.unit ? `the unit ${quote(s.unit ?? '')} became ${quote(t.unit)}` : `the unit ${quote(s.unit ?? '')} was dropped`;
  }
  if (s.kind === 'currency' && numbersOn && t.currency !== s.currency) {
    return t.currency ? `the currency changed from ${s.currency} to ${t.currency}` : `the currency ${s.currency} was dropped`;
  }
  return null;
}

/** Salient entities for the PASS note: single-digit bare counts are verified like any other number but not named. */
function salient(entities: Entity[]): string[] {
  const named = entities.filter((e) => !(e.kind === 'number' && e.number && !e.number.parsed.opaque && e.number.parsed.frac === null && e.number.parsed.intDigits.length === 1));
  const list = named.length > 0 ? named : entities;
  return [...new Set(list.map((e) => e.raw.replace(/\s+/gu, ' ')))];
}

function factValueKeys(seg: SegmentView): Set<string> {
  const mf = seg.ctx.marketFacts;
  const texts = [mf?.delivery, mf?.lead_time, mf?.phone].filter((t): t is string => typeof t === 'string');
  const keys = new Set<string>();
  for (const text of texts) {
    const found = extractEntities(text, { lang: seg.ctx.profile.language, common: seg.ctx.common, brands: brandForms(seg.ctx.glossary) });
    for (const e of found) if (isNumeric(e)) keys.add(valueKey(e));
  }
  return keys;
}

export function evaluateEntities(rule: RuleOf<'entity_preservation'>, seg: SegmentView): RuleOutcome {
  const kinds = new Set(rule.kinds);
  const numbersOn = kinds.has('number');
  const unitsOn = kinds.has('unit');
  const source = seg.sourceEntities().filter((e) => selected(e, kinds));
  const target = seg.targetEntities().filter((e) => selected(e, kinds));
  const segmentId = seg.input.segment_id;
  const used = new Set<Entity>();
  const take = (pred: (t: Entity) => boolean): Entity | undefined => {
    const t = target.find((x) => !used.has(x) && pred(x));
    if (t) used.add(t);
    return t;
  };
  const violations: Violation[] = [];
  const at = (t: Entity) => ({ span: seg.span(t.start, t.end), targetSpan: t.raw });

  // numeric entities: same value and attributes first, then same value only (attribute changes are findings)
  const numeric = source.filter(isNumeric);
  const pending = numeric.filter((s) => !take((t) => isNumeric(t) && exactKey(t) === exactKey(s)));
  const missing: Entity[] = [];
  for (const s of pending) {
    const t = take((x) => isNumeric(x) && valueKey(x) === valueKey(s));
    if (!t) {
      missing.push(s);
      continue;
    }
    const problem = attributeProblem(s, t, numbersOn, unitsOn);
    if (problem) {
      violations.push(violation(rule, { detail: `${quote(s.raw)}: ${problem} (${quote(t.raw)}).`, segmentId, ...at(t), sourceSpan: s.raw, fix: `Restore ${quote(s.raw)}.` }));
    }
  }

  // entities that must survive as written
  const verbatim = source.filter((e) => !isNumeric(e));
  const missingText = verbatim.filter((s) => !take((t) => !isNumeric(t) && textKey(t) === textKey(s)));

  const sourceValues = new Set(numeric.map(valueKey));
  const facts = numbersOn ? factValueKeys(seg) : new Set<string>();
  const extras = numbersOn ? target.filter((t) => !used.has(t) && isNumeric(t) && !sourceValues.has(valueKey(t)) && !facts.has(valueKey(t))) : [];
  const sourceTexts = new Set(verbatim.map(textKey));
  const spareText = target.filter((t) => !used.has(t) && !isNumeric(t) && !sourceTexts.has(textKey(t)));
  const paired = new Set<Entity>();
  const partner = (s: Entity, pool: Entity[], same: (t: Entity) => boolean): Entity | undefined => {
    const t = pool.find((x) => !paired.has(x) && same(x));
    if (t) paired.add(t);
    return t;
  };

  for (const s of [...missing, ...missingText]) {
    const t = isNumeric(s) ? partner(s, extras, (x) => numClass(x) === numClass(s)) : partner(s, spareText, (x) => x.kind === s.kind);
    const fix = `Restore ${quote(s.raw)}.`;
    if (!t) {
      violations.push(violation(rule, { detail: `${quote(s.raw)} from the source is missing in the target.`, segmentId, sourceSpan: s.raw, fix }));
    } else if (t.raw === s.raw && isNumeric(s)) {
      const detail = `${quote(s.raw)} means ${shownValue(s)} in the source but reads as ${shownValue(t)} in ${seg.ctx.target}.`;
      violations.push(violation(rule, { detail, segmentId, ...at(t), sourceSpan: s.raw, fix: `Write the value ${shownValue(s)} in the ${seg.ctx.target} convention.` }));
    } else {
      violations.push(violation(rule, { detail: `${quote(s.raw)} from the source is missing; the target has ${quote(t.raw)} instead.`, segmentId, ...at(t), sourceSpan: s.raw, fix }));
    }
  }
  for (const t of extras) {
    if (paired.has(t)) continue;
    const where = seg.ctx.marketFacts ? 'the source or the market facts' : 'the source';
    violations.push(violation(rule, { detail: `${quote(t.raw)} in the target does not occur in ${where}.`, segmentId, ...at(t), fix: `Remove ${quote(t.raw)} or restore the source figure.` }));
  }

  if (violations.length > 0 || source.length === 0) return { violations };
  // the evidence of a preserved entity is the segment itself (golden: `[EVIDENCE: p-003] 450 m³/h and 80 preserved.`)
  const tag = evidenceTag(segmentId.trim() !== '' ? segmentId : rule.id);
  return { violations, passNote: `${tag} ${joinList(salient(source))} preserved.` };
}
