/**
 * `conditional`: source-aware check (false friends, required forms). Only when the SOURCE matches `when_source` and not
 * `unless_source`: each `target_forbid` match is a finding; a non-empty `target_require` of which nothing matches is one finding.
 */
import { matchAll } from '../../util/regex.js';
import { matchCase } from '../../util/text.js';
import { NO_OUTCOME, quote, ruleTag, violation, type RuleOutcome, type Violation } from '../draft.js';
import { expandTemplate, rulePattern } from '../patterns.js';
import type { RuleOf, SegmentView } from '../segment.js';

export function evaluateConditional(rule: RuleOf<'conditional'>, seg: SegmentView): RuleOutcome {
  const trigger = matchAll(rulePattern(rule.when_source, rule.flags), seg.src.plain)[0];
  if (!trigger) return NO_OUTCOME;
  if (rule.unless_source && matchAll(rulePattern(rule.unless_source, rule.flags), seg.src.plain).length > 0) return NO_OUTCOME;
  // a catch-all trigger (`[\s\S]`) says nothing worth quoting
  const because = trigger.text.trim().length >= 3 ? ` for the source ${quote(trigger.text)}` : '';
  const plain = seg.tgt.plain;
  const taken = new Set<string>();
  const violations: Violation[] = [];
  for (const p of rule.target_forbid) {
    for (const m of matchAll(rulePattern(p, rule.flags), plain)) {
      const key = `${m.start}:${m.end}`;
      if (taken.has(key)) continue;
      taken.add(key);
      const replacement = rule.prefer !== undefined ? matchCase(m.text, expandTemplate(rule.prefer, m.groups)) : undefined;
      const span = seg.span(m.start, m.end);
      violations.push(
        violation(rule, {
          detail: `Found ${quote(m.text)}${because}${replacement !== undefined ? `; prefer ${quote(replacement)}` : ''}.`,
          segmentId: seg.input.segment_id,
          span,
          targetSpan: m.text,
          sourceSpan: trigger.text,
          fix: replacement !== undefined ? `Replace ${quote(m.text)} with ${quote(replacement)}.` : undefined,
          replacement: replacement !== undefined ? seg.safeReplacement(span, replacement) : undefined,
        }),
      );
    }
  }
  if (rule.target_require.length > 0 && !rule.target_require.some((p) => matchAll(rulePattern(p, rule.flags), plain).length > 0)) {
    violations.push(
      violation(rule, {
        detail: `The target contains none of the required forms${because}.`,
        segmentId: seg.input.segment_id,
        sourceSpan: trigger.text,
        fix: rule.prefer !== undefined ? `Use ${quote(rule.prefer)}.` : undefined,
      }),
    );
  }
  return { violations, passNote: `${ruleTag(rule)} The target avoids the forbidden forms${because}.` };
}
