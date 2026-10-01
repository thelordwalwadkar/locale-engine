/** Evidence discipline (spec success criterion 5): nothing leaves the pipeline without [EVIDENCE: …] or [HYPOTHESIS]. */
import { HYPOTHESIS_COUNSEL_TAG, HYPOTHESIS_TAG, hasEvidenceTag } from '../schemas/common.js';

/**
 * Model output without a tag is an unsupported claim: it is marked [HYPOTHESIS] rather than dressed up as evidence.
 * Returns the (possibly amended) text and whether it had to be amended (the caller logs EVIDENCE_TAG_ADDED).
 */
export function ensureTagged(text: string): { text: string; amended: boolean } {
  if (hasEvidenceTag(text)) return { text, amended: false };
  return { text: `${text.trimEnd()} ${HYPOTHESIS_TAG}`, amended: true };
}

/** `[HYPOTHESIS]` (or `[HYPOTHESIS] — verify with counsel`) prefix for a market recommendation; idempotent. */
export function hypothesisRecommendation(text: string, verifyWithCounsel = false): string {
  if (hasEvidenceTag(text)) return text;
  return `${verifyWithCounsel ? HYPOTHESIS_COUNSEL_TAG : HYPOTHESIS_TAG} ${text}`;
}
