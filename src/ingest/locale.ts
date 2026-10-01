/**
 * Source locale: which language AND which market the source text was written for.
 *
 * Precedence: the caller's declaration > `<html lang>` / `og:locale` (only while it agrees with the detected language, because
 * CMS defaults such as `lang="en-US"` on Dutch pages are common) > a ccTLD used as a region hint for the detected language >
 * the language alone (`nl` -> `nl-NL`, other languages -> `<lang>-*`: language known, region unknown).
 */

export interface SourceLocaleInput {
  /** Caller override, e.g. `nl-NL`, `en-GB`, `en`, `en-*`. */
  declared?: string;
  html_lang?: string;
  og_locale?: string;
  /** Page URL; only its top-level domain is used. */
  url?: string;
  /** Detected (or, before detection, attribute) language as ISO 639-1; `und` when unknown. */
  language: string;
}

export interface SourceLocaleResult {
  source_locale: string;
  evidence: string;
}

interface LocaleTag {
  language: string;
  region?: string;
}

/** `nl`, `nl-nl`, `en_GB`, `zh-Hans-CN`, `en-*` -> language + optional region. Junk (`x-default`, `*`, words) -> undefined. */
export function parseLocaleTag(tag: string | undefined): LocaleTag | undefined {
  if (tag === undefined) return undefined;
  const parts = tag.trim().split(/[-_]/);
  const language = parts[0]?.toLowerCase() ?? '';
  if (!/^[a-z]{2,3}$/.test(language) || language === 'x') return undefined;
  for (const part of parts.slice(1)) {
    if (part.toLowerCase() === 'x') break;
    if (/^[a-z]{2}$/i.test(part)) return { language, region: part.toUpperCase() };
  }
  return { language };
}

/** ISO 639-1 language of a locale tag or `undefined` when the tag is not one. */
export function languageOfTag(tag: string | undefined): string | undefined {
  return parseLocaleTag(tag)?.language;
}

/** ccTLD -> region, per language. Kept to pairs where the TLD really tells the market; everything else stays region-less. */
const REGION_HINTS: Record<string, Record<string, string>> = {
  nl: { nl: 'NL' },
  en: { uk: 'GB' },
  de: { de: 'DE', at: 'AT', ch: 'CH' },
  it: { it: 'IT', ch: 'CH' },
};

function tldOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).hostname.split('.').pop()?.toLowerCase();
  } catch {
    return undefined;
  }
}

function toLocale(tag: LocaleTag): string {
  if (tag.region !== undefined) return `${tag.language}-${tag.region}`;
  if (tag.language === 'nl') return 'nl-NL';
  return tag.language === 'und' ? 'und' : `${tag.language}-*`;
}

export function determineSourceLocale(input: SourceLocaleInput): SourceLocaleResult {
  const language = input.language.toLowerCase();

  const declared = parseLocaleTag(input.declared);
  if (declared) {
    const locale = toLocale(declared);
    return { source_locale: locale, evidence: `declared by the caller: ${input.declared}${locale === input.declared ? '' : ` (normalised to ${locale})`}` };
  }

  const tld = tldOf(input.url);
  const notes: string[] = [];
  const attributes: Array<[string, string | undefined]> = [
    ['<html lang>', input.html_lang],
    ['og:locale', input.og_locale],
  ];
  for (const [label, value] of attributes) {
    const tag = parseLocaleTag(value);
    if (!tag) continue;
    if (language !== 'und' && tag.language !== language) {
      notes.push(`${label} "${value}" ignored: the text is ${language}`);
      continue;
    }
    const hinted = tag.region === undefined && tld !== undefined ? REGION_HINTS[tag.language]?.[tld] : undefined;
    const locale = toLocale(hinted ? { language: tag.language, region: hinted } : tag);
    const source = locale.endsWith('-*') ? `${label} "${value}" names the language only (region unknown)` : `${label} "${value}" declares ${locale}`;
    return { source_locale: locale, evidence: hinted ? `${source} (region from .${tld})` : source };
  }

  const suffix = notes.length > 0 ? `; ${notes.join('; ')}` : '';
  if (language === 'und') return { source_locale: 'und', evidence: `language could not be determined${suffix}` };
  const region = tld !== undefined ? REGION_HINTS[language]?.[tld] : undefined;
  if (region) {
    return { source_locale: `${language}-${region}`, evidence: `ccTLD .${tld} suggests region ${region} for the ${language} text${suffix}` };
  }
  const locale = toLocale({ language });
  return { source_locale: locale, evidence: `language ${language}${locale.endsWith('-*') ? ', region unknown' : ` (defaults to ${locale})`}${suffix}` };
}
