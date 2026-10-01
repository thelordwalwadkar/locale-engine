/**
 * The capabilities every interface exposes (R6: interface parity). One entry per MCP tool: its request schema, its result
 * schema, the ONE Engine method it calls, and a human summary. The REST routes, the MCP tools and the CLI commands all use
 * these same schema objects, so their JSON Schemas cannot drift apart.
 */
import { z } from 'zod';
import type { Engine } from '../pipeline/types.js';
import {
  CompareReportSchema,
  CompareRequestSchema,
  GetRunReportRequestSchema,
  ListLocalesResponseSchema,
  PipelineRequestSchema,
  RunReportSchema,
  ValidateRequestSchema,
} from '../schemas/index.js';
import { formatCompareSummary, formatLocalesTable, formatRunSummary } from './format.js';

export type JsonObject = Record<string, unknown>;
export type JsonSchema = Record<string, unknown>;

type InputOf<I> = I extends z.ZodType ? z.output<I> : undefined;

/**
 * `run` and `summarize` use method syntax on purpose: it makes the parameter check bivariant, so a precisely typed capability
 * is assignable to the erased `AnyCapability` that REST and MCP iterate over. Those adapters validate with `input` first.
 */
export interface Capability<I extends z.ZodType | undefined = z.ZodType | undefined, O extends z.ZodType<JsonObject> = z.ZodType<JsonObject>> {
  /** MCP tool name; also the OpenAPI operationId. */
  readonly name: string;
  readonly title: string;
  /** Written for an LLM client: what to pass, what comes back. Also the OpenAPI description. */
  readonly description: string;
  /** Request schema; `undefined` for a capability without arguments. */
  readonly input: I;
  readonly output: O;
  readonly readOnly: boolean;
  run(engine: Engine, input: InputOf<I>): Promise<z.output<O>>;
  summarize(result: z.output<O>): string;
}

export type AnyCapability = Capability;

function defineCapability<I extends z.ZodType | undefined, O extends z.ZodType<JsonObject>>(def: Capability<I, O>): Capability<I, O> {
  return def;
}

const INPUT_HELP =
  "input is {kind:'url', url} | {kind:'file', path} | {kind:'text', text, format?: 'html'|'markdown'|'text'}. " +
  "targets is 'all' (the default locale set for the detected source language) or a list such as ['de-CH','it-IT'] (see list_locales). " +
  'options are all optional: source_locale, primary_keyword, page_type (CONTENT|LEGAL), providers (stage -> "provider[:model]"), ' +
  'pass_threshold (0-100), max_repair_loops (0-5), cost_ceiling_usd, output_dir, run_id, write_outputs, backtranslate, repair.';

