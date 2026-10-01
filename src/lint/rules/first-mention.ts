/**
 * `first_mention` (document level): when any source segment matches `when_source`, the first `term` occurrence across the target
 * segments (document order) must be the start of a `required_form` match (BTW -> "VAT (BTW)" on first mention in en-NL).
 */
import { escapeLiteral, mapPlainSpan, plainText, plainTextWithMap, tokenizeInline } from '../../util/inline.js';
import { matchAll } from '../../util/regex.js';
import { NO_OUTCOME, quote, ruleTag, violation, type RuleOutcome } from '../draft.js';
import { rulePattern, stickyPattern } from '../patterns.js';
import type { RuleOf } from '../segment.js';
import type { LintSegmentInput } from '../types.js';

/** `inputs` are the in-scope segments in document order. */
export function evaluateFirstMention(rule: RuleOf<'first_mention'>, inputs: LintSegmentInput[]): RuleOutcome {
  const when = rulePattern(rule.when_source, rule.flags);
  const trigger = inputs.map((i) => matchAll(when, plainText(i.source_text))[0]).find((m) => m !== undefined);
  if (!trigger) return NO_OUTCOME;
  const term = rulePattern(rule.term, rule.flags);
  for (const input of inputs) {
    const map = plainTextWithMap(input.target_text);
    const first = matchAll(term, map.plain)[0];
    if (!first) continue;
    const required = stickyPattern(rule.required_form, rule.flags);
    required.lastIndex = first.start;
    if (required.test(map.plain)) return { violations: [], passNote: `${ruleTag(rule)} The first mention uses the required form.` };
    const span = mapPlainSpan(map, first.start, first.end);
    const inside = input.target_text.slice(span.start, span.end);
    const safe = rule.prefer !== undefined && tokenizeInline(inside).every((t) => t.kind === 'text');
    return {
      violations: [
        violation(rule, {
          detail: `The first mention ${quote(first.text)} is not written in the required form${rule.prefer !== undefined ? ` ${quote(rule.prefer)}` : ''}.`,
          segmentId: input.segment_id,
          span,
          targetSpan: first.text,
          sourceSpan: trigger.text,
          fix: rule.prefer !== undefined ? `Replace the first ${quote(first.text)} with ${quote(rule.prefer)}.` : undefined,
          replacement: safe && rule.prefer !== undefined ? escapeLiteral(rule.prefer) : undefined,
        }),
      ],
    };
  }
  return NO_OUTCOME;
}
