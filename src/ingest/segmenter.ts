/**
 * Parsed content -> `SourceDocument` of typed, stably identified segments.
 *
 * Ids: body blocks are numbered 1..n in document order across all types (`h-001`, `p-002`, `li-003`, `td-004`, `alt-005`, `a-006`);
 * meta segments come first (`meta-title`, `meta-description`, `meta-slug`, `meta-keyword`, `meta-og_title`, `meta-og_description`)
 * and only `order` continues across both. Nothing random or time-dependent goes into ids, hashes or `doc_id`, so the same input
 * always produces the same document.
 */
import {
  SEGMENT_ID_PREFIX,
  type MetaKind,
  type PageType,
  type Segment,
  type SourceDocument,
  type SourceOrigin,
} from '../schemas/index.js';
import { escapeLiteral } from '../util/inline.js';
import { slugWordsFromUrlPath } from '../util/slug.js';
import { hashText, hasNaturalLanguage } from '../util/text.js';
import type { ParsedHtml } from './html_parser.js';

export interface BuildDocumentArgs {
  origin: SourceOrigin;
  parsed: ParsedHtml;
  /** `entities.symbol_units` of `config/locales/_common.yaml`: words that are really units do not make a segment translatable. */
  symbolUnits: readonly string[];
  page_type: PageType;
  page_type_evidence: string;
  source_locale: string;
  source_locale_evidence: string;
  /** Attribute / declared language; the detector refines it later. */
  source_language: string;
  /** Where the source slug comes from: the page address, or a path-like caller label. Otherwise the title is used. */
  slugSource?: { url?: string; name?: string };
  /** Caller-provided primary keyword. */
  primaryKeyword?: string;
  warnings?: string[];
}

/**
 * `hasNaturalLanguage` backtracks quadratically on very long runs without whitespace (base64 blobs, minified noise: 50 000 characters
 * take seconds). Such runs are not words, so they are blanked before the check.
 */
function scannable(text: string): string {
  return text.replace(/\S{257,}/g, ' ');
}

type PrimaryKeyword = NonNullable<SourceDocument['seo']['primary_keyword']>;

/** Brand suffixes follow the topic in page titles: "Dompelpompen | Van Dijk Pompen" -> "Dompelpompen". */
function titleHead(title: string): string {
  return (title.split(/\s+[|–—·•-]\s+|\s*\|\s*/)[0] ?? title).trim();
}

function words(text: string): string {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
}

/** Slug words in lower case (`slugWordsFromUrlPath` keeps the case of the path). */
function pathWords(urlOrPath: string): string {
  try {
    return slugWordsFromUrlPath(urlOrPath).toLowerCase();
  } catch {
    return ''; // malformed percent-escapes: no usable slug
  }
}

/** A file name such as `index.html` or a numeric id is not a slug worth translating. */
function isUsableSlug(slug: string): boolean {
  return slug !== '' && !/^\d+$/.test(slug) && !/^(?:index|default|home|start|main)$/i.test(slug);
}

/**
 * Where the slug words come from, strongest first: the fetched URL, a front-matter slug, the page's own `<link rel="canonical">`
 * (a saved page still names its address), a path-like caller label, the title head.
 */
function sourceSlug(args: BuildDocumentArgs, title: string | undefined): string | undefined {
  const { url, name } = args.slugSource ?? {};
  let slug: string;
  if (url !== undefined) slug = pathWords(url);
  else if (args.parsed.slug !== undefined) slug = pathWords(args.parsed.slug);
  else {
    const fromCanonical = args.parsed.canonical !== undefined ? pathWords(args.parsed.canonical) : '';
    if (isUsableSlug(fromCanonical)) slug = fromCanonical;
    else if (name !== undefined && name.includes('/')) slug = pathWords(name);
    else slug = title !== undefined ? words(titleHead(title)).split(' ').slice(0, 8).join(' ') : '';
  }
  return isUsableSlug(slug) ? slug : undefined;
}

