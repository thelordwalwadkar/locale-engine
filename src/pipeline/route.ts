/** Locale matrix (spec §4.1) and per-segment operation routing. */
import { LocaleCodeSchema, languageOf } from '../schemas/common.js';
import type { LocaleCode, Operation, PageType } from '../schemas/common.js';
import type { StagesConfig } from '../schemas/config.js';
import { EngineError } from '../util/errors.js';

/** {{SOURCE_LANGUAGES}}: input languages the engine accepts as the PAGE language. */
export const SOURCE_LANGUAGES = ['nl', 'en'] as const;

/** `en-GB` equals `en-GB`; `en-*` and `en` never equal a concrete locale (region unknown). */
export function sameLocale(sourceLocale: string, target: LocaleCode): boolean {
  return sourceLocale.toLowerCase() === target.toLowerCase();
}

/**
 * Decide what happens to ONE segment for ONE target locale (spec §4.1, §5.2):
 *  - different language                      → TRANSLATE_LOCALIZE (TRANSLATE_ONLY on legal pages);
 *  - same language, same locale              → SKIP_IDENTICAL;
 *  - same language, other / unknown region   → ADAPT_ONLY (localization pass only; SKIP_IDENTICAL on legal pages: nothing to translate,
 *    and legal substance is never localised).
 * `segmentLocale` is the locale of the segment's language on the source page (e.g. `nl-NL`, or `en-*` for an English table on a Dutch page).
 */
export function decideOperation(segmentLang: string, segmentLocale: string, target: LocaleCode, pageType: PageType): Operation {
  if (languageOf(segmentLang) !== languageOf(target)) return pageType === 'LEGAL' ? 'TRANSLATE_ONLY' : 'TRANSLATE_LOCALIZE';
  if (sameLocale(segmentLocale, target)) return 'SKIP_IDENTICAL';
  return pageType === 'LEGAL' ? 'SKIP_IDENTICAL' : 'ADAPT_ONLY';
}

/** The locale of a segment of language `lang` on a page whose source locale is `pageLocale`. */
export function localeOfSegment(lang: string, pageLocale: string): string {
  if (languageOf(pageLocale) === lang) return pageLocale;
  return lang === 'nl' ? 'nl-NL' : `${lang}-*`;
}

function assertSourceLanguage(sourceLanguage: string): 'nl' | 'en' {
  const lang = languageOf(sourceLanguage);
  if (lang !== 'nl' && lang !== 'en') {
    throw new EngineError('UNSUPPORTED_ROUTE', `source language "${sourceLanguage}" is not supported (accepted: ${SOURCE_LANGUAGES.join(', ')})`);
  }
  return lang;
}

export function defaultTargets(stages: StagesConfig, sourceLanguage: string): LocaleCode[] {
  const lang = assertSourceLanguage(sourceLanguage);
  const base = stages.locale_matrix.default_targets[lang];
  const extra: LocaleCode[] = lang === 'en' && stages.locale_matrix.enable_en_to_nl ? ['nl-NL'] : [];
  return [...new Set([...base, ...extra])];
}

/** Expand `all` or validate an explicit list against the matrix. */
export function resolveTargets(requested: 'all' | readonly string[], sourceLanguage: string, stages: StagesConfig): LocaleCode[] {
  if (requested === 'all') return defaultTargets(stages, sourceLanguage);
  const lang = assertSourceLanguage(sourceLanguage);
  const out: LocaleCode[] = [];
  for (const raw of requested) {
    const parsed = LocaleCodeSchema.safeParse(raw);
    if (!parsed.success) throw new EngineError('INPUT_INVALID', `unknown target locale "${raw}" (known: ${LocaleCodeSchema.options.join(', ')})`);
    const t = parsed.data;
    if (lang === 'en' && t === 'nl-NL' && !stages.locale_matrix.enable_en_to_nl) {
      throw new EngineError('UNSUPPORTED_ROUTE', 'en → nl-NL is supported but disabled; set locale_matrix.enable_en_to_nl: true in config/stages.yaml');
    }
    if (!out.includes(t)) out.push(t);
  }
  if (!out.length) throw new EngineError('INPUT_INVALID', 'no target locales requested');
  return out;
}
