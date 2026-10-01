/**
 * Request / response schemas shared by the CLI, the REST API and the MCP server (R6: identical schemas).
 * All three interfaces are thin adapters over `Engine` (src/pipeline/types.ts); they validate input with these schemas and
 * return these shapes. MCP tool input/output JSON Schemas are generated from them with `z.toJSONSchema`.
 */
import { z } from 'zod';
import {
  LOCALES,
  LocaleCodeSchema,
  PageTypeSchema,
  SeveritySchema,
  SourceLocaleSchema,
  StageSchema,
  VerdictSchema,
} from './common.js';
import { FindingSchema } from './findings.js';
import { PageJsonSchema, RunReportSchema, SourceSummarySchema, StageBindingSchema, UsageTotalsSchema } from './report.js';

// ---------------------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------------------

export const UrlInputSchema = z.object({
  kind: z.literal('url'),
  url: z.string().url().describe('http(s) page to fetch. robots.txt is respected.'),
});
export const FileInputSchema = z.object({
  kind: z.literal('file'),
  path: z.string().describe('Local .html, .htm, .md, .markdown, .txt or .docx file (path on the machine running the engine).'),
});
export const TextInputSchema = z.object({
  kind: z.literal('text'),
  text: z.string().min(1).describe('Raw content.'),
  format: z.enum(['html', 'markdown', 'text']).default('text'),
  name: z.string().optional().describe('Label used in reports, e.g. the intended URL path (used for legal-page detection).'),
});
export const PageJsonInputSchema = z.object({
  kind: z.literal('page_json'),
  path: z.string().optional().describe('Path to a <locale>/page.json written by a previous run.'),
  page: PageJsonSchema.optional().describe('Inline page.json content.'),
});

export const InputSpecSchema = z.discriminatedUnion('kind', [UrlInputSchema, FileInputSchema, TextInputSchema, PageJsonInputSchema]);
export type InputSpec = z.infer<typeof InputSpecSchema>;

/** `validate_content` inputs: a previous page.json, or one source/target text pair. */
export const PairInputSchema = z.object({
  kind: z.literal('pair'),
  source_text: z.string().min(1),
  source_locale: SourceLocaleSchema.default('nl-NL'),
  target_text: z.string().min(1),
  target_locale: LocaleCodeSchema,
  block_type: z.enum(['heading', 'paragraph', 'list_item', 'table_cell', 'alt', 'anchor']).default('paragraph'),
});
export const ValidateInputSchema = z.discriminatedUnion('kind', [PageJsonInputSchema, PairInputSchema]);
export type ValidateInput = z.infer<typeof ValidateInputSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------------------------

export const PipelineOptionsSchema = z.object({
  source_locale: SourceLocaleSchema.optional().describe('Override detection, e.g. nl-NL, en-GB, en-*.'),
  primary_keyword: z.string().optional().describe('Source-language primary keyword; derived from meta keywords / H1 / title when omitted.'),
  page_type: PageTypeSchema.optional().describe('Override CONTENT/LEGAL classification.'),
  providers: z
    .partialRecord(StageSchema, z.string())
    .optional()
    .describe('Per-run provider routing: stage -> "provider" or "provider:model-key".'),
  pass_threshold: z.number().min(0).max(100).optional(),
  max_repair_loops: z.number().int().min(0).max(5).optional(),
  cost_ceiling_usd: z.number().positive().optional(),
  output_dir: z.string().optional(),
  run_id: z.string().optional(),
  write_outputs: z.boolean().optional().describe('Write the deliverables (default true).'),
  backtranslate: z.boolean().optional().describe('Run back-translation drift checks (default true).'),
  repair: z.boolean().optional().describe('Run repair loops (default true; false for validate_content).'),
});
export type PipelineOptions = z.infer<typeof PipelineOptionsSchema>;

export const TargetsSchema = z
  .union([z.literal('all'), z.array(LocaleCodeSchema).min(1)], { error: `expected "all" or a non-empty list of locales (${LOCALES.join(', ')})` })
  .default('all')
  .describe('"all" = the default target set for the detected source language, or an explicit list of locales.');

// ---------------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------------

/** `run_pipeline` / `POST /v1/pipeline` / `locale run`: ingest -> detect -> translate -> localize -> validate -> repair -> export. */
export const PipelineRequestSchema = z.object({
  input: InputSpecSchema,
  targets: TargetsSchema,
  options: PipelineOptionsSchema.default({}),
});
export type PipelineRequest = z.infer<typeof PipelineRequestSchema>;

/** `translate_content` / `POST /v1/translate` / `locale translate`: ingest -> detect -> translate only (legal-page rules still apply). */
export const TranslateRequestSchema = PipelineRequestSchema;
export type TranslateRequest = PipelineRequest;

