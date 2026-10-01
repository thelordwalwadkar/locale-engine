/**
 * Glossary (termbase) loading and hit detection.
 *
 * Hit detection is what feeds "injected glossary hits for the segment" into the prompts and what the `terminology` rule checks.
 * Matching is case-insensitive, Unicode-aware, tolerant to regular plurals (`-en`, `-s`, `-es`) and whitespace/hyphen variation in
 * multi-word terms. Forms shorter than 3 characters are ignored unless the term is do-not-translate.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { LOCALES, languageOf, type LocaleCode } from '../schemas/common.js';
import { GlossarySchema, type Glossary, type GlossaryEntry } from '../schemas/config.js';
import { EngineError } from '../util/errors.js';
import { escapeRegExp } from '../util/text.js';

export function parseGlossaryCsv(csv: string, file = 'glossary.csv'): Glossary {
  let rows: Record<string, string>[];
  try {
    rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }) as Record<string, string>[];
  } catch (e) {
    throw new EngineError('CONFIG_INVALID', `${file}: cannot parse CSV: ${(e as Error).message}`);
  }
  const entries: GlossaryEntry[] = rows.map((r) => {
    const forms: Partial<Record<LocaleCode, string[]>> = {};
    for (const loc of LOCALES) {
      const cell = r[loc] ?? '';
      const variants = cell
        .split('|')
        .map((v) => v.trim())
        .filter(Boolean);
      if (variants.length) forms[loc] = variants;
    }
    const dnt = (r['do_not_translate'] ?? '').trim().toLowerCase();
    const entry: GlossaryEntry = {
      term_id: (r['term_id'] ?? '').trim(),
      category: (r['category'] ?? '').trim(),
      do_not_translate: dnt === 'true' || dnt === 'yes' || dnt === '1',
      forms,
    };
    const notes = (r['notes'] ?? '').trim();
    if (notes) entry.notes = notes;
    const skipAfter = (r['skip_after'] ?? '').trim();
    if (skipAfter) entry.skip_after = skipAfter;
    const skipBefore = (r['skip_before'] ?? '').trim();
    if (skipBefore) entry.skip_before = skipBefore;
    return entry;
  });
  const parsed = GlossarySchema.safeParse(entries);
  if (!parsed.success) {
    throw new EngineError('CONFIG_INVALID', `${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const seen = new Set<string>();
  for (const e of parsed.data) {
    if (seen.has(e.term_id)) throw new EngineError('CONFIG_INVALID', `${file}: duplicate term_id ${e.term_id}`);
    seen.add(e.term_id);
  }
  return parsed.data;
}

export function loadGlossary(file: string): Glossary {
  return parseGlossaryCsv(readFileSync(file, 'utf8'), file);
}

// ---------------------------------------------------------------------------------------------------------------
// Hit detection
// ---------------------------------------------------------------------------------------------------------------

export interface GlossaryHit {
  term_id: string;
  category: string;
  do_not_translate: boolean;
  /** The glossary form that matched (source language). */
  source_form: string;
  /** The text as it appears in the segment. */
  matched: string;
  start: number;
  end: number;
  /** Target forms per locale; first = preferred. */
  targets: Partial<Record<LocaleCode, string[]>>;
  notes?: string;
}

const BOUND_START = '(?<![\\p{L}\\p{N}_])';
const BOUND_END = '(?![\\p{L}\\p{N}_])';

function formRegex(form: string, allowSuffix: boolean): RegExp {
  const body = escapeRegExp(form).replace(/\\?[  ]+/g, '[\\s\\u00a0]+').replace(/\\-/g, '[-\\s]?');
  const suffix = allowSuffix ? "(?:en|s|es|['’]s)?" : '';
  return new RegExp(`${BOUND_START}${body}${suffix}${BOUND_END}`, 'giu');
}

/** How much text around a hit the `skip_after` / `skip_before` disambiguation looks at. */
const CONTEXT_CHARS = 80;
const skipPatterns = new WeakMap<GlossaryEntry, { after?: RegExp; before?: RegExp }>();

