import { describe, expect, it } from 'vitest';
import { DETECTION_LANGUAGES, detectLanguage, lettersOnlyWords } from '../src/detect/index.js';
import { readFixture } from './fixtures/ingest/helpers.js';

interface Benchmark {
  items: Array<{ text: string; lang: string }>;
  ambiguous: Array<{ text: string; note: string }>;
}
const benchmark = JSON.parse(readFixture('lang-benchmark.json')) as Benchmark;
const THRESHOLD = 0.8; // thresholds.detection_confidence_min

describe('detectLanguage: benchmark of short B2B strings', () => {
  const results = benchmark.items.map((item) => ({ item, got: detectLanguage(item.text) }));

  it('has a benchmark of at least 60 strings in every supported language', () => {
    expect(benchmark.items.length).toBeGreaterThanOrEqual(60);
    for (const lang of ['nl', 'en', 'de', 'it']) expect(benchmark.items.filter((i) => i.lang === lang).length).toBeGreaterThanOrEqual(12);
  });

  it('is at least 90 % accurate overall and per language', () => {
    const correct = results.filter((r) => r.got.lang === r.item.lang);
    expect(correct.length / results.length).toBeGreaterThanOrEqual(0.9);
    for (const lang of ['nl', 'en', 'de', 'it']) {
      const own = results.filter((r) => r.item.lang === lang);
      expect(own.filter((r) => r.got.lang === lang).length / own.length).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('is confident where it is right, and never confidently wrong', () => {
    const confident = results.filter((r) => r.got.confidence >= THRESHOLD);
    expect(confident.length / results.length).toBeGreaterThanOrEqual(0.9);
    for (const r of confident) expect(r.got.lang, r.item.text).toBe(r.item.lang);
  });

  it('returns probability-like confidences inside [0, 1] for whitelisted languages', () => {
    for (const { got } of results) {
      expect(got.confidence).toBeGreaterThanOrEqual(0);
      expect(got.confidence).toBeLessThanOrEqual(1);
      expect([...DETECTION_LANGUAGES, 'und']).toContain(got.lang);
    }
  });

  it('does not claim confidence for ambiguous or too-short strings', () => {
    for (const { text } of benchmark.ambiguous) {
      const got = detectLanguage(text);
      expect(got.lang === 'und' || got.confidence < THRESHOLD, `${text} -> ${got.lang} ${got.confidence}`).toBe(true);
      if (got.lang === 'und') expect(got.confidence).toBe(0);
    }
    expect(detectLanguage('Hotel restaurant service').confidence).toBeLessThan(THRESHOLD);
  });
});

describe('detectLanguage: cleaning and edge cases', () => {
  it('returns und for fewer than three letters-only words', () => {
    for (const text of ['', '   ', 'Contact', 'Hallo wereld', '450', '450 m³/h 80 bar', 'N-3085', 'https://www.example.nl/pompen', 'info@example.nl', '!!! ???']) {
      expect(detectLanguage(text)).toEqual({ lang: 'und', confidence: 0 });
    }
  });

  it('ignores URLs, e-mail addresses, numbers, units written with digits and product codes', () => {
    const plain = detectLanguage('Wij leveren pompen voor de industrie');
    const noisy = detectLanguage('Wij leveren pompen N-3085 voor 450 m³/h de industrie https://example.com/en/pumps info@example.com 2026');
    expect(noisy).toEqual(plain);
    expect(plain.lang).toBe('nl');
    expect(lettersOnlyWords('Pomp N-3085 levert 450 m³/h, zie www.example.nl en mail a@b.nl (l\'acqua, e-mail, -x, y-)')).toEqual([
      'Pomp', 'levert', 'zie', 'en', 'mail', "l'acqua", 'e-mail',
    ]);
  });

  it('sees through inline placeholders and escaped angle brackets', () => {
    expect(detectLanguage('<a1>Onze</a1> <strong2>pompen</strong2> leveren een hoog rendement<br3/>').lang).toBe('nl');
    expect(detectLanguage('Our pumps &lt; 5 bar deliver high efficiency at low operating cost').lang).toBe('en');
  });

  it('is case-insensitive in effect: shouting text is still detected', () => {
    expect(detectLanguage('ONZE POMPEN LEVEREN EEN HOOG RENDEMENT BIJ LAGE KOSTEN').lang).toBe('nl');
  });

  it('detects longer text with high confidence, including mixed-language text by majority', () => {
    const nl = 'De dompelpomp is voorzien van een thermische beveiliging en is geschikt voor het verpompen van afvalwater. Neem contact op voor advies over de juiste pompkeuze.';
    const got = detectLanguage(nl);
    expect(got.lang).toBe('nl');
    expect(got.confidence).toBeGreaterThan(0.95);
    expect(detectLanguage(`${nl} Suitable for clean water.`).lang).toBe('nl');
  });

  it('never throws on odd input', () => {
    for (const text of ['\u0000\u0001', '😀😀😀 😀😀 😀', 'a'.repeat(100_000), '日本語のテキストです これは テスト', 'Привет мир это тест']) {
      expect(() => detectLanguage(text)).not.toThrow();
    }
  });
});
