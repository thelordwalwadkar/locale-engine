import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { brandForms, extractEntities, type Entity } from '../src/lint/entities.js';
import { formatNumber, numericKey, parseNumber, readNumberEnd } from '../src/lint/numbers.js';

const cfg = loadConfig();
const opts = (lang: string) => ({ lang, common: cfg.common, brands: brandForms(cfg.glossary) });
const extract = (text: string, lang = 'nl'): Entity[] => extractEntities(text, opts(lang));
const brief = (es: Entity[]) => es.map((e) => `${e.kind}:${e.raw}`);

describe('number parsing', () => {
  it('resolves the ambiguous single separator with the language convention (1.250 nl vs en)', () => {
    expect(parseNumber('1.250', 'nl')).toMatchObject({ value: '1250', grouped: true, thousandsSeps: ['.'], decimalSep: null });
    expect(parseNumber('1.250', 'de')?.value).toBe('1250');
    expect(parseNumber('1.250', 'en')).toMatchObject({ value: '1.250', grouped: false, decimalSep: '.' });
    expect(parseNumber('1,250', 'nl')).toMatchObject({ value: '1.250', decimalSep: ',' });
    expect(parseNumber('1,250', 'en')).toMatchObject({ value: '1250', grouped: true, thousandsSeps: [','] });
    expect(numericKey(parseNumber('1.250', 'en')!)).toBe('1.25');
  });

  it('reads tokens with both separators identically under every convention', () => {
    for (const lang of ['nl', 'en', 'de', 'it']) {
      expect(parseNumber('1.250,00', lang)?.value, lang).toBe('1250.00');
      expect(parseNumber('1,250.00', lang)?.value, lang).toBe('1250.00');
      expect(parseNumber('1.250.000,5', lang)?.value, lang).toBe('1250000.5');
    }
  });

  it("always recognises Swiss apostrophes and spaces as thousands separators (1'250.00, 1 250.5)", () => {
    expect(parseNumber("1'250.00", 'de')).toMatchObject({ value: '1250.00', grouped: true, thousandsSeps: ["'"], decimalSep: '.' });
    expect(parseNumber('1’250,5', 'nl')).toMatchObject({ value: '1250.5', thousandsSeps: ['’'], decimalSep: ',' });
    expect(parseNumber('1 250.5', 'en')?.value).toBe('1250.5');
    expect(parseNumber('1 250 000', 'de')?.value).toBe('1250000');
  });

  it('parses the dash-decimal notation 1.250,- / 1.250,– / 1.250,-- / 1\'250.–', () => {
    for (const raw of ['1.250,-', '1.250,–', '1.250,--', '1.250,—']) {
      expect(parseNumber(raw, 'nl'), raw).toMatchObject({ value: '1250', frac: null, dashDecimal: true, decimalSep: ',', grouped: true });
    }
    expect(parseNumber("1'250.–", 'de')).toMatchObject({ value: '1250', dashDecimal: true, decimalSep: '.' });
    expect(parseNumber('20,-', 'nl')?.value).toBe('20');
  });

  it('decimals, repeated separators and invalid grouping', () => {
    expect(parseNumber('0,5', 'nl')?.value).toBe('0.5');
    expect(parseNumber('0.250', 'nl')?.value).toBe('0.250'); // a leading 0 group can never be thousands
    expect(parseNumber('1250,00', 'nl')?.value).toBe('1250.00');
    expect(parseNumber('12.5', 'de')?.value).toBe('12.5'); // not three digits after: decimal in any language
    expect(parseNumber('1.250.000', 'en')?.value).toBe('1250000');
    expect(parseNumber('1.2.3', 'nl')).toBeNull();
    expect(parseNumber('12.34.567', 'nl')).toBeNull();
    expect(parseNumber('1.250,5,3', 'nl')).toBeNull();
  });

  it('treats multi-digit integer parts with a leading zero as opaque (compared as written, never reformatted)', () => {
    const p = parseNumber('01.10', 'nl');
    expect(p?.opaque).toBe(true);
    expect(numericKey(p!)).toBe('#01.10');
    expect(formatNumber(p!, cfg.locales['de-CH'].formatting.number)).toBe('01.10');
    expect(parseNumber('0800', 'nl')?.opaque).toBe(true);
  });

  it('formats only existing separators: grouping is kept or absent, digits are copied', () => {
    const ch = cfg.locales['de-CH'].formatting.number;
    const gb = cfg.locales['en-GB'].formatting.number;
    const de = cfg.locales['de-DE'].formatting.number;
    expect(formatNumber(parseNumber('1.250,00', 'nl')!, ch)).toBe("1'250.00");
    expect(formatNumber(parseNumber('1.250,00', 'nl')!, gb)).toBe('1,250.00');
    expect(formatNumber(parseNumber('1250,5', 'nl')!, gb)).toBe('1250.5'); // no grouping added
    expect(formatNumber(parseNumber('12.500.000', 'nl')!, ch)).toBe("12'500'000");
    expect(formatNumber(parseNumber('1.250,-', 'nl')!, gb)).toBe('1,250'); // dash_decimal: drop
    expect(formatNumber(parseNumber('1.250,-', 'nl')!, de)).toBe('1.250,-'); // dash_decimal: keep
    expect(formatNumber(parseNumber('1.250,–', 'nl')!, ch)).toBe("1'250.–");
  });

  it('tokenizes: space grouping only in front of exactly three digits after a valid first group', () => {
    const end = (s: string) => s.slice(0, readNumberEnd(s, 0));
    expect(end('2026 300 Pumpen')).toBe('2026');
    expect(end('5 000 000 Stück')).toBe('5 000 000');
    expect(end('5 werkdagen')).toBe('5');
    expect(end("1'25 x")).toBe('1');
    expect(end('1.250,- excl.')).toBe('1.250,-');
    expect(end('80. September')).toBe('80');
    expect(end('1.250,5.')).toBe('1.250,5');
  });
});

