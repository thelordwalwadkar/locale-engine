import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { lintSegment, normalizeFormats, type LintContext } from '../src/lint/index.js';
import { LOCALES, type LocaleCode } from '../src/schemas/index.js';

const cfg = loadConfig();
const NB = ' ';

function ctxFor(target: LocaleCode): LintContext {
  return { target, profile: cfg.locales[target], common: cfg.common, glossary: cfg.glossary, thresholds: { back_translation_similarity_min: 0.4 } };
}

function norm(source: string, target: string, locale: LocaleCode, source_locale = 'nl-NL') {
  const source_lang = source_locale.slice(0, 2);
  return normalizeFormats({ source_text: source, source_lang, source_locale, target_text: target, target: locale }, ctxFor(locale));
}

describe('normalizeFormats — spec example "€ 1.250,00 excl. BTW" in every locale', () => {
  const source = 'Prijs € 1.250,00 excl. BTW.';
  const cases: Array<[LocaleCode, string, string | null]> = [
    ['en-NL', 'Price €1,250.00 excl. VAT.', 'ENNL-CUR-01'],
    ['en-GB', 'Price €1,250.00 excl. VAT.', 'ENGB-CUR-01'],
    ['de-DE', `Price 1.250,00${NB}€ excl. VAT.`, 'DEDE-CUR-01'],
    ['de-AT', `Price 1.250,00${NB}€ excl. VAT.`, 'DEAT-CUR-01'],
    ['de-CH', "Price € 1'250.00 excl. VAT.", 'DECH-CUR-01'],
    ['it-IT', `Price 1.250,00${NB}€ excl. VAT.`, 'ITIT-CUR-01'],
    ['nl-NL', 'Price € 1.250,00 excl. VAT.', null],
  ];
  it.each(cases)('%s', (locale, expected, rule) => {
    const out = norm(source, 'Price € 1.250,00 excl. VAT.', locale);
    expect(out.text).toBe(expected);
    if (rule === null) expect(out.changes).toEqual([]);
    else expect(out.changes).toEqual([{ type: 'FORMAT_CHANGE', aspect: 'currency', from: '€ 1.250,00', to: expected.slice(6, -11), rule, origin: 'deterministic' }]);
    expect(norm(source, out.text, locale).text, 'idempotent').toBe(out.text);
  });
});

describe('normalizeFormats — counterparts and change log', () => {
  it('logs an llm-origin change when the model already wrote the target form (no rewrite)', () => {
    const out = norm('Prijs € 1.250,00 excl. BTW.', 'Price €1,250.00 excl. VAT.', 'en-NL');
    expect(out.text).toBe('Price €1,250.00 excl. VAT.');
    expect(out.changes).toEqual([{ type: 'FORMAT_CHANGE', aspect: 'currency', from: '€ 1.250,00', to: '€1,250.00', rule: 'ENNL-CUR-01', origin: 'llm' }]);
  });

  it('rewrites the same value in another spelling and notes what the model wrote', () => {
    const out = norm('Prijs € 1.250,00 excl. BTW.', "Preis 1'250.00 € exkl. MWST.", 'de-CH');
    expect(out.text).toBe("Preis € 1'250.00 exkl. MWST.");
    expect(out.changes).toEqual([
      { type: 'FORMAT_CHANGE', aspect: 'currency', from: '€ 1.250,00', to: "€ 1'250.00", rule: 'DECH-CUR-01', origin: 'deterministic', note: `the model wrote "1'250.00 €"` },
    ]);
  });

  it('converts number separators and keeps units and other numbers untouched', () => {
    const src = 'Debiet tot 1.250,5 m³/h bij 80 meter.';
    const ch = norm(src, 'Förderstrom bis 1.250,5 m³/h bei 80 Metern.', 'de-CH');
    expect(ch.text).toBe("Förderstrom bis 1'250.5 m³/h bei 80 Metern.");
    expect(ch.changes).toEqual([{ type: 'FORMAT_CHANGE', aspect: 'number', from: '1.250,5', to: "1'250.5", rule: 'DECH-NUM-01', origin: 'deterministic' }]);
    expect(norm(src, 'Flow up to 1.250,5 m³/h at 80 metres.', 'en-GB').text).toBe('Flow up to 1,250.5 m³/h at 80 metres.');
    expect(norm(src, 'Förderstrom bis 1.250,5 m³/h bei 80 Metern.', 'de-DE').changes).toEqual([]);
  });

  it('never adds grouping and leaves years, codes and brand numbers alone', () => {
    const out = norm('Sinds 2026 levert de N-3085 tot 1250,5 m³/h, ISO 9001.', 'Since 2026 the N-3085 delivers up to 1250,5 m³/h, ISO 9001.', 'en-GB');
    expect(out.text).toBe('Since 2026 the N-3085 delivers up to 1250.5 m³/h, ISO 9001.');
    expect(out.changes.map((c) => `${c.from}->${c.to}`)).toEqual(['1250,5->1250.5']);
  });

  it('resolves an ambiguous source spelling with the SOURCE convention (A-012)', () => {
    expect(norm('Levering van 1.250 stuks.', 'Delivery of 1.250 units.', 'en-GB').text).toBe('Delivery of 1,250 units.');
    expect(norm('Delivery of 1,250 units.', 'Lieferung von 1,250 Stück.', 'de-DE', 'en-GB').text).toBe('Lieferung von 1.250 Stück.');
  });

  it('reshapes numeric dates with zero padding', () => {
    const src = 'Beschikbaar vanaf 1-2-2027 en 30-09-2026.';
    const de = norm(src, 'Verfügbar ab 1-2-2027 und 30-09-2026.', 'de-DE');
    expect(de.text).toBe('Verfügbar ab 01.02.2027 und 30.09.2026.');
    expect(de.changes.map((c) => [c.aspect, c.from, c.to, c.rule])).toEqual([
      ['date', '1-2-2027', '01.02.2027', 'DEDE-DATE-01'],
      ['date', '30-09-2026', '30.09.2026', 'DEDE-DATE-01'],
    ]);
    expect(norm(src, 'Available from 1-2-2027 and 30-09-2026.', 'en-GB').text).toBe('Available from 01/02/2027 and 30/09/2026.');
  });

  it('keeps or drops the dash-decimal per locale', () => {
    const src = 'Vanaf € 1.250,- excl. BTW.';
    expect(norm(src, 'From € 1.250,- excl. VAT.', 'en-GB').text).toBe('From €1,250 excl. VAT.');
    expect(norm(src, 'Ab € 1.250,- zzgl. MwSt.', 'de-DE').text).toBe(`Ab 1.250,-${NB}€ zzgl. MwSt.`);
    expect(norm(src, 'Ab € 1.250,- exkl. MWST.', 'de-CH').text).toBe("Ab € 1'250.- exkl. MWST.");
  });

  it('alphabetic codes stay codes with a space; EUR becomes €', () => {
    expect(norm('Prijs CHF 1.250,00', 'Price CHF 1.250,00', 'en-GB').text).toBe('Price CHF 1,250.00');
    expect(norm('Prijs EUR 1.250,00', 'Price EUR 1.250,00', 'en-GB').text).toBe('Price €1,250.00');
    expect(norm('Prijs CHF 1.250,00', 'Preis CHF 1.250,00', 'de-CH').text).toBe("Preis CHF 1'250.00");
  });

  it('rewrites inside inline markup but never across a placeholder', () => {
    expect(norm('Prijs <strong1>€ 1.250,00</strong1>', 'Price <strong1>€ 1.250,00</strong1>', 'en-GB').text).toBe('Price <strong1>€1,250.00</strong1>');
    const across = norm('Prijs € 1.250,00', 'Price € <strong1>1.250,00</strong1>', 'en-GB');
    expect(across.text).toBe('Price € <strong1>1.250,00</strong1>');
    expect(across.changes).toEqual([]);
  });

  it('leaves unmatched source numbers and extra target numbers alone', () => {
    const out = norm('Prijs € 1.250,00.', 'Price on request; 3,5 % discount.', 'en-GB');
    expect(out).toEqual({ text: 'Price on request; 3,5 % discount.', changes: [] });
  });
});

