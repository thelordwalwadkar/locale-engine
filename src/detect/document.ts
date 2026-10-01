/**
 * Document- and segment-level language detection (spec §7 Phase 4, edge case `edge_mixed_language`).
 *
 * - The document language comes from all translatable text at once; a caller-declared language or `<html lang>` that agrees with it
 *   raises the confidence (independent evidence, combined as noisy-OR), one that disagrees only produces a warning.
 * - Every segment with enough natural-language words is detected on its own, so a Dutch page with an English spec table keeps `nl`
 *   and `en` segments. Short or non-translatable segments inherit the document language.
 * - Only segments the library is unsure about (confidence below `detection_confidence_min`) are sent to the injected LLM classifier,
 *   in batches of at most 40, never when everything is confident. Nothing here calls a model itself. A segment the classifier does not
 *   settle (absent, failing, `und` / `other`) takes the document language rather than keeping an unconfirmed guess.
 */
import { determineSourceLocale, languageOfTag } from '../ingest/locale.js';
import type { LangDetectBatchWire, LangDetection, Segment, SourceDocument } from '../schemas/index.js';
import { errorMessage } from '../util/errors.js';
import { plainText } from '../util/inline.js';
import { round } from '../util/text.js';
import { detectLanguage, lettersOnlyWords } from './language.js';

export interface DetectOptions {
  thresholds: {
    /** Below this a library result is re-checked by the LLM fallback. */
    detection_confidence_min: number;
    /** Segments with fewer natural-language words inherit the document language. */
    detection_min_words: number;
  };
  /** LLM fallback for low-confidence segments (one batched call per up to 40 segments). Absent: keep the library result and warn. */
  classify?: (items: Array<{ segment_id: string; text: string }>) => Promise<LangDetectBatchWire['results']>;
  /** Language (or locale) the caller says the source is in. */
  declaredLanguage?: string;
}

/** Confidence a declared language / an HTML attribute would carry on its own; combined with the detector's as independent evidence. */
const DECLARED_PRIOR = 0.9;
const ATTRIBUTE_PRIOR = 0.7;
const FALLBACK_BATCH = 40;
/** Languages the LLM fallback may assign (`other` and `und` are not answers). */
const FALLBACK_LANGUAGES = new Set(['nl', 'en', 'de', 'it', 'fr', 'es']);

const noisyOr = (a: number, b: number): number => round(1 - (1 - a) * (1 - b), 3);
const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.5));

function documentLanguage(doc: SourceDocument, opts: DetectOptions, warnings: string[]): LangDetection {
  const text = doc.segments.filter((s) => s.translatable).map((s) => plainText(s.text)).join('\n');
  const detected = detectLanguage(text);
  const declared = languageOfTag(opts.declaredLanguage);
  const attribute = languageOfTag(doc.head.html_lang);

  if (detected.lang === 'und') {
    if (declared !== undefined) return { lang: declared, confidence: DECLARED_PRIOR, method: 'declared' };
    if (attribute !== undefined) return { lang: attribute, confidence: ATTRIBUTE_PRIOR, method: 'attribute' };
    warnings.push('the document language could not be detected (too little text)');
    return { lang: 'und', confidence: 0, method: 'lib' };
  }

  let result: LangDetection = { lang: detected.lang, confidence: detected.confidence, method: 'lib' };
  if (declared === detected.lang) result = { lang: detected.lang, confidence: noisyOr(detected.confidence, DECLARED_PRIOR), method: 'declared' };
  else if (attribute === detected.lang) result = { lang: detected.lang, confidence: noisyOr(detected.confidence, ATTRIBUTE_PRIOR), method: 'attribute' };

  const p = `p=${detected.confidence}`;
  if (declared !== undefined && declared !== detected.lang) {
    warnings.push(`declared language "${declared}" disagrees with the detected language "${detected.lang}" (${p}); keeping the detected language`);
  }
  if (attribute !== undefined && attribute !== detected.lang) {
    warnings.push(`<html lang="${doc.head.html_lang ?? ''}"> says ${attribute} but the text is ${detected.lang} (${p}); keeping the detected language`);
  }
  if (result.confidence < opts.thresholds.detection_confidence_min) {
    warnings.push(`low-confidence document language detection (p=${result.confidence} for ${result.lang})`);
  }
  return result;
}

/**
 * An unconfirmed library guess must not decide what happens to a segment: a Dutch title such as "Werking pompen | Industrial Pump
 * Group" is read as English (p = 0.74), and routing it as "already English" would leave Dutch in the English output unnoticed. A
 * segment nobody could settle takes the document language instead, so it is translated; translating text that is already in the
 * target language is harmless, skipping the translation of text that is not, is not.
 */
