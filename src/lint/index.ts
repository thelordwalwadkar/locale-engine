/**
 * Deterministic lint engine (ARCHITECTURE P2, P5, P9). The pipeline depends only on the names exported here; their signatures are
 * the contract in ./types.ts.
 */
export type * from './types.js';

/** Segment-level rules and document-level rules (first_mention, currency_policy; findings carry their segment_id or null). */
export { lintDocument, lintSegment } from './engine.js';
/** Reformat separators / currency position / numeric dates of `target_text` to the target locale; logs one change per difference. */
export { normalizeFormats } from './formats.js';
/** Apply `autofix` replacements of findings (right-to-left, skipping overlaps, no-ops and anything touching inline markup). */
export { applyAutofix } from './autofix.js';
/** Execute every `tests` entry of every rule of every locale (common rules once). */
export { runAllRuleTests } from './rule-tests.js';
/** Market-claim phrases in SOURCE plain text. */
export { findMarketClaims } from './claims.js';
/** Token-F1 (0..1) between two texts of the same language. */
export { backTranslationSimilarity } from './similarity.js';
