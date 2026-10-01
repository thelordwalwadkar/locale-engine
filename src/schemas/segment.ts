/**
 * Segments and the ingested source document.
 *
 * INLINE MARKUP. A segment's `text` is natural-language text in which inline HTML elements are replaced by
 * numbered placeholders so that (a) the model can move a link inside a sentence without touching its URL,
 * and (b) a linter can verify structure:
 *
 *   `Bekijk onze <a1>centrifugaalpompen</a1> en <strong2>dompelpompen</strong2>.<br3/>`
 *   inline = { a1: {tag:'a', attrs:{href:'/pompen'}}, strong2: {tag:'strong'}, br3: {tag:'br'} }
 *
 * Placeholder names are `<tag><n>` (n unique within the segment). Literal `<` and `>` in prose are stored as
 * `&lt;` / `&gt;` (see `src/util/inline.ts`, the only place that encodes/decodes this format).
 */
import { z } from 'zod';
import { BlockTypeSchema, MetaKindSchema, PageTypeSchema } from './common.js';

export const INLINE_TAGS = ['a', 'strong', 'b', 'em', 'i', 'u', 'sup', 'sub', 'br', 'code', 'abbr', 'small', 'mark'] as const;
export const InlineTagNameSchema = z.enum(INLINE_TAGS);
export type InlineTagName = z.infer<typeof InlineTagNameSchema>;

export const InlineTagSchema = z.object({
  tag: InlineTagNameSchema,
  /** Attributes kept verbatim and never shown to the model (e.g. `href`). */
  attrs: z.record(z.string(), z.string()).default({}),
});
export type InlineTag = z.infer<typeof InlineTagSchema>;

/** Where a list item / table cell lives, so exports can rebuild `<ul>`/`<ol>`/`<table>`. */
export const SegmentGroupSchema = z.object({
  kind: z.enum(['list', 'table']),
  /** Stable group id within the document, e.g. `ul-1`, `ol-2`, `tbl-1`. */
  id: z.string(),
  ordered: z.boolean().optional(),
  /** 0-based item index within the list (document order). */
  index: z.number().int().min(0).optional(),
  /** Nesting depth for nested lists (0 = top level). */
  depth: z.number().int().min(0).optional(),
  row: z.number().int().min(0).optional(),
  col: z.number().int().min(0).optional(),
  header: z.boolean().optional(),
});
export type SegmentGroup = z.infer<typeof SegmentGroupSchema>;

export const LangDetectionSchema = z.object({
  /** ISO 639-1 (`nl`, `en`, `de`, `it`, …) or `und` when undetermined. */
  lang: z.string(),
  confidence: z.number().min(0).max(1),
  /** declared = caller said so; attribute = `<html lang>`; lib = local detector; llm = fallback; inherited = from document. */
  method: z.enum(['declared', 'attribute', 'lib', 'llm', 'inherited']),
});
export type LangDetection = z.infer<typeof LangDetectionSchema>;

export const SegmentSchema = z.object({
  /** `<prefix>-<NNN>` where prefix is h|p|li|td|alt|a and NNN the 1-based document order; meta segments use `meta-title`, `meta-description`, `meta-slug`, `meta-keyword`, … */
  segment_id: z.string().min(1),
  block_type: BlockTypeSchema,
  /** 1-based document order across all segments (meta first). */
  order: z.number().int().min(1),
  /** Source text with inline placeholders (see module comment). */
  text: z.string(),
  inline: z.record(z.string(), InlineTagSchema).default({}),
  /** Heading level 1–6. */
  level: z.number().int().min(1).max(6).optional(),
  meta_kind: MetaKindSchema.optional(),
  group: SegmentGroupSchema.optional(),
  /** `anchor` blocks: link target, never translated, byte-identical in output. */
  href: z.string().optional(),
  /** `alt` blocks: the image `src`, byte-identical in output. */
  src: z.string().optional(),
  /** First 12 hex chars of sha1(text); lets caches and diffs detect change. */
  hash: z.string(),
  /** false when the text has no natural-language words (only numbers, codes, units, URLs). Such segments skip the LLM. */
  translatable: z.boolean(),
  lang: LangDetectionSchema.optional(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const OriginKindSchema = z.enum(['url', 'file', 'text', 'page_json']);

export const SourceOriginSchema = z.object({
  kind: OriginKindSchema,
  /** URL, file path or a caller-supplied name. */
  ref: z.string(),
  final_url: z.string().optional(),
  fetched_at: z.string().optional(),
  http_status: z.number().int().optional(),
  content_type: z.string().optional(),
  robots: z.enum(['allowed', 'disallowed', 'unknown', 'not_applicable']).optional(),
});
export type SourceOrigin = z.infer<typeof SourceOriginSchema>;

export const KeywordOriginSchema = z.enum(['provided', 'meta_keywords', 'derived_h1', 'derived_title']);

export const SourceDocumentSchema = z.object({
  doc_id: z.string(),
  origin: SourceOriginSchema,
  page_type: PageTypeSchema,
  /** Why the page was classified CONTENT/LEGAL, e.g. `url path contains "privacyverklaring"`. */
  page_type_evidence: z.string(),
  /** `nl-NL`, `en-GB`, `en-*` (language known, region unknown). */
  source_locale: z.string(),
  source_locale_evidence: z.string(),
  /** ISO 639-1 primary language of the page. */
  source_language: z.string(),
  /** Page-level language detection result. */
  source_language_detection: LangDetectionSchema.optional(),
  head: z
    .object({
      html_lang: z.string().optional(),
      canonical: z.string().optional(),
    })
    .default({}),
  seo: z
    .object({
      primary_keyword: z.object({ text: z.string(), origin: KeywordOriginSchema }).optional(),
      /** Last path segment of the source URL (or derived from the title), as words separated by spaces. */
      source_slug: z.string().optional(),
    })
    .default({}),
  segments: z.array(SegmentSchema),
  warnings: z.array(z.string()).default([]),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

/** Prefixes used in `segment_id` per block type. */
export const SEGMENT_ID_PREFIX = {
  heading: 'h',
  paragraph: 'p',
  list_item: 'li',
  table_cell: 'td',
  alt: 'alt',
  anchor: 'a',
  meta: 'meta',
} as const;
