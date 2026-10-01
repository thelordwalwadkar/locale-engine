/**
 * Local language detection: ELD (Efficient Language Detector, `eld/medium` build) restricted to nl, en, de, it, fr, es.
 *
 * WHY ELD. The three installed candidates were benchmarked on 164 short B2B strings (3-12 words, nl/en/de/it/fr/es, some with product
 * codes and units; 69 of them are `tests/fixtures/ingest/lang-benchmark.json`), all behind the same cleaning step and whitelist:
 *
 *   eld large 164/164 (100 %) · eld medium 163/164 (99.4 %) · eld small 163/164 · tinyld heavy 159/164 (97.0 %)
 *   tinyld normal 158/164 (96.3 %) · tinyld light 150/164 (91.5 %) · lande 146/164 (89.0 %)
 *
 * lande is confidently wrong (mean confidence on its errors 0.77-0.94); tinyld heavy made a confident error ("Productinformatie en
 * technische tekeningen" -> en, 1.00); every ELD error carried low confidence. `medium` over `large`: the same ranking at a third of the
 * memory (+76 MB vs +210 MB RSS) and half the load time (~0.3 s vs ~0.65 s).
 *
 * CONFIDENCE. ELD's scores are not probabilities (the winner scores ~0.8, runners-up 0.4-0.7), so they are turned into a probability-like
 * value by a softmax over the whitelisted languages' scores with temperature 0.04 (renormalised over the whitelist). Calibrated on the
 * benchmark: correct answers have median 0.99 and 10th percentile 0.95 (2-3 % fall under 0.8), the one wrong answer scored 0.50 and a
 * genuinely ambiguous three-word string ("Hotel restaurant service") 0.42 - below `thresholds.detection_confidence_min` (0.8), i.e. they
 * are the ones that go to the LLM fallback.
 */
import { eld } from 'eld/medium';
import { plainText } from '../util/inline.js';
import { round } from '../util/text.js';

export const DETECTION_LANGUAGES = ['nl', 'en', 'de', 'it', 'fr', 'es'] as const;

export interface LangResult {
  /** One of `DETECTION_LANGUAGES`, or `und` when there is too little text to tell. */
  lang: string;
  /** 0-1, see the module comment. `und` is always 0. */
  confidence: number;
}

const TEMPERATURE = 0.04;
/** Fewer letters-only words than this carry no usable language signal. */
const MIN_WORDS = 3;

// Private instance: the language subset is not shared with anything else that may use ELD.
const detector = eld.newInstance();
detector.setLanguageSubset([...DETECTION_LANGUAGES]);

/** Longer whitespace-free runs are hashes, base64 or minified noise, not words (and cost time in every pattern applied to them). */
const MAX_RUN_CHARS = 256;
const MAX_WORD_CHARS = 64;
/** Language is certain long before this; it only bounds the work on huge pages. */
const MAX_TEXT_CHARS = 100_000;

/**
 * The words a detector can use: whitespace-separated runs that are URLs or e-mail addresses are dropped, then only tokens made of
 * letters (2 or more, inner apostrophes and hyphens allowed, so elisions such as l'acqua count) are kept. Numbers, units written with digits and codes such as `N-3085`
 * or `m³/h` drop out; a bare unit word (`bar`, `kW`) stays, which is harmless next to real words.
 */
export function lettersOnlyWords(text: string): string[] {
  const words: string[] = [];
  let chars = 0;
  for (const run of plainText(text).split(/\s+/)) {
    if (run === '' || run.length > MAX_RUN_CHARS || /:\/\/|^www\.|@/i.test(run)) continue;
    for (const token of run.split(/[^\p{L}\p{N}'’-]+/u)) {
      const w = token.replace(/^['’-]+|['’-]+$/g, '');
      if (w.length < 2 || w.length > MAX_WORD_CHARS || !/^\p{L}+(?:['’-]\p{L}+)*$/u.test(w)) continue;
      words.push(w);
      chars += w.length + 1;
    }
    if (chars > MAX_TEXT_CHARS) break;
  }
  return words;
}

export function detectLanguage(text: string): LangResult {
  const words = lettersOnlyWords(text);
  if (words.length < MIN_WORDS) return { lang: 'und', confidence: 0 };
  const scores = detector.detect(words.join(' ')).getScores();
  const ranked = DETECTION_LANGUAGES.map((lang) => ({ lang, score: scores[lang] ?? 0 })).sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (top === undefined || top.score <= 0) return { lang: 'und', confidence: 0 };
  let z = 0;
  for (const r of ranked) z += Math.exp((r.score - top.score) / TEMPERATURE);
  return { lang: top.lang, confidence: round(1 / z, 3) };
}
