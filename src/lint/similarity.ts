/** Lexical similarity between a source and its back-translation (rule type `backtranslation_similarity`). */
import { plainText } from '../util/inline.js';

function tokens(text: string): string[] {
  return plainText(text).normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Token-F1 (0..1) between two texts of the same language: lower-cased letter/number tokens, punctuation ignored, multiset overlap.
 * 0 when either side has no tokens; 1 for texts with identical tokens.
 */
export function backTranslationSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of tb) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      overlap++;
      counts.set(t, c - 1);
    }
  }
  if (overlap === 0) return 0;
  const precision = overlap / tb.length;
  const recall = overlap / ta.length;
  return (2 * precision * recall) / (precision + recall);
}
