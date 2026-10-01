/** `backtranslation_similarity`: token-F1 of source and back-translation, only when both are in the same language (heuristic). */
import { languageOf } from '../../schemas/index.js';
import { wordCount } from '../../util/text.js';
import { NO_OUTCOME, quote, ruleTag, violation, type RuleOutcome } from '../draft.js';
import type { RuleOf, SegmentView } from '../segment.js';
import { backTranslationSimilarity } from '../similarity.js';

/** Shorter sources give too few tokens for a meaningful overlap score. */
const MIN_SOURCE_WORDS = 6;

export function evaluateBackTranslation(rule: RuleOf<'backtranslation_similarity'>, seg: SegmentView): RuleOutcome {
  const bt = seg.input.back_translation;
  if (!bt || languageOf(bt.lang) !== seg.sourceLang || wordCount(seg.input.source_text) < MIN_SOURCE_WORDS) return NO_OUTCOME;
  const score = backTranslationSimilarity(seg.input.source_text, bt.text);
  const min = seg.ctx.thresholds.back_translation_similarity_min;
  if (score >= min) return { violations: [], passNote: `${ruleTag(rule)} Back-translation token-F1 ${score.toFixed(2)} (minimum ${min}).` };
  return {
    violations: [
      violation(rule, {
        detail: `Back-translation token-F1 is ${score.toFixed(2)}, below ${min}; the back-translation reads ${quote(bt.text)}.`,
        segmentId: seg.input.segment_id,
        sourceSpan: seg.src.plain,
      }),
    ],
  };
}
