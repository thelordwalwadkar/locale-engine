import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { ruleApplies } from '../src/lint/engine.js';
import { applyAutofix, lintDocument, lintSegment, normalizeFormats, type LintContext, type LintSegmentInput } from '../src/lint/index.js';
import { DeterministicCheckSchema, FindingDraftSchema, LOCALES, type FindingDraft, type LocaleCode, type MarketFacts } from '../src/schemas/index.js';
import { placeholderSignature } from '../src/util/inline.js';

const cfg = loadConfig();

function ctxFor(target: LocaleCode, marketFacts?: MarketFacts): LintContext {
  return { target, profile: cfg.locales[target], common: cfg.common, glossary: cfg.glossary, thresholds: { back_translation_similarity_min: 0.4 }, ...(marketFacts ? { marketFacts } : {}) };
}
function seg(target_text: string, over: Partial<LintSegmentInput> = {}): LintSegmentInput {
  return { segment_id: 'p-001', block_type: 'paragraph', operation: 'TRANSLATE_LOCALIZE', source_text: '', source_lang: 'nl', source_locale: 'nl-NL', target_text, translatable: true, ...over };
}
const ids = (fs: FindingDraft[]) => fs.map((f) => f.rule_or_category);
const rule = (locale: LocaleCode, id: string) => {
  const r = cfg.locales[locale].effective_rules.find((x) => x.id === id);
  if (!r) throw new Error(`${id} missing`);
  return r;
};

describe('scope', () => {
  it('applies_to / meta_kinds: SEO lengths only on their meta kinds; default rules skip slugs; the slug rule only on slugs', () => {
    const long = 'Kreiselpumpen für die Industrie | Beratung, Lieferung, Wartung';
    expect(ids(lintSegment(seg(long), ctxFor('de-DE')).findings)).not.toContain('SEO-TITLE-LEN');
    expect(ids(lintSegment(seg(long, { block_type: 'meta', meta_kind: 'title' }), ctxFor('de-DE')).findings)).toContain('SEO-TITLE-LEN');
    expect(ids(lintSegment(seg(long, { block_type: 'meta', meta_kind: 'og_title' }), ctxFor('de-DE')).findings)).toContain('SEO-TITLE-LEN');
    const slug = lintSegment(seg('größe', { block_type: 'meta', meta_kind: 'slug' }), ctxFor('de-CH'));
    expect(ids(slug.findings)).toEqual(['SEO-SLUG-01']);
    expect(slug.findings[0]?.autofix).toEqual({ replacement: 'groesse' });
    expect(ids(lintSegment(seg('Die Größe', { block_type: 'meta', meta_kind: 'title' }), ctxFor('de-CH')).findings)).toContain('DECH-SZ-01');
  });

  it('ruleApplies honours meta kinds, including a meta segment without a kind', () => {
    const title = rule('de-DE', 'SEO-TITLE-LEN');
    expect(ruleApplies(title, { block_type: 'meta', meta_kind: 'title', operation: 'TRANSLATE_LOCALIZE' })).toBe(true);
    expect(ruleApplies(title, { block_type: 'meta', operation: 'TRANSLATE_LOCALIZE' })).toBe(false);
    expect(ruleApplies(title, { block_type: 'heading', operation: 'TRANSLATE_LOCALIZE' })).toBe(false);
    const sz = rule('de-CH', 'DECH-SZ-01');
    expect(ruleApplies(sz, { block_type: 'meta', operation: 'TRANSLATE_LOCALIZE' })).toBe(true);
    expect(ruleApplies(sz, { block_type: 'meta', meta_kind: 'slug', operation: 'TRANSLATE_LOCALIZE' })).toBe(false);
  });

  it('SKIP_IDENTICAL runs only the locale-convention rules', () => {
    const text = 'We optimize the color of our N-3085, see https://www.example.nl and write to info@example.nl.';
    const r = lintSegment(seg(text, { source_text: text, source_lang: 'en', source_locale: 'en-GB', operation: 'SKIP_IDENTICAL' }), ctxFor('en-GB'));
    expect(new Set(ids(r.findings))).toEqual(new Set(['ENGB-SPELL-01']));
    expect(r.checks.map((c) => c.rule)).not.toContain('INTEGRITY-URL');
    expect(r.review_reasons).toEqual([]);
  });

  it('untranslated only fires when translating between different languages', () => {
    const text = 'Onze pompen leveren een hoog rendement.';
    expect(ids(lintSegment(seg(text, { source_text: text }), ctxFor('de-DE')).findings)).toContain('INTEGRITY-UNTRANSLATED');
    expect(ids(lintSegment(seg(text, { source_text: text, translatable: false }), ctxFor('de-DE')).findings)).not.toContain('INTEGRITY-UNTRANSLATED');
    const en = 'Our pumps deliver high efficiency.';
    expect(ids(lintSegment(seg(en, { source_text: en, source_lang: 'en', source_locale: 'en-US', operation: 'ADAPT_ONLY' }), ctxFor('en-GB')).findings)).toEqual([]);
  });
});

