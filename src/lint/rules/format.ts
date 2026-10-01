/**
 * `format`: every number / currency amount / numeric date of the target follows the locale's `formatting` block. Never
 * auto-fixed here: converting is the normaliser's job (DDR-003), the finding only points at the offending token.
 */
import { joinList, quote, ruleTag, violation, type RuleOutcome } from '../draft.js';
import { formatOffences } from '../formats.js';
import type { RuleOf, SegmentView } from '../segment.js';

const NOUN = { number: 'number(s)', currency: 'amount(s)', date: 'numeric date(s)' } as const;

export function evaluateFormat(rule: RuleOf<'format'>, seg: SegmentView): RuleOutcome {
  const { checked, offences } = formatOffences(seg.targetEntities(), rule.aspect, seg.ctx.profile.formatting, seg.ctx.common);
  const violations = offences.map((o) =>
    violation(rule, {
      detail: `${quote(o.part.raw)} has ${joinList(o.problems)}; the locale writes ${quote(o.expected)}.`,
      segmentId: seg.input.segment_id,
      span: seg.span(o.part.start, o.part.end),
      targetSpan: o.part.raw,
      fix: `Write ${quote(o.expected)}.`,
    }),
  );
  if (checked === 0) return { violations };
  return { violations, passNote: `${ruleTag(rule)} ${checked} ${NOUN[rule.aspect]} follow the locale convention.` };
}