describe('normalizeFormats — properties', () => {
  function rng(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const nlNumber = (r: () => number): string => {
    const len = 1 + Math.floor(r() * 7);
    let int = String(1 + Math.floor(r() * 9));
    while (int.length < len) int += String(Math.floor(r() * 10));
    const grouped = int.length >= 4 && r() < 0.7 ? int.replace(/\B(?=(\d{3})+$)/g, '.') : int;
    const frac = r() < 0.5 ? '' : String(Math.floor(r() * 100)).padStart(1 + Math.floor(r() * 2), '0').slice(-2);
    if (frac) return `${grouped},${frac}`;
    return r() < 0.15 ? `${grouped},-` : grouped;
  };
  const cases = Array.from({ length: 150 }, (_, i) => {
    const r = rng(1000 + i);
    const locale = LOCALES[Math.floor(r() * LOCALES.length)] as LocaleCode;
    const a = nlNumber(r);
    const b = nlNumber(r);
    const day = String(1 + Math.floor(r() * 28)).padStart(2, '0');
    const month = String(1 + Math.floor(r() * 12)).padStart(2, '0');
    const source = `Prijs € ${a} excl. BTW, debiet ${b} m³/h, levering ${day}-${month}-2027.`;
    // the model either keeps a figure verbatim or converts it; normalising the converted text is the reference for both
    const once = norm(source, source, locale).text;
    const pieces = r() < 0.5 ? source : once;
    return { locale, source, target: pieces };
  });

  it.each(cases.map((c, i) => [i, c] as const))('#%i is idempotent, keeps every digit and satisfies the format and entity rules', (_, c) => {
    const first = norm(c.source, c.target, c.locale);
    expect(norm(c.source, first.text, c.locale).text).toBe(first.text);
    const digits = (s: string) => [...s.replace(/\D/g, '')].sort().join('');
    expect(digits(first.text)).toBe(digits(c.target));
    const res = lintSegment(
      { segment_id: 'p-001', block_type: 'paragraph', operation: 'TRANSLATE_LOCALIZE', source_text: c.source, source_lang: 'nl', source_locale: 'nl-NL', target_text: first.text, translatable: true },
      ctxFor(c.locale),
    );
    const failing = res.findings.filter((f) => /-(NUM|CUR|DATE)-01$/.test(f.rule_or_category) || f.rule_or_category === 'INTEGRITY-ENTITY');
    expect(failing.map((f) => f.explanation)).toEqual([]);
  });
});