describe('entity extraction', () => {
  it('extracts in order and never matches a later kind inside an earlier one', () => {
    const text =
      'Zie https://www.example.nl/pomp-450 of mail info@example.nl. Levering 30-09-2026, bel 020 123 4567. Prijs € 1.250,00 voor N-3085 van Flygt: 450 m³/h bij 80 meter, ISO 9001.';
    expect(brief(extract(text))).toEqual([
      'url:https://www.example.nl/pomp-450',
      'email:info@example.nl',
      'date:30-09-2026',
      'phone:020 123 4567',
      'currency:€ 1.250,00',
      'product_code:N-3085',
      'brand:Flygt',
      'unit:450 m³/h',
      'number:80',
      'brand:ISO 9001',
    ]);
  });

  it('records values, units, currencies, dates and currency layout', () => {
    const [amount] = extract('Prijs € 1.250,00 excl. BTW.');
    expect(amount).toMatchObject({ kind: 'currency', currency: 'EUR', value: '1250.00', layout: { position: 'before', marker: '€', gap: ' ' } });
    expect(amount?.number?.raw).toBe('1.250,00');
    expect(extract("Ab CHF 1'250.00 exkl. MWST.", 'de')[0]).toMatchObject({ kind: 'currency', currency: 'CHF', layout: { position: 'before', marker: 'CHF' } });
    expect(extract('Ab 1.250,00 € zzgl.', 'de')[0]).toMatchObject({ currency: 'EUR', layout: { position: 'after', gap: ' ' } });
    expect(extract('Total EUR1.250', 'nl')[0]).toMatchObject({ kind: 'currency', currency: 'EUR', value: '1250' });
    expect(extract('Kosten £99 en $5', 'en').map((e) => e.currency)).toEqual(['GBP', 'USD']);
    expect(extract('Vanaf € 1.250,- excl.')[0]).toMatchObject({ kind: 'currency', raw: '€ 1.250,-', value: '1250' });
    expect(extract('Verfügbar ab 30.09.2026.', 'de')[0]).toMatchObject({ kind: 'date', date: { day: '30', month: '09', year: '2026', sep: '.' }, value: '30.9.2026' });
  });

  it('does not take alphabetic currency codes out of words', () => {
    expect(brief(extract('Prijs 1.250 EURO'))).toEqual(['number:1.250']);
    expect(brief(extract('5 CHFX'))).toEqual(['number:5']);
  });

  it('attaches the longest adjacent symbol unit that is not followed by a letter', () => {
    expect(brief(extract('450 m³/h, 450m³/s, 12 m³, 80 meter, 80 m, 16 bar, 16 barg, 82 %, 5 min, 20 °C, 3x400 V'))).toEqual([
      'unit:450 m³/h',
      'unit:450m³/s',
      'unit:12 m³',
      'number:80',
      'unit:80 m',
      'unit:16 bar',
      'unit:16 barg',
      'unit:82 %',
      'number:5',
      'unit:20 °C',
      'number:3',
      'unit:400 V',
    ]);
  });

  it('ignores digits glued to words and trims codes and URLs', () => {
    expect(brief(extract('H2O en CO2 bij DN50'))).toEqual(['product_code:DN50']);
    expect(brief(extract('De N-3085-Pumpe'))).toEqual(['product_code:N-3085']);
    expect(brief(extract('Siehe https://www.example.nl/pompen.'))).toEqual(['url:https://www.example.nl/pompen']);
  });

  it('accepts only valid numeric dates; two-digit years need a padded day and month', () => {
    expect(brief(extract('Op 30.09.26 en 1.5.2026'))).toEqual(['date:30.09.26', 'date:1.5.2026']);
    expect(extract('Versie 2.5.10').filter((e) => e.kind === 'date')).toEqual([]);
    expect(extract('Code 32.13.2026').filter((e) => e.kind === 'date')).toEqual([]);
    expect(brief(extract('Geldig 01.01.2026-31.12.2026'))).toEqual(['date:01.01.2026', 'date:31.12.2026']);
  });

  it('finds phone numbers in national and international format', () => {
    expect(brief(extract('Bel 020 123 4567 of +31 6 12345678.'))).toEqual(['phone:020 123 4567', 'phone:+31 6 12345678']);
    expect(brief(extract('Tel. +41 (0)44 123 45 67', 'de'))).toEqual(['phone:+41 (0)44 123 45 67']);
  });

  it('brands are whole words and case-sensitive', () => {
    expect(brief(extract('Flygt, Flygts, flygt en Flygt-pompen'))).toEqual(['brand:Flygt', 'brand:Flygt']);
  });

  it('never throws on odd input', () => {
    for (const s of ['', ' ', '€', '1.', ',5', '1..2', '---', '0000', '😀 1 😀', 'x'.repeat(5000), '1.2.3.4.5.6', '€ € 5 € €']) {
      expect(() => extract(s), JSON.stringify(s.slice(0, 20))).not.toThrow();
    }
  });
});