function inheritDocumentLanguage(segments: Segment[], at: number, inherited: LangDetection): void {
  const segment = segments[at];
  if (segment !== undefined) segments[at] = { ...segment, lang: inherited };
}

/** Sends the low-confidence segments to `classify` and applies its answers in place; returns the warnings to record. */
async function applyFallback(
  segments: Segment[],
  lowIds: readonly string[],
  classify: NonNullable<DetectOptions['classify']>,
  inherited: LangDetection,
): Promise<string[]> {
  const index = new Map(segments.map((s, i) => [s.segment_id, i] as const));
  const items = lowIds.map((id) => ({ segment_id: id, text: plainText(segments[index.get(id) ?? 0]?.text ?? '') }));
  let failed = 0;
  let unresolved = 0;
  let firstError = '';
  for (let from = 0; from < items.length; from += FALLBACK_BATCH) {
    const batch = items.slice(from, from + FALLBACK_BATCH);
    let results: LangDetectBatchWire['results'];
    try {
      results = await classify(batch);
    } catch (e) {
      failed += batch.length;
      firstError ||= errorMessage(e);
      for (const item of batch) inheritDocumentLanguage(segments, index.get(item.segment_id) ?? -1, inherited);
      continue;
    }
    const answers = new Map(results.map((r) => [r.segment_id, r] as const));
    for (const item of batch) {
      const answer = answers.get(item.segment_id);
      const at = index.get(item.segment_id);
      const segment = at === undefined ? undefined : segments[at];
      if (answer !== undefined && FALLBACK_LANGUAGES.has(answer.lang) && at !== undefined && segment !== undefined) {
        segments[at] = { ...segment, lang: { lang: answer.lang, confidence: clamp01(answer.confidence), method: 'llm' } };
      } else {
        unresolved++;
        inheritDocumentLanguage(segments, at ?? -1, inherited);
      }
    }
  }
  const warnings: string[] = [];
  if (failed > 0) warnings.push(`language detection fallback failed (${firstError}); the document language is used for ${failed} segments`);
  if (unresolved > 0) {
    warnings.push(`language detection fallback gave no usable answer (und, other or missing) for ${unresolved} segments; the document language is used for them`);
  }
  return warnings;
}

export async function detectDocument(doc: SourceDocument, opts: DetectOptions): Promise<SourceDocument> {
  const { detection_confidence_min: minConfidence, detection_min_words: minWords } = opts.thresholds;
  const warnings = [...doc.warnings];
  const language = documentLanguage(doc, opts, warnings);
  const inherited: LangDetection = { lang: language.lang, confidence: language.confidence, method: 'inherited' };

  const segments: Segment[] = doc.segments.map((segment) => {
    const plain = plainText(segment.text);
    if (!segment.translatable || lettersOnlyWords(plain).length < minWords) return { ...segment, lang: inherited };
    const found = detectLanguage(plain);
    if (found.lang === 'und') return { ...segment, lang: inherited };
    return { ...segment, lang: { lang: found.lang, confidence: found.confidence, method: 'lib' } };
  });

  const low = segments.filter((s) => s.lang?.method === 'lib' && s.lang.confidence < minConfidence).map((s) => s.segment_id);
  if (low.length > 0) {
    if (opts.classify) warnings.push(...(await applyFallback(segments, low, opts.classify, inherited)));
    else {
      const lowSet = new Set(low);
      segments.forEach((s, at) => {
        if (lowSet.has(s.segment_id)) inheritDocumentLanguage(segments, at, inherited);
      });
      warnings.push(`low-confidence language detection for ${low.length} segments; they take the document language`);
    }
  }

  return { ...doc, source_language: language.lang, source_language_detection: language, segments, warnings };
}

const isRegionless = (locale: string): boolean => !locale.includes('-') || locale.endsWith('-*');

/** Re-evaluates `source_locale` once the language is known (see `determineSourceLocale`). */
export function finalizeSourceLocale(doc: SourceDocument, declared?: string): SourceDocument {
  const url = doc.origin.final_url ?? (/^https?:\/\//i.test(doc.origin.ref) ? doc.origin.ref : undefined);
  const next = determineSourceLocale({
    ...(declared !== undefined ? { declared } : {}),
    ...(doc.head.html_lang !== undefined ? { html_lang: doc.head.html_lang } : {}),
    ...(url !== undefined ? { url } : {}),
    language: doc.source_language,
  });
  // The ingest-time decision may rest on og:locale or a caller override, neither of which the document keeps; never trade a
  // region it established for the same language for a region-less answer.
  if (declared === undefined && isRegionless(next.source_locale) && !isRegionless(doc.source_locale) && languageOfTag(doc.source_locale) === doc.source_language) {
    return doc;
  }
  return { ...doc, source_locale: next.source_locale, source_locale_evidence: next.evidence };
}
