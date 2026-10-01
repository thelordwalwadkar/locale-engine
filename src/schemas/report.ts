/**
 * Per-segment results, per-locale results (`page.json`) and the run report. Exporters (json/md/html/xlsx) are driven
 * entirely by these schemas.
 */
import { z } from 'zod';
import {
  BlockTypeSchema,
  LocaleCodeSchema,
  MetaKindSchema,
  OperationSchema,
  PageTypeSchema,
  RunStatusSchema,
  StageSchema,
  TaggedTextSchema,
  VerdictSchema,
} from './common.js';
import { ChangeSchema, FindingSchema, FormatChangeSchema, SegmentValidationSchema } from './findings.js';
import { InlineTagSchema, KeywordOriginSchema, SegmentGroupSchema } from './segment.js';

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------------------------------------------
// Repairs
// ---------------------------------------------------------------------------------------------------------------

export const RepairRecordSchema = z.object({
  loop: z.number().int().min(1),
  segment_id: z.string(),
  span_id: z.string(),
  span: z.object({ start: z.number().int(), end: z.number().int() }),
  before: z.string(),
  after: z.string(),
  rule: z.string(),
  reason: TaggedTextSchema,
  /** autofix = deterministic rewrite; llm = span-scoped model repair. */
  origin: z.enum(['autofix', 'llm']),
});
export type RepairRecord = z.infer<typeof RepairRecordSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Segment result
// ---------------------------------------------------------------------------------------------------------------

export const SegmentStatusSchema = z.enum(['OK', 'PROVIDER_ERROR', 'NOT_PROCESSED']);

export const TerminologyAppliedSchema = z.object({ source: z.string(), target: z.string(), rule: z.string() });

export const SegmentResultSchema = z.object({
  segment_id: z.string(),
  block_type: BlockTypeSchema,
  order: z.number().int(),
  meta_kind: MetaKindSchema.optional(),
  level: z.number().int().optional(),
  group: SegmentGroupSchema.optional(),
  href: z.string().optional(),
  src: z.string().optional(),
  /** Inline tag attributes copied from the source segment (needed to render html). */
  inline: z.record(z.string(), InlineTagSchema).default({}),
  source_text: z.string(),
  source_lang: z.string(),
  source_lang_confidence: z.number().min(0).max(1),
  operation: OperationSchema,
  /** OK, PROVIDER_ERROR (retry exhausted, run continued) or NOT_PROCESSED (run halted by the cost ceiling). */
  status: SegmentStatusSchema,
  /** Stage outputs, kept for audit; null when the stage did not run for this segment. */
  translation: z.string().nullable(),
  localized_text: z.string().nullable(),
  /** The text to publish: null only for PROVIDER_ERROR / NOT_PROCESSED. */
  final_text: z.string().nullable(),
  changes: z.array(ChangeSchema),
  format_changes: z.array(FormatChangeSchema),
  entities_preserved: z.array(z.string()),
  terminology_applied: z.array(TerminologyAppliedSchema),
  requires_human_review: z.boolean(),
  review_reasons: z.array(z.string()),
  repairs: z.array(RepairRecordSchema),
  validation: SegmentValidationSchema.nullable(),
  /** Free-form audit notes, each evidence-tagged (e.g. `[EVIDENCE: detection p=0.98] Source already in target locale.`). */
  notes: z.array(TaggedTextSchema),
});
export type SegmentResult = z.infer<typeof SegmentResultSchema>;

// ---------------------------------------------------------------------------------------------------------------
// SEO meta (spec §4.3)
// ---------------------------------------------------------------------------------------------------------------

export const KEYWORD_STATUS = 'TRANSLATED_UNVERIFIED' as const;

export const SeoMetaSchema = z.object({
  locale: LocaleCodeSchema,
  hreflang: z.string(),
  title: z.string().nullable(),
  title_length: z.number().int(),
  title_max: z.number().int(),
  title_ok: z.boolean(),
  meta_description: z.string().nullable(),
  meta_description_length: z.number().int(),
  meta_description_max: z.number().int(),
  meta_description_ok: z.boolean(),
  /** Lower-case, hyphenated, transliterated (ä→ae, ö→oe, ü→ue, ß→ss). */
  slug: z.string().nullable(),
  h1: z.string().nullable(),
  primary_keyword: z
    .object({
      source: z.string(),
      source_origin: KeywordOriginSchema,
      translated: z.string().nullable(),
      keyword_status: z.literal(KEYWORD_STATUS),
      /** Always contains [HYPOTHESIS]. */
      note: TaggedTextSchema,
    })
    .nullable(),
});
export type SeoMeta = z.infer<typeof SeoMetaSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Recommendations (all tagged)
// ---------------------------------------------------------------------------------------------------------------

