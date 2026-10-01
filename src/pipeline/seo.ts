/** SEO meta per locale (spec §4.3): localised title / description / slug, hreflang, and the translated primary keyword as a HYPOTHESIS. */
import { KEYWORD_STATUS } from '../schemas/report.js';
import type { SeoMeta } from '../schemas/report.js';
import { charLength } from '../util/text.js';
import { plainText } from '../util/inline.js';
import { slugify } from '../util/slug.js';
import type { LocaleContext, SegState } from './state.js';

function textOf(states: SegState[], pick: (s: SegState) => boolean): string | null {
  const s = states.find((x) => pick(x) && x.status === 'OK' && x.text !== null);
  if (!s || s.text === null) return null;
  const t = plainText(s.text).trim();
  return t === '' ? null : t;
}

export function buildSeoMeta(lc: LocaleContext, states: SegState[]): SeoMeta {
  const title = textOf(states, (s) => s.seg.meta_kind === 'title');
  const description = textOf(states, (s) => s.seg.meta_kind === 'description');
  const h1 = textOf(states, (s) => s.seg.block_type === 'heading' && s.seg.level === 1);
  const slugSeg = textOf(states, (s) => s.seg.meta_kind === 'slug');
  const slugOpts = { transliterate: lc.profile.slug.transliterate, stripDiacritics: lc.profile.slug.strip_diacritics };
  const slugSource = slugSeg ?? title ?? h1;
  const slug = slugSource ? slugify(slugSource, slugOpts) || null : null;

  const kw = lc.doc.seo.primary_keyword;
  const translated = textOf(states, (s) => s.seg.meta_kind === 'keyword');
  const primary: SeoMeta['primary_keyword'] = kw
    ? {
        source: kw.text,
        source_origin: kw.origin,
        translated,
        keyword_status: KEYWORD_STATUS,
        note: translated
          ? `[HYPOTHESIS] "${translated}" is a translation of "${kw.text}", not a market-validated search term; run keyword research for ${lc.target} before targeting it.`
          : `[HYPOTHESIS] No translation was produced for the primary keyword "${kw.text}"; run keyword research for ${lc.target}.`,
      }
    : null;

  const { title_max, meta_description_max } = lc.profile.seo;
  return {
    locale: lc.target,
    hreflang: lc.profile.hreflang,
    title,
    title_length: title ? charLength(title) : 0,
    title_max,
    title_ok: title !== null && charLength(title) <= title_max,
    meta_description: description,
    meta_description_length: description ? charLength(description) : 0,
    meta_description_max,
    meta_description_ok: description !== null && charLength(description) <= meta_description_max,
    slug,
    h1,
    primary_keyword: primary,
  };
}
