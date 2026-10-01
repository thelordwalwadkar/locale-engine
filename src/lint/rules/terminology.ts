/**
 * `terminology` (soft glossary check): for each glossary term found in the source, one of the target locale's approved forms must
 * occur in the target (case-insensitive substring). Do-not-translate hits are the entity rule's business.
 */
import { findGlossaryHits } from '../../config/glossary.js';
import { quote, ruleTag, violation, type RuleOutcome, type Violation } from '../draft.js';
import type { RuleOf, SegmentView } from '../segment.js';

const normalized = (s: string): string => s.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ');

export function evaluateTerminology(rule: RuleOf<'terminology'>, seg: SegmentView): RuleOutcome {
  const { ctx } = seg;
  const target = normalized(seg.tgt.plain);
  const seen = new Set<string>();
  const violations: Violation[] = [];
  let checked = 0;
  for (const hit of findGlossaryHits(seg.src.plain, seg.sourceLang, ctx.glossary)) {
    if (hit.do_not_translate || seen.has(hit.term_id)) continue;
    seen.add(hit.term_id);
    const forms = hit.targets[ctx.target] ?? [];
    if (forms.length === 0) continue;
    checked++;
    if (forms.some((f) => target.includes(normalized(f)))) continue;
    violations.push(
      violation(rule, {
        detail: `The source term ${quote(hit.matched)} (${hit.term_id}) is not rendered with an approved ${ctx.target} form: ${forms.map(quote).join(' / ')}.`,
        segmentId: seg.input.segment_id,
        sourceSpan: hit.matched,
        fix: `Use ${quote(forms[0] ?? '')} (${hit.term_id}).`,
      }),
    );
  }
  if (checked === 0) return { violations };
  return { violations, passNote: `${ruleTag(rule)} ${checked - violations.length} of ${checked} glossary term(s) rendered with an approved form.` };
}
