/**
 * URL slugs (spec §4.3): lowercase, hyphenated, umlauts transliterated (ä→ae, ö→oe, ü→ue, ß→ss) where the locale profile says so,
 * remaining diacritics stripped.
 */
export interface SlugOptions {
  /** Applied after lower-casing and BEFORE diacritic stripping (`slug.transliterate` of the locale profile). */
  transliterate?: Record<string, string>;
  /** Strip remaining combining marks (é→e, ì→i). Default true. */
  stripDiacritics?: boolean;
  /** Hard cap on length (cut at a hyphen boundary). Default: none. */
  maxLength?: number;
}

export function slugify(text: string, opts: SlugOptions = {}): string {
  let s = text.normalize('NFC').toLowerCase();
  for (const [from, to] of Object.entries(opts.transliterate ?? {})) {
    s = s.split(from.toLowerCase()).join(to);
  }
  if (opts.stripDiacritics !== false) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s
    .replace(/&/g, ' ')
    .replace(/['’`´]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (opts.maxLength && s.length > opts.maxLength) {
    s = s.slice(0, opts.maxLength);
    const cut = s.lastIndexOf('-');
    if (cut > 0 && cut >= opts.maxLength * 0.6) s = s.slice(0, cut);
    s = s.replace(/-+$/g, '');
  }
  return s;
}

export function isValidSlug(s: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
}

/** `/producten/Centrifugaal-Pompen/?x=1` -> `centrifugaal pompen` (words, for translating a source slug). Empty string if none. */
export function slugWordsFromUrlPath(urlOrPath: string): string {
  let p = urlOrPath;
  try {
    p = new URL(urlOrPath, 'http://x.invalid').pathname;
  } catch {
    /* keep as is */
  }
  const last = p.split('/').filter(Boolean).pop() ?? '';
  // Throws URIError for a malformed percent-escape: callers treat that as "no usable slug" rather than guessing.
  return decodeURIComponent(last)
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[-_+]+/g, ' ')
    .trim()
    .toLowerCase();
}
