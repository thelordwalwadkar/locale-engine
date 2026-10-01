import { describe, expect, it } from 'vitest';
import { backTranslationSimilarity } from '../src/lint/index.js';

describe('backTranslationSimilarity (token-F1)', () => {
  it('is 1 for identical token sequences and 0 for disjoint ones', () => {
    expect(backTranslationSimilarity('Onze pompen leveren veel.', 'Onze pompen leveren veel.')).toBe(1);
    expect(backTranslationSimilarity('Onze pompen leveren veel.', 'De kat zit op de mat.')).toBe(0);
  });

  it('is 0 when either side has no tokens', () => {
    expect(backTranslationSimilarity('', 'iets')).toBe(0);
    expect(backTranslationSimilarity('iets', ' ... ')).toBe(0);
    expect(backTranslationSimilarity('', '')).toBe(0);
  });

  it('ignores case, punctuation and inline placeholders', () => {
    expect(backTranslationSimilarity('Zie <a1>onze pompen</a1>!', 'zie onze POMPEN.')).toBe(1);
  });

  it('counts overlap as a multiset and is symmetric', () => {
    // a: 4 tokens, b: 2 tokens, overlap 2 -> P = 1, R = 0.5, F1 = 2/3
    expect(backTranslationSimilarity('de de pomp draait', 'de pomp')).toBeCloseTo(2 / 3, 10);
    expect(backTranslationSimilarity('de pomp', 'de de pomp draait')).toBeCloseTo(2 / 3, 10);
  });

  it('scores the rule-file example (one word of nine replaced) at 8/9', () => {
    const s = backTranslationSimilarity('Onze pompen leveren een hoog rendement bij lage kosten.', 'Onze pompen leveren een hoog rendement tegen lage kosten.');
    expect(s).toBeCloseTo(8 / 9, 10);
  });

  it('tokenizes Unicode letters and digits, NFC-normalised', () => {
    expect(backTranslationSimilarity('Größe 80 m³', 'Größe 80 m³')).toBe(1);
  });
});