export const CAPABILITIES = {
  run_pipeline: defineCapability({
    name: 'run_pipeline',
    title: 'Run the full localization pipeline',
    description:
      'Runs the whole workflow on one page: ingest (URL, local file or inline text), detect the source language, translate and localize for each target locale, ' +
      'validate (deterministic linters plus an LLM judge), repair findings, and write the deliverables (per-locale page.json/md/html, localization_report.xlsx, ' +
      'executive_summary.md, run.json). ' +
      INPUT_HELP +
      ' Returns a RunReport: per locale a verdict (PASS, PASS_WITH_NOTES, FAIL, HUMAN_REVIEW), quality score, findings, segments, SEO meta, cost, and the output folder. ' +
      'Can take minutes and spends LLM tokens.',
    input: PipelineRequestSchema,
    output: RunReportSchema,
    readOnly: false,
    run: (engine, request) => engine.runPipeline(request),
    summarize: formatRunSummary,
  }),
  translate_content: defineCapability({
    name: 'translate_content',
    title: 'Translate content',
    description:
      'Translation only: ingest, detect the language and translate into each target locale, without localization or validation. Legal pages are translated, never localized, and flagged for human review. ' +
      "Each locale's page.json can be passed to localize_content as {kind:'page_json', path} and to validate_content. " +
      INPUT_HELP,
    input: PipelineRequestSchema,
    output: RunReportSchema,
    readOnly: false,
    run: (engine, request) => engine.translateContent(request),
    summarize: formatRunSummary,
  }),
  localize_content: defineCapability({
    name: 'localize_content',
    title: 'Localize content',
    description:
      "Localizes content to the conventions of each target locale (vocabulary, number/date/currency formats, market claims). input may be raw content (translation runs first when the languages differ) or {kind:'page_json', path} " +
      'for a page.json written by translate_content. The result is not validated: call validate_content afterwards. ' +
      INPUT_HELP,
    input: PipelineRequestSchema,
    output: RunReportSchema,
    readOnly: false,
    run: (engine, request) => engine.localizeContent(request),
    summarize: formatRunSummary,
  }),
  validate_content: defineCapability({
    name: 'validate_content',
    title: 'Validate a translation',
    description:
      "Validates an existing translation without re-translating: deterministic locale-rule lint, back-translation drift check and an LLM judge, optionally followed by repair. " +
      "input is {kind:'page_json', path} (a <locale>/page.json from an earlier run) or {kind:'pair', source_text, target_text, target_locale, source_locale?: default 'nl-NL', block_type?: default 'paragraph'} for one text pair. " +
      'options as for run_pipeline, except that repair is off unless options.repair is true. Returns a RunReport.',
    input: ValidateRequestSchema,
    output: RunReportSchema,
    readOnly: false,
    run: (engine, request) => engine.validateContent(request),
    summarize: formatRunSummary,
  }),
  compare_models: defineCapability({
    name: 'compare_models',
    title: 'Compare providers',
    description:
      'Runs the same input through two or more providers (translate, localize and repair stages) and scores every result with one fixed judge, to compare quality, findings, cost and latency per provider and locale. ' +
      "providers is a list of provider refs such as ['anthropic', 'openai:gpt-mini'] (at least two); judge_provider optionally fixes the judge. " +
      'Writes model_comparison.xlsx. Costs one full pipeline run per provider. ' +
      INPUT_HELP,
    input: CompareRequestSchema,
    output: CompareReportSchema,
    readOnly: false,
    run: (engine, request) => engine.compareModels(request),
    summarize: formatCompareSummary,
  }),
  list_locales: defineCapability({
    name: 'list_locales',
    title: 'List supported locales',
    description:
      'Lists the supported locales with language, region, hreflang, description, number of lint rules and market checks. Takes no arguments. Use it to find valid values for targets.',
    input: undefined,
    output: ListLocalesResponseSchema,
    readOnly: true,
    run: async (engine) => engine.listLocales(),
    summarize: formatLocalesTable,
  }),
  get_run_report: defineCapability({
    name: 'get_run_report',
    title: 'Get a run report',
    description:
      'Re-reads the RunReport (run.json) of an earlier run so results can be used without re-running. run_id is the id the run reported; output_dir optionally says where that run wrote its output (default: the engine output folder). Fails with RUN_NOT_FOUND when there is no such run.',
    input: GetRunReportRequestSchema,
    output: RunReportSchema,
    readOnly: true,
    run: (engine, request) => engine.getRunReport(request),
    summarize: formatRunSummary,
  }),
};

export const ALL_CAPABILITIES: readonly AnyCapability[] = Object.values(CAPABILITIES);

// ---------------------------------------------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------------------------------------------

/** What the MCP SDK advertises for a tool registered without an input schema. */
const NO_ARGUMENTS: JsonSchema = { type: 'object', properties: {} };

/**
 * draft-07, because that is the dialect the MCP SDK emits in `tools/list`. REST (`/openapi.json`) and the parity test call
 * this same function, which is what makes the three JSON Schemas identical rather than merely similar.
 */
export function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  return z.toJSONSchema(schema, { target: 'draft-7', io });
}

export const inputJsonSchema = (cap: AnyCapability): JsonSchema => (cap.input ? toJsonSchema(cap.input, 'input') : NO_ARGUMENTS);
export const outputJsonSchema = (cap: AnyCapability): JsonSchema => toJsonSchema(cap.output, 'output');
