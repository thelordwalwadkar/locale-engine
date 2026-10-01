/**
 * Findings, changes and validation results. The shapes of `Change`, `DeterministicCheck`, `MqmError`, and the judge block
 * follow the golden exemplar (spec §5.1) exactly; additional fields are additive.
 */
import { z } from 'zod';
import { LocaleCodeSchema, SeveritySchema, SpanSchema, TaggedTextSchema, VerdictSchema } from './common.js';

// ---------------------------------------------------------------------------------------------------------------
// Changes (localization / repair) — every one has a rule id (R4)
// ---------------------------------------------------------------------------------------------------------------

export const ChangeOriginSchema = z.enum(['llm', 'deterministic', 'repair']);
export const ChangeSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** Rule id (e.g. `DECH-LEX-OFFERTE`, `INTEGRITY-MARKET-CLAIM`). Never empty. */
  rule: z.string().min(1),
  /** Carries `[EVIDENCE: …]` or `[HYPOTHESIS]`. */
  reason: TaggedTextSchema,
  origin: ChangeOriginSchema.default('llm'),
});
export type Change = z.infer<typeof ChangeSchema>;

/** Numeric / currency / date reformat (spec §4.4, success criterion 6). */
export const FormatChangeSchema = z.object({
  type: z.literal('FORMAT_CHANGE').default('FORMAT_CHANGE'),
  segment_id: z.string(),
  locale: LocaleCodeSchema,
  aspect: z.enum(['number', 'currency', 'date']),
  from: z.string(),
  to: z.string(),
  /** The locale's `format` rule id for that aspect, e.g. `DECH-NUM-01`. */
  rule: z.string().min(1),
  note: z.string().optional(),
  /** deterministic = the normaliser rewrote it; llm = the model had already produced the target form. */
  origin: z.enum(['deterministic', 'llm']).default('deterministic'),
});
export type FormatChange = z.infer<typeof FormatChangeSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------------------------

export const FindingOriginSchema = z.enum(['deterministic', 'llm_judge', 'pipeline']);
export const FindingStatusSchema = z.enum(['open', 'fixed', 'accepted']);

export const FindingSchema = z.object({
  finding_id: z.string(),
  locale: LocaleCodeSchema,
  /** null for document-level findings. */
  segment_id: z.string().nullable(),
  origin: FindingOriginSchema,
  /** Rule id for deterministic/pipeline findings; MQM category for judge findings. */
  rule_or_category: z.string(),
  severity: SeveritySchema,
  /** The tag alone: `[EVIDENCE: DECH-SZ-01]` or `[HYPOTHESIS]`. */
  evidence: z.string(),
  /** Human-readable explanation; contains the evidence tag. */
  explanation: TaggedTextSchema,
  source_span: z.string().nullable(),
  target_span: z.string().nullable(),
  /** Offsets into the evaluated (placeholder-bearing) target text; drives span-scoped repair. */
  span: SpanSchema.nullable(),
  suggested_fix: z.string().nullable(),
  /** Deterministic replacement for `span` when the rule is safely auto-fixable. */
  autofix: z.object({ replacement: z.string() }).nullable(),
  requires_human_review: z.boolean(),
  /** Whether this finding alone is enough to start a repair loop. */
  repair_trigger: z.boolean(),
  status: FindingStatusSchema,
});
export type Finding = z.infer<typeof FindingSchema>;

/** What the linter / judge adapter returns; the pipeline adds id, locale and status. */
export const FindingDraftSchema = FindingSchema.omit({ finding_id: true, locale: true, status: true });
export type FindingDraft = z.infer<typeof FindingDraftSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Validation results
// ---------------------------------------------------------------------------------------------------------------

export const DeterministicCheckSchema = z.object({
  rule: z.string(),
  result: z.enum(['PASS', 'FAIL', 'WARN']),
  /** Carries `[EVIDENCE: …]` (golden: `[EVIDENCE: DECH-SZ-01] No ß present.`). */
  note: TaggedTextSchema,
  severity: SeveritySchema.optional(),
});
export type DeterministicCheck = z.infer<typeof DeterministicCheckSchema>;

export const MqmErrorSchema = z.object({
  category: z.string(),
  severity: SeveritySchema,
  source_span: z.string(),
  target_span: z.string(),
  explanation: TaggedTextSchema,
  suggested_fix: z.string(),
});
export type MqmError = z.infer<typeof MqmErrorSchema>;

export const JudgeScoresSchema = z.object({
  accuracy: z.number().min(0).max(100),
  fluency: z.number().min(0).max(100),
  terminology: z.number().min(0).max(100),
  locale_conventions: z.number().min(0).max(100),
  style_brand: z.number().min(0).max(100),
});
export type JudgeScores = z.infer<typeof JudgeScoresSchema>;

export const LlmJudgeSchema = z.object({
  scores: JudgeScoresSchema,
  mqm_errors: z.array(MqmErrorSchema),
  /** Judge's self-reported confidence 0–1; < `thresholds.judge_confidence_min` forces HUMAN_REVIEW. */
  confidence: z.number().min(0).max(1),
});
export type LlmJudge = z.infer<typeof LlmJudgeSchema>;

export const SegmentValidationSchema = z.object({
  segment_id: z.string(),
  target_locale: LocaleCodeSchema,
  deterministic_checks: z.array(DeterministicCheckSchema),
  llm_judge: LlmJudgeSchema.nullable(),
  back_translation: z.string().nullable(),
  /** Token-F1 vs the source when both are in the same language, else null. */
  back_translation_similarity: z.number().min(0).max(1).nullable(),
  /** `max(0, 100 − penalty)`. */
  quality_score: z.number().min(0).max(100),
  /** Σ severity weights × 100 / max(words, words_floor). */
  penalty: z.number().min(0),
  word_count: z.number().int().min(0),
  verdict: VerdictSchema,
  /** Why this verdict, e.g. `HUMAN_REVIEW: business claim neutralised [EVIDENCE: INTEGRITY-MARKET-CLAIM]`. */
  verdict_reasons: z.array(z.string()),
  localization_recommendations: z.array(z.string()),
  findings: z.array(FindingSchema),
});
export type SegmentValidation = z.infer<typeof SegmentValidationSchema>;
