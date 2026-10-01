/** `untranslated`: a translatable segment whose target equals the source although the languages differ. */
import type { Operation } from '../../schemas/index.js';
import { wordCount } from '../../util/text.js';
import { NO_OUTCOME, ruleTag, violation, type RuleOutcome } from '../draft.js';
import type { RuleOf, SegmentView } from '../segment.js';

const TRANSLATING: ReadonlySet<Operation> = new Set(['TRANSLATE_LOCALIZE', 'TRANSLATE_ONLY']);

const normalized = (s: string): string => s.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();

export function evaluateUntranslated(rule: RuleOf<'untranslated'>, seg: SegmentView): RuleOutcome {
  const { input, ctx } = seg;
  if (!TRANSLATING.has(input.operation) || !input.translatable || seg.sourceLang === ctx.profile.language) return NO_OUTCOME;
  if (wordCount(input.source_text) < rule.min_words) return NO_OUTCOME;
  if (normalized(seg.tgt.plain) !== normalized(seg.src.plain)) return { violations: [], passNote: `${ruleTag(rule)} The target differs from the source.` };
  return {
    violations: [
      violation(rule, {
        detail: `The ${ctx.target} target is identical to the ${seg.sourceLang} source.`,
        segmentId: input.segment_id,
        span: seg.wholeSpan(),
        targetSpan: seg.tgt.plain,
        sourceSpan: seg.src.plain,
      }),
    ],
  };
}