function pickKeyword(args: BuildDocumentArgs): PrimaryKeyword | undefined {
  const { parsed } = args;
  const provided = args.primaryKeyword?.trim();
  if (provided) return { text: provided, origin: 'provided' };
  const fromMeta = parsed.meta_keywords
    ?.split(/[,;]/)
    .map((k) => k.trim())
    .find((k) => k !== '');
  if (fromMeta) return { text: fromMeta, origin: 'meta_keywords' };
  if (parsed.h1) return { text: parsed.h1, origin: 'derived_h1' };
  const fromTitle = parsed.title !== undefined ? titleHead(parsed.title) : '';
  return fromTitle !== '' ? { text: fromTitle, origin: 'derived_title' } : undefined;
}

type Draft = Pick<Segment, 'segment_id' | 'block_type' | 'order' | 'text' | 'inline'> &
  Partial<Pick<Segment, 'level' | 'meta_kind' | 'group' | 'href' | 'src'>>;

export function buildDocument(args: BuildDocumentArgs): SourceDocument {
  const { parsed } = args;
  const seal = (d: Draft): Segment => ({ ...d, hash: hashText(d.text), translatable: hasNaturalLanguage(scannable(d.text), args.symbolUnits) });

  const title = parsed.title ?? parsed.h1;
  const slug = sourceSlug(args, title);
  const keyword = pickKeyword(args);
  const same = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && words(a) === words(b);

  const metas: Array<{ kind: MetaKind; text: string }> = [];
  if (title) metas.push({ kind: 'title', text: title });
  if (parsed.meta_description) metas.push({ kind: 'description', text: parsed.meta_description });
  if (slug) metas.push({ kind: 'slug', text: slug });
  if (keyword) metas.push({ kind: 'keyword', text: keyword.text });
  if (parsed.og_title && !same(parsed.og_title, title)) metas.push({ kind: 'og_title', text: parsed.og_title });
  if (parsed.og_description && !same(parsed.og_description, parsed.meta_description)) {
    metas.push({ kind: 'og_description', text: parsed.og_description });
  }

  const segments: Segment[] = [];
  let order = 0;
  for (const m of metas) {
    segments.push(seal({ segment_id: `meta-${m.kind}`, block_type: 'meta', order: ++order, text: escapeLiteral(m.text), inline: {}, meta_kind: m.kind }));
  }
  let n = 0;
  for (const b of parsed.blocks) {
    n++;
    const draft: Draft = {
      segment_id: `${SEGMENT_ID_PREFIX[b.block_type]}-${String(n).padStart(3, '0')}`,
      block_type: b.block_type,
      order: ++order,
      text: b.text,
      inline: b.inline,
    };
    if (b.level !== undefined) draft.level = b.level;
    if (b.group !== undefined) draft.group = b.group;
    if (b.href !== undefined) draft.href = b.href;
    if (b.src !== undefined) draft.src = b.src;
    segments.push(seal(draft));
  }

  const head: SourceDocument['head'] = {};
  if (parsed.html_lang !== undefined) head.html_lang = parsed.html_lang;
  if (parsed.canonical !== undefined) head.canonical = parsed.canonical;
  const seo: SourceDocument['seo'] = {};
  if (keyword) seo.primary_keyword = keyword;
  if (slug) seo.source_slug = slug;

  return {
    doc_id: `doc-${hashText([args.origin.kind, args.origin.ref, ...segments.map((s) => `${s.segment_id}:${s.hash}`)].join('\n'))}`,
    origin: args.origin,
    page_type: args.page_type,
    page_type_evidence: args.page_type_evidence,
    source_locale: args.source_locale,
    source_locale_evidence: args.source_locale_evidence,
    source_language: args.source_language,
    head,
    seo,
    segments,
    warnings: [...new Set([...(args.warnings ?? []), ...parsed.warnings])],
  };
}
