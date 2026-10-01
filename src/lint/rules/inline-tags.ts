/** `inline_tags`: every source placeholder survives exactly once and the target nests properly (order may change). */
import { placeholderSignature, verifyInline } from '../../util/inline.js';
import { joinList, ruleTag, violation, type RuleOutcome, type Violation } from '../draft.js';
import type { RuleOf, SegmentView } from '../segment.js';

/** `open:a1` -> `<a1>`, `close:a1` -> `</a1>`, `self:br3` -> `<br3/>`. */
function readable(signature: string): string {
  const [kind, key] = signature.split(':');
  if (kind === 'open') return `<${key}>`;
  return kind === 'close' ? `</${key}>` : `<${key}/>`;
}

const plural = (n: number, word: string): string => (n === 1 ? word : `${word}s`);

export function evaluateInlineTags(rule: RuleOf<'inline_tags'>, seg: SegmentView): RuleOutcome {
  const v = verifyInline(seg.input.source_text, seg.input.target_text);
  const segmentId = seg.input.segment_id;
  const violations: Violation[] = [];
  if (v.missing.length > 0) {
    const list = v.missing.map(readable).join(', ');
    violations.push(violation(rule, { detail: `Missing ${plural(v.missing.length, 'placeholder')}: ${list}.`, segmentId, fix: `Restore ${list}.` }));
  }
  if (v.extra.length > 0) {
    const list = v.extra.map(readable).join(', ');
    violations.push(violation(rule, { detail: `${plural(v.extra.length, 'Placeholder')} not in the source (invented or duplicated): ${list}.`, segmentId, fix: `Remove ${list}.` }));
  }
  if (v.unbalanced.length > 0) {
    violations.push(violation(rule, { detail: `${plural(v.unbalanced.length, 'Nesting problem')}: ${v.unbalanced.join(', ')}.`, segmentId }));
  }
  const keys = [...new Set(placeholderSignature(seg.input.source_text).map((s) => s.split(':')[1] ?? s))];
  if (keys.length === 0) return { violations };
  return { violations, passNote: `${ruleTag(rule)} ${plural(keys.length, 'Placeholder')} ${joinList(keys)} preserved and properly nested.` };
}