/**
 * `localize_content` / `POST /v1/localize` / `locale localize`: localize translated content. `input` may be raw content
 * (translation runs implicitly for cross-language targets, then localization) or a page.json from `translate`.
 */
export const LocalizeRequestSchema = PipelineRequestSchema;
export type LocalizeRequest = PipelineRequest;

/** `validate_content` / `POST /v1/validate` / `locale validate`: deterministic lint + back-translation + judge (+ optional repair). */
export const ValidateRequestSchema = z.object({
  input: ValidateInputSchema,
  options: PipelineOptionsSchema.default({}),
});
export type ValidateRequest = z.infer<typeof ValidateRequestSchema>;

/** `compare_models` / `locale compare`: same input through several providers, scored by one fixed judge. */
export const CompareRequestSchema = z.object({
  input: InputSpecSchema,
  targets: TargetsSchema,
  providers: z.array(z.string()).min(2).describe('Provider refs ("anthropic", "openai:gpt-mini", …) that take the translate/localize/repair stages in turn.'),
  judge_provider: z.string().optional().describe('Fixed judge for every candidate (default: routing.stages.validation).'),
  options: PipelineOptionsSchema.default({}),
});
export type CompareRequest = z.infer<typeof CompareRequestSchema>;

export const GetRunReportRequestSchema = z.object({ run_id: z.string().min(1), output_dir: z.string().optional() });
export type GetRunReportRequest = z.infer<typeof GetRunReportRequestSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------------------

/** Pipeline-family tools all return a RunReport. */
export const PipelineResponseSchema = RunReportSchema;
export type PipelineResponse = z.infer<typeof PipelineResponseSchema>;

export const LocaleSummarySchema = z.object({
  locale: LocaleCodeSchema,
  language: z.string(),
  region: z.string(),
  display_name: z.string(),
  hreflang: z.string(),
  description: z.string(),
  rule_count: z.number().int(),
  rules: z.array(z.object({ id: z.string(), severity: SeveritySchema, type: z.string(), message: z.string() })),
  market_checks: z.array(z.object({ id: z.string(), text: z.string(), applies: z.string() })),
});
export type LocaleSummary = z.infer<typeof LocaleSummarySchema>;
export const ListLocalesResponseSchema = z.object({ locales: z.array(LocaleSummarySchema) });
export type ListLocalesResponse = z.infer<typeof ListLocalesResponseSchema>;

export const ProviderTestResultSchema = z.object({
  provider: z.string(),
  model: z.string(),
  configured: z.boolean(),
  ok: z.boolean(),
  structured_output: z.string(),
  latency_ms: z.number().nullable(),
  cost_usd: z.number().nullable(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
});
export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>;

// -- compare ------------------------------------------------------------------------------------------------------

export const CompareScoreRowSchema = z.object({
  provider: z.string(),
  locale: LocaleCodeSchema,
  quality_score: z.number(),
  verdict: VerdictSchema,
  penalty: z.number(),
  findings_minor: z.number().int(),
  findings_major: z.number().int(),
  findings_critical: z.number().int(),
  judge_avg: z
    .object({ accuracy: z.number(), fluency: z.number(), terminology: z.number(), locale_conventions: z.number(), style_brand: z.number() })
    .nullable(),
});
export const CompareCostRowSchema = z.object({
  provider: z.string(),
  stage: StageSchema.or(z.literal('all')),
  calls: z.number().int(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cost_usd: z.number(),
  latency_ms: z.number(),
});
export const CompareSegmentDiffRowSchema = z.object({
  locale: LocaleCodeSchema,
  segment_id: z.string(),
  source_text: z.string(),
  /** provider -> final text (null on PROVIDER_ERROR). */
  outputs: z.record(z.string(), z.string().nullable()),
  identical: z.boolean(),
});
export const CompareReportSchema = z.object({
  schema_version: z.literal(1),
  compare_id: z.string(),
  created_at: z.string(),
  source: SourceSummarySchema,
  targets: z.array(LocaleCodeSchema),
  providers: z.array(z.string()),
  judge: StageBindingSchema,
  scores: z.array(CompareScoreRowSchema),
  findings: z.array(z.object({ provider: z.string() }).and(FindingSchema)),
  cost_latency: z.array(CompareCostRowSchema),
  segment_diff: z.array(CompareSegmentDiffRowSchema),
  /** provider -> run_id of the underlying pipeline run. */
  runs: z.record(z.string(), z.string()),
  totals: UsageTotalsSchema,
  output_dir: z.string().nullable(),
  artifacts: z.array(z.string()),
  notes: z.array(z.string()),
});
export type CompareReport = z.infer<typeof CompareReportSchema>;