describe('spans through inline placeholders and autofix', () => {
  it('reports spans in the placeholder-bearing text and fixes inside a tag', () => {
    const src = 'De <strong1>grootte</strong1> is 80 meter.';
    const target = 'Die <strong1>Größe</strong1> beträgt 80 Meter.';
    const r = lintSegment(seg(target, { source_text: src }), ctxFor('de-CH'));
    const sz = r.findings.filter((f) => f.rule_or_category === 'DECH-SZ-01');
    expect(sz).toHaveLength(1);
    expect(target.slice(sz[0]!.span!.start, sz[0]!.span!.end)).toBe('ß');
    expect(applyAutofix(target, r.findings).text).toBe('Die <strong1>Grösse</strong1> beträgt 80 Meter.');
    expect(r.checks).toContainEqual({ rule: 'INTEGRITY-TAGS', result: 'PASS', note: '[EVIDENCE: INTEGRITY-TAGS] Placeholder strong1 preserved and properly nested.', severity: 'critical' });
  });

  it('never offers an autofix for a match that spans a placeholder', () => {
    const target = 'Das Modell "<a1>Flygt</a1>" ist robust.';
    const [q] = lintSegment(seg(target, { source_text: 'Het model <a1>Flygt</a1>.' }), ctxFor('de-CH')).findings.filter((f) => f.rule_or_category === 'DECH-QUOTE-01');
    expect(target.slice(q!.span!.start, q!.span!.end)).toBe('"<a1>Flygt</a1>"');
    expect(q?.autofix).toBeNull();
  });

  it('keeps escaped literals encoded when fixing', () => {
    const target = 'Das Modell "A &lt; B" ist robust.';
    const r = lintSegment(seg(target), ctxFor('de-CH'));
    expect(applyAutofix(target, r.findings).text).toBe('Das Modell «A &lt; B» ist robust.');
  });

  it('applyAutofix: sorted, overlaps dropped, no-ops and placeholder-touching fixes skipped, spans in original coordinates', () => {
    const f = (start: number, end: number, replacement: string, id = 'X-01'): FindingDraft => ({
      segment_id: 'p', origin: 'deterministic', rule_or_category: id, severity: 'minor', evidence: `[EVIDENCE: ${id}]`, explanation: `x [EVIDENCE: ${id}]`,
      source_span: null, target_span: null, span: { start, end }, suggested_fix: null, autofix: { replacement }, requires_human_review: false, repair_trigger: false,
    });
    const text = 'aaa bbb ccc <b1>ddd</b1>';
    const res = applyAutofix(text, [f(8, 11, 'CCC'), f(0, 3, 'AAA'), f(1, 5, 'overlap'), f(4, 7, 'bbb'), f(12, 23, 'gone'), f(20, 99, 'bad'), { ...f(4, 7, 'x'), autofix: null }]);
    expect(res.text).toBe('AAA bbb CCC <b1>ddd</b1>');
    expect(res.applied).toEqual([
      { rule: 'X-01', span: { start: 0, end: 3 }, before: 'aaa', after: 'AAA' },
      { rule: 'X-01', span: { start: 8, end: 11 }, before: 'ccc', after: 'CCC' },
    ]);
    expect(applyAutofix('abc', [f(1, 2, '<a1>x')]).text).toBe('abc');
  });

  it('first_mention and slug fixes come from lint and apply cleanly', () => {
    const doc = lintDocument([seg('Prices excl. VAT. VAT is 21%.', { source_text: 'Prijzen excl. BTW.' })], ctxFor('en-NL'));
    expect(applyAutofix('Prices excl. VAT. VAT is 21%.', doc.findings).text).toBe('Prices excl. VAT (BTW). VAT is 21%.');
  });
});

