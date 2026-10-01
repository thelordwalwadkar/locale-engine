/**
 * Read-only views over the report schemas that every exporter shares (markdown, html, xlsx, executive summary).
 * Nothing in here formats output; it decides WHAT a human gets to see, so the four renderers cannot disagree.
 */
import type { Finding, LocaleResult, SegmentResult, Severity, Stage, StageBinding } from '../schemas/index.js';
import { STAGES } from '../schemas/index.js';
import { plainText } from '../util/inline.js';
import { normalizeWhitespace } from '../util/text.js';

export const SEVERITIES_WORST_FIRST: readonly Severity[] = ['critical', 'major', 'minor'];

/** Segments in document order; segments with an equal `order` keep their array order. */
export function bySourceOrder(segments: readonly SegmentResult[]): SegmentResult[] {
  return segments
    .map((seg, index) => ({ seg, index }))
    .sort((a, b) => a.seg.order - b.seg.order || a.index - b.index)
    .map((x) => x.seg);
}

/**
 * Visible stand-in for a segment that has no usable output, e.g. `[PROVIDER_ERROR: p-003]`; null when the segment has text.
 * A segment that claims `OK` but carries no text is reported as `NO_OUTPUT` rather than silently rendered empty.
 */
export function unresolvedMarker(seg: SegmentResult): string | null {
  if (seg.status === 'OK' && seg.final_text !== null) return null;
  return `[${seg.status === 'OK' ? 'NO_OUTPUT' : seg.status}: ${seg.segment_id}]`;
}

/** Every finding of a locale: per-segment findings in document order, then the document-level ones. */
export function localeFindings(locale: LocaleResult): Finding[] {
  const fromSegments = bySourceOrder(locale.segments).flatMap((seg) => seg.validation?.findings ?? []);
  return [...fromSegments, ...locale.document_findings];
}

export function openFindingCounts(locale: LocaleResult): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0 };
  for (const f of localeFindings(locale)) if (f.status === 'open') counts[f.severity]++;
  return counts;
}

function bindingLabel(binding: StageBinding): string {
  return `${binding.provider}:${binding.model}`;
}

/** `translation: anthropic:claude-x · localization: openai:gpt-y` in pipeline order; empty string when nothing is bound. */
export function describeProviders(providers: Partial<Record<Stage, StageBinding>>): string {
  const parts: string[] = [];
  for (const stage of STAGES) {
    const binding = providers[stage];
    if (binding) parts.push(`${stage}: ${bindingLabel(binding)}`);
  }
  return parts.join(' · ');
}

/** The most frequent reasons why segments of this locale need a human, most frequent first (ties keep document order). */
export function topReviewReasons(locale: LocaleResult, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const seg of bySourceOrder(locale.segments)) {
    for (const reason of seg.review_reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, n]) => (n > 1 ? `${reason} (×${n})` : reason));
}

/** Text of a meta value as a single plain line (placeholders stripped); null when absent or blank. */
function oneLinePlain(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const value = normalizeWhitespace(plainText(text));
  return value === '' ? null : value;
}

type MetaField = 'title' | 'description' | 'slug';
const META_FIELDS: readonly MetaField[] = ['title', 'description', 'slug'];

function metaSegment(locale: LocaleResult, kind: MetaField): SegmentResult | undefined {
  return locale.segments.find((seg) => seg.block_type === 'meta' && seg.meta_kind === kind);
}

/**
 * Page title, meta description and slug of a locale. `seo_meta` wins (it holds the post-processed values, e.g. the final slug);
 * the `meta` segments are the fallback when the pipeline left a field empty.
 */
export function resolvedMeta(locale: LocaleResult): Record<MetaField, string | null> {
  const fromSegment = (kind: MetaField): string | null => {
    const seg = metaSegment(locale, kind);
    return seg && seg.status === 'OK' ? oneLinePlain(seg.final_text) : null;
  };
  return {
    title: oneLinePlain(locale.seo_meta.title) ?? fromSegment('title'),
    description: oneLinePlain(locale.seo_meta.meta_description) ?? fromSegment('description'),
    slug: oneLinePlain(locale.seo_meta.slug) ?? fromSegment('slug'),
  };
}

/** Plain text of the first resolved level-1 heading; used as the page title when `seo_meta` has none. */
export function firstH1(locale: LocaleResult): string | null {
  for (const seg of bySourceOrder(locale.segments)) {
    if (seg.block_type === 'heading' && seg.level === 1 && seg.status === 'OK') return oneLinePlain(seg.final_text);
  }
  return null;
}

/**
 * Problems of the title/description/slug segments that cannot be shown in the body (meta segments are not body blocks):
 * an unresolved segment (`[PROVIDER_ERROR: meta-title]`) or one that needs a human (`review: meta-title`).
 */
export function metaNotes(locale: LocaleResult): Array<{ field: MetaField; note: string }> {
  const notes: Array<{ field: MetaField; note: string }> = [];
  for (const field of META_FIELDS) {
    const seg = metaSegment(locale, field);
    if (!seg) continue;
    const parts = [unresolvedMarker(seg), seg.requires_human_review ? `review: ${seg.segment_id}` : null].filter((p): p is string => p !== null);
    if (parts.length > 0) notes.push({ field, note: parts.join(' ') });
  }
  return notes;
}

/** Valid ISO timestamp -> Date, anything else -> null (callers then show the raw string). */
export function parseTimestamp(ts: string): Date | null {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** What is shown instead of a score or penalty when validation did not run. */
export const NOT_VALIDATED_LABEL = 'n/a (not validated)';

/**
 * Translate-only and localize-only runs skip validation: the locale then carries a `NOT_VALIDATED…` verdict reason and a score
 * of 100 that only means "no findings", never "verified". Pass `validationEnabled = report.options.stages.validate` when the
 * run options are at hand; the verdict reason alone is used otherwise (a `page.json` has no run options).
 */
export function isUnvalidated(locale: LocaleResult, validationEnabled = true): boolean {
  return !validationEnabled || locale.verdict_reasons.some((reason) => reason.startsWith('NOT_VALIDATED'));
}