/** True when the text around the hit shows the term is used in its other sense (see `GlossaryEntrySchema.skip_after`). */
function inOtherSense(entry: GlossaryEntry, text: string, start: number, end: number): boolean {
  if (entry.skip_after === undefined && entry.skip_before === undefined) return false;
  let p = skipPatterns.get(entry);
  if (!p) {
    p = {};
    if (entry.skip_after !== undefined) p.after = new RegExp(`^(?:${entry.skip_after})`, 'iu');
    if (entry.skip_before !== undefined) p.before = new RegExp(`(?:${entry.skip_before})$`, 'iu');
    skipPatterns.set(entry, p);
  }
  if (p.after?.test(text.slice(end, end + CONTEXT_CHARS))) return true;
  return p.before?.test(text.slice(Math.max(0, start - CONTEXT_CHARS), start)) === true;
}

/** Locales whose language equals `lang` (the glossary columns that hold SOURCE forms for a source in that language). */
function localesOfLanguage(lang: string): LocaleCode[] {
  return LOCALES.filter((l) => languageOf(l) === lang);
}

/**
 * Find glossary terms in `text`, a SOURCE-language string (`nl`, `en`, …). `text` should be plain text (placeholders removed) — the
 * caller passes `plainText(segment.text)`. Overlapping hits keep the longest match.
 */
export function findGlossaryHits(text: string, sourceLang: string, glossary: Glossary): GlossaryHit[] {
  const cols = localesOfLanguage(sourceLang);
  const hits: GlossaryHit[] = [];
  for (const entry of glossary) {
    const forms = new Set<string>();
    for (const c of cols) for (const f of entry.forms[c] ?? []) forms.add(f);
    for (const form of forms) {
      if (form.length < 3 && !entry.do_not_translate) continue;
      const re = formRegex(form, !entry.do_not_translate);
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (inOtherSense(entry, text, m.index, m.index + m[0].length)) {
          if (m[0].length === 0) re.lastIndex++;
          continue;
        }
        const hit: GlossaryHit = {
          term_id: entry.term_id,
          category: entry.category,
          do_not_translate: entry.do_not_translate,
          source_form: form,
          matched: m[0],
          start: m.index,
          end: m.index + m[0].length,
          targets: entry.forms,
        };
        if (entry.notes) hit.notes = entry.notes;
        hits.push(hit);
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }
  // resolve overlaps: longest first, then earliest
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: GlossaryHit[] = [];
  for (const h of hits) {
    if (kept.some((k) => h.start < k.end && k.start < h.end)) continue;
    // same term matched via several forms at different places is fine; same span is not
    kept.push(h);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export interface GlossaryPromptEntry {
  term_id: string;
  source: string;
  target: string;
  target_variants: string[];
  do_not_translate: boolean;
  notes?: string;
}

/** Hits reduced to what the prompt needs for ONE target locale (deduplicated by term id). */
export function glossaryHitsForPrompt(hits: GlossaryHit[], target: LocaleCode): GlossaryPromptEntry[] {
  const out = new Map<string, GlossaryPromptEntry>();
  for (const h of hits) {
    if (out.has(h.term_id)) continue;
    const variants = h.targets[target] ?? [];
    const entry: GlossaryPromptEntry = {
      term_id: h.term_id,
      source: h.source_form,
      target: variants[0] ?? h.source_form,
      target_variants: variants,
      do_not_translate: h.do_not_translate,
    };
    if (h.notes) entry.notes = h.notes;
    out.set(h.term_id, entry);
  }
  return [...out.values()];
}

/** All do-not-translate forms (brand names, abbreviations): entities that must survive byte-identical in every locale. */
export function doNotTranslateForms(glossary: Glossary): string[] {
  const forms = new Set<string>();
  for (const e of glossary) {
    if (!e.do_not_translate) continue;
    for (const variants of Object.values(e.forms)) for (const v of variants) forms.add(v);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}
