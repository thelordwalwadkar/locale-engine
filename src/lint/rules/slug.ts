/** `slug`: lowercase `a-z0-9` words joined by single hyphens; the autofix is `slugify` with the locale's transliteration. */
import { isValidSlug, slugify } from '../../util/slug.js';
import { quote, ruleTag, violation, type RuleOutcome } from '../draft.js';
import type { RuleOf, SegmentView } from '../segment.js';

export function evaluateSlug(rule: RuleOf<'slug'>, seg: SegmentView): RuleOutcome {
  const text = seg.tgt.plain;
  if (isValidSlug(text)) return { violations: [], passNote: `${ruleTag(rule)} ${quote(text)} is a valid slug.` };
  const { transliterate, strip_diacritics } = seg.ctx.profile.slug;
  const slug = slugify(text, { transliterate, stripDiacritics: strip_diacritics });
  const usable = slug !== '' && slug !== text;
  const span = seg.wholeSpan();
  return {
    violations: [
      violation(rule, {
        detail: usable ? `${quote(text)} is not a valid slug; the locale's slug is ${quote(slug)}.` : `${quote(text)} is not a valid slug.`,
        segmentId: seg.input.segment_id,
        span,
        targetSpan: text,
        fix: usable ? `Replace ${quote(text)} with ${quote(slug)}.` : undefined,
        replacement: usable ? seg.safeReplacement(span, slug) : undefined,
      }),
    ],
  };
}
