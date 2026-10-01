/**
 * `empty_output`: non-empty source, empty target — unless the localizer deliberately removed a segment that is essentially only a
 * market claim (a market-claim change to "" and, apart from the claim, at most two words and no figures in the source).
 */
import { NO_OUTCOME, violation, type RuleOutcome } from '../draft.js';
import type { RuleOf, SegmentView } from '../segment.js';

function isClaimRemoval(seg: SegmentView): boolean {
  const claimRule = seg.ctx.profile.effective_rules.find((r) => r.type === 'market_claim')?.id ?? 'INTEGRITY-MARKET-CLAIM';
  if (!(seg.input.changes ?? []).some((c) => c.rule === claimRule && c.to.trim() === '')) return false;
  const claims = seg.sourceClaims();
  if (claims.length === 0) return false;
  let rest = seg.src.plain;
  for (const c of [...claims].reverse()) rest = `${rest.slice(0, c.span.start)} ${rest.slice(c.span.end)}`;
  return (rest.match(/[\p{L}\p{N}]+/gu) ?? []).length <= 2 && !/\p{N}/u.test(rest);
}

export function evaluateEmptyOutput(rule: RuleOf<'empty_output'>, seg: SegmentView): RuleOutcome {
  if (seg.src.plain.trim() === '' || seg.tgt.plain.trim() !== '' || isClaimRemoval(seg)) return NO_OUTCOME;
  return {
    violations: [
      violation(rule, {
        detail: 'The target is empty.',
        segmentId: seg.input.segment_id,
        span: seg.wholeSpan(),
        sourceSpan: seg.src.plain,
      }),
    ],
  };
}