export const RecommendationSchema = z.object({
  id: z.string(),
  locale: LocaleCodeSchema,
  text: TaggedTextSchema,
  source: z.enum(['market_check', 'judge', 'pipeline']),
  segment_id: z.string().nullable(),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Locale result = the content of `<locale>/page.json`
// ---------------------------------------------------------------------------------------------------------------

export const StageBindingSchema = z.object({ provider: z.string(), model: z.string() });
export type StageBinding = z.infer<typeof StageBindingSchema>;

export const UsageTotalsSchema = z.object({
  calls: z.number().int().min(0),
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  /** Sum of known costs; calls with unknown pricing are counted in `unpriced_calls`. */
  cost_usd: z.number().min(0),
  unpriced_calls: z.number().int().min(0),
  latency_ms: z.number().min(0),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const LocaleResultSchema = z.object({
  target_locale: LocaleCodeSchema,
  hreflang: z.string(),
  verdict: VerdictSchema,
  verdict_reasons: z.array(z.string()),
  /** Aggregate: `max(0, 100 − Σ penalty × 100 / max(total words, words_floor))`. */
  quality_score: z.number().min(0).max(100),
  penalty: z.number().min(0),
  word_count: z.number().int().min(0),
  operations: z.partialRecord(OperationSchema, z.number().int()),
  counts: z.object({
    segments: z.number().int(),
    ok: z.number().int(),
    provider_error: z.number().int(),
    not_processed: z.number().int(),
    findings_minor: z.number().int(),
    findings_major: z.number().int(),
    findings_critical: z.number().int(),
    findings_open: z.number().int(),
    changes: z.number().int(),
    format_changes: z.number().int(),
    repairs: z.number().int(),
    human_review_segments: z.number().int(),
  }),
  providers: z.partialRecord(StageSchema, StageBindingSchema),
  usage: UsageTotalsSchema,
  segments: z.array(SegmentResultSchema),
  /** Findings not tied to a segment (e.g. first-mention, currency policy). */
  document_findings: z.array(FindingSchema),
  seo_meta: SeoMetaSchema,
  recommendations: z.array(RecommendationSchema),
});
export type LocaleResult = z.infer<typeof LocaleResultSchema>;

export const SourceSummarySchema = z.object({
  doc_id: z.string(),
  origin_kind: z.string(),
  origin_ref: z.string(),
  source_locale: z.string(),
  source_language: z.string(),
  page_type: PageTypeSchema,
  page_type_evidence: z.string(),
  segments: z.number().int(),
  words: z.number().int(),
  /** Count of segments per detected language (mixed-language pages, spec §5.2). */
  languages: z.record(z.string(), z.number().int()),
});
export type SourceSummary = z.infer<typeof SourceSummarySchema>;

/** `<locale>/page.json` */
export const PageJsonSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  run_id: z.string(),
  source: SourceSummarySchema,
  locale: LocaleResultSchema,
});
export type PageJson = z.infer<typeof PageJsonSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Run log & call records (telemetry)
// ---------------------------------------------------------------------------------------------------------------

export const RunLogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export const RunLogEntrySchema = z.object({
  ts: z.string(),
  level: RunLogLevelSchema,
  /** e.g. PARAM_UNSUPPORTED, PROVIDER_ERROR, PROVIDER_FALLBACK, JUDGE_NOT_INDEPENDENT, RETRY, SCHEMA_RETRY, COST_CEILING, HALT, STAGE_START, STAGE_END. */
  code: z.string(),
  message: z.string(),
  stage: StageSchema.optional(),
  provider: z.string().optional(),
  locale: LocaleCodeSchema.optional(),
  segment_id: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type RunLogEntry = z.infer<typeof RunLogEntrySchema>;

export const CallRecordSchema = z.object({
  call_id: z.string(),
  ts: z.string(),
  stage: StageSchema,
  locale: LocaleCodeSchema.nullable(),
  provider: z.string(),
  model: z.string(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cost_usd: z.number().nullable(),
  latency_ms: z.number(),
  attempts: z.number().int(),
  ok: z.boolean(),
  segments: z.number().int(),
  warnings: z.array(z.string()),
});
export type CallRecord = z.infer<typeof CallRecordSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Run report
// ---------------------------------------------------------------------------------------------------------------

export const RunOptionsEchoSchema = z.object({
  targets: z.array(LocaleCodeSchema),
  pass_threshold: z.number(),
  max_repair_loops: z.number().int(),
  cost_ceiling_usd: z.number(),
  stages: z.object({
    translate: z.boolean(),
    localize: z.boolean(),
    validate: z.boolean(),
    repair: z.boolean(),
    backtranslate: z.boolean(),
  }),
});

export const RunReportSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  run_id: z.string(),
  tool_version: z.string(),
  status: RunStatusSchema,
  started_at: z.string(),
  finished_at: z.string(),
  duration_ms: z.number(),
  source: SourceSummarySchema,
  options: RunOptionsEchoSchema,
  /** Stage -> provider/model actually used (after fallback/overrides). */
  routing: z.partialRecord(StageSchema, StageBindingSchema),
  locales: z.array(LocaleResultSchema),
  totals: UsageTotalsSchema,
  calls: z.array(CallRecordSchema),
  run_log: z.array(RunLogEntrySchema),
  /** Absolute output directory, or null when `write_outputs` was false. */
  output_dir: z.string().nullable(),
  /** Paths written, relative to `output_dir`. */
  artifacts: z.array(z.string()),
});
export type RunReport = z.infer<typeof RunReportSchema>;
