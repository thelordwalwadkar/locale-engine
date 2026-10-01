/**
 * The exporters render untrusted text (scraped pages, model output). Text and attribute VALUES are always escaped; this module
 * removes what escaping cannot: event-handler attributes and URL schemes that run script.
 */
import type { InlineTag } from '../schemas/index.js';

/** Attributes that may survive from the source markup. Everything else (`onclick`, `style`, …) is dropped. */
const ALLOWED_ATTRS = new Set(['href', 'title', 'target', 'rel', 'lang', 'dir', 'hreflang', 'class']);

/** Schemes that execute or embed active content when followed. Relative URLs, http(s), mailto, tel, … are never touched. */
const ACTIVE_SCHEME = /^(?:javascript|vbscript|data):/i;
const PASSIVE_IMAGE_DATA = /^data:image\/(?:png|gif|jpe?g|webp|avif)[;,]/i;

/** What a blocked URL is replaced with; the original travels in an inert `data-blocked-…` attribute so nothing is lost. */
export const BLOCKED_URL = '#';

/**
 * True when following (or, with `image`, embedding) `url` could run script. Browsers ignore control characters and spaces inside
 * the scheme (`java\tscript:`), so they are removed before the test.
 */
export function isActiveUrl(url: string, opts: { image?: boolean } = {}): boolean {
  const compact = url.replace(/[\u0000- ]/g, '');
  if (opts.image && PASSIVE_IMAGE_DATA.test(compact)) return false;
  return ACTIVE_SCHEME.test(compact);
}

/** A copy of a segment's inline table that is safe to pass to `renderInlineHtml` / `renderInlineMarkdown`. */
export function safeInline(inline: Record<string, InlineTag>): Record<string, InlineTag> {
  const out: Record<string, InlineTag> = {};
  for (const [key, def] of Object.entries(inline)) {
    const attrs: Record<string, string> = {};
    for (const [name, value] of Object.entries(def.attrs)) {
      const lower = name.toLowerCase();
      if (!ALLOWED_ATTRS.has(lower)) continue;
      if (lower === 'href' && isActiveUrl(value)) {
        attrs['href'] = BLOCKED_URL;
        attrs['data-blocked-href'] = value;
      } else {
        attrs[lower] = value;
      }
    }
    out[key] = { tag: def.tag, attrs };
  }
  return out;
}

/** Text that can sit inside an HTML comment: no `--`, and nothing that could open or close a comment early. */
export function commentSafe(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/-{2,}/g, '-').replace(/[<>]/g, '');
}
