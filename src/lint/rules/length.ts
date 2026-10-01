/** `length`: plain-text length in Unicode code points must not exceed `max_chars` (SEO title / meta description). */
import { charLength } from '../../util/text.js';
import { ruleTag, violation, type RuleOutcome } from '../draft.js';
import type { RuleOf, SegmentView } from '../segment.js';

export function evaluateLength(rule: RuleOf<'length'>, seg: SegmentView): RuleOutcome {
  const n = charLength(seg.input.target_text);
  if (n <= rule.max_chars) return { violations: [], passNote: `${ruleTag(rule)} ${n} of at most ${rule.max_chars} characters.` };
  return {
    violations: [
      violation(rule, {
        detail: `${n} characters, ${n - rule.max_chars} over the limit of ${rule.max_chars}.`,
        segmentId: seg.input.segment_id,
        span: seg.wholeSpan(),
        targetSpan: seg.tgt.plain,
      }),
    ],
  };
}