describe('checks', () => {
  it('FAIL for major/critical findings, WARN for minor or hypothesis ones, PASS only for critical rules with something to verify', () => {
    const src = 'Zie <a1>https://www.example.nl/pompen</a1> of bel 020 123 4567. Wij controleren de pomp.';
    const target = 'See <a1>https://www.example.nl/pompen</a1> or call 020 123 4567. We control the pump and its color.';
    const r = lintSegment(seg(target, { source_text: src }), ctxFor('en-NL'));
    const byRule = new Map(r.checks.map((c) => [c.rule, c]));
    expect(byRule.get('ENNL-FF-CONTROLEREN')).toMatchObject({ result: 'FAIL', severity: 'major' });
    expect(byRule.get('ENNL-SPELL-01')).toMatchObject({ result: 'WARN', severity: 'minor' });
    expect(byRule.get('ENNL-PHONE-01')).toMatchObject({ result: 'WARN' });
    expect(byRule.get('ENNL-PHONE-01')?.note.startsWith('[HYPOTHESIS]')).toBe(true);
    expect(byRule.get('INTEGRITY-URL')).toEqual({ rule: 'INTEGRITY-URL', result: 'PASS', note: '[EVIDENCE: p-001] https://www.example.nl/pompen preserved.', severity: 'critical' });
    expect(byRule.get('INTEGRITY-ENTITY')).toEqual({ rule: 'INTEGRITY-ENTITY', result: 'PASS', note: '[EVIDENCE: p-001] 020 123 4567 preserved.', severity: 'critical' });
    expect(byRule.get('INTEGRITY-TAGS')?.result).toBe('PASS');
    expect(byRule.has('INTEGRITY-EMAIL')).toBe(false); // nothing to verify
    expect(byRule.has('INTEGRITY-EMPTY')).toBe(false); // never listed on PASS
    const order = r.checks.map((c) => c.rule);
    expect(order.indexOf('ENNL-FF-CONTROLEREN')).toBeLessThan(order.indexOf('INTEGRITY-URL')); // locale rules first
    for (const c of r.checks) DeterministicCheckSchema.parse(c);
  });

  it('a critical failure is a FAIL check with the rule tag', () => {
    const r = lintSegment(seg('Die Größe.'), ctxFor('de-CH'));
    expect(r.checks[0]).toEqual({ rule: 'DECH-SZ-01', result: 'FAIL', severity: 'critical', note: '[EVIDENCE: DECH-SZ-01] Found "ß"; write "ss".' });
  });
});

describe('lintDocument', () => {
  it('first_mention looks at the first occurrence across segments in document order and skips out-of-scope segments', () => {
    const inputs = [
      seg('vat-rates', { segment_id: 'meta-slug', block_type: 'meta', meta_kind: 'slug', source_text: 'btw-tarieven' }),
      seg('Our prices', { segment_id: 'h-001', block_type: 'heading', source_text: 'Onze prijzen' }),
      seg('All prices excl. VAT.', { segment_id: 'p-002', source_text: 'Alle prijzen excl. BTW.' }),
      seg('VAT (BTW) applies.', { segment_id: 'p-003', source_text: 'BTW geldt.' }),
    ];
    const r = lintDocument(inputs, ctxFor('en-NL'));
    expect(r.findings.map((f) => [f.rule_or_category, f.segment_id, f.target_span])).toEqual([['ENNL-BTW-01', 'p-002', 'VAT']]);
    expect(r.checks).toEqual([expect.objectContaining({ rule: 'ENNL-BTW-01', result: 'WARN' })]);
  });

  it('currency policy: one document-level finding per foreign currency, SKIP_IDENTICAL segments excluded', () => {
    const inputs = [seg('x', { source_text: 'Prijs € 1.250,00 en $ 99.' }), seg('y', { source_text: 'Of CHF 1.000.', operation: 'SKIP_IDENTICAL' })];
    const r = lintDocument(inputs, ctxFor('en-GB'));
    const cp = r.findings.filter((f) => f.rule_or_category === 'CURRENCY-POLICY-01');
    expect(cp.map((f) => [f.segment_id, f.evidence])).toEqual([
      [null, '[HYPOTHESIS]'],
      [null, '[HYPOTHESIS]'],
    ]);
    expect(cp[0]?.explanation).toContain('UK buyers expect GBP pricing — confirm currency policy.');
    expect(lintDocument(inputs, ctxFor('de-DE')).findings.filter((f) => f.rule_or_category === 'CURRENCY-POLICY-01')).toHaveLength(1); // only USD
  });
});

describe('robustness (no-throw fuzz)', () => {
  function rng(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pieces = ['<a1>', '</a1>', '<b2>', '</b2>', '<br3/>', '&lt;', '&gt;', ' ', '  ', '.', ',', "'", '’', ' ', '-', '–', '/', '€', 'CHF', '£', '%', 'm³/h', 'ß', 'ẞ', 'Größe', '"', '„', '“', '«', '1', '2', '0', '9', '1.250,00', "1'250.5", '30.09.2026', '020 123 4567', 'N-3085', 'Flygt', 'https://x.nl/a', 'a@b.nl', '😀', '𝐀', 'in heel Nederland', 'VAT', 'du', 'é', '\n', ''];
  const fuzz = Array.from({ length: 120 }, (_, i) => {
    const r = rng(7 + i);
    const make = () => Array.from({ length: Math.floor(r() * 40) }, () => pieces[Math.floor(r() * pieces.length)]).join('');
    return { locale: LOCALES[Math.floor(r() * LOCALES.length)] as LocaleCode, source: make(), target: make(), meta: r() < 0.2 };
  });
  const long = `${'Unsere Kreiselpumpen fördern bis zu 450 m³/h bei 80 Metern, Größe "A" für € 1.250,00. '.repeat(400)}`;
  fuzz.push({ locale: 'de-CH', source: long, target: long, meta: false }, { locale: 'en-GB', source: '', target: '', meta: false }, { locale: 'it-IT', source: '<a1></a1>', target: '<a1></a1>', meta: false });

  it.each(fuzz.map((c, i) => [i, c] as const))('#%i', (_, c) => {
    const input = seg(c.target, { source_text: c.source, ...(c.meta ? { block_type: 'meta' as const, meta_kind: 'slug' as const } : {}) });
    const ctx = ctxFor(c.locale, { delivery: 'in die ganze Schweiz', lead_time: 'innert 5 Arbeitstagen' });
    const res = lintSegment({ ...input, back_translation: { text: c.source, lang: 'nl' } }, ctx);
    const doc = lintDocument([input, input], ctx);
    for (const f of [...res.findings, ...doc.findings]) {
      FindingDraftSchema.parse(f);
      if (f.span) expect(f.span.start >= 0 && f.span.start <= f.span.end && f.span.end <= c.target.length).toBe(true);
    }
    for (const ch of [...res.checks, ...doc.checks]) DeterministicCheckSchema.parse(ch);
    const fixed = applyAutofix(c.target, [...res.findings, ...doc.findings]);
    expect(placeholderSignature(fixed.text)).toEqual(placeholderSignature(c.target));
    const n1 = normalizeFormats({ source_text: c.source, source_lang: 'nl', source_locale: 'nl-NL', target_text: c.target, target: c.locale }, ctx);
    expect(placeholderSignature(n1.text)).toEqual(placeholderSignature(c.target));
  });
});
