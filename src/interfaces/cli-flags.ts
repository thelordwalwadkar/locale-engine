/**
 * CLI flags -> request objects. The shared schemas stay the judge of what is valid (R6); this module only declares the flags,
 * turns their values into the request shape, and maps schema errors back to the flag the user typed.
 */
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';
import { LOCALES, STAGES } from '../schemas/index.js';
import type { LocaleCode, PipelineOptions } from '../schemas/index.js';
import { usageError } from './errors.js';
import type { ExitError, RequestIssue } from './errors.js';

/**
 * The CLI flag behind every field of `PipelineOptions`. `Record<keyof PipelineOptions, …>` makes this fail to compile when the
 * schema gains an option without a flag; a test checks the flags really exist on the commands.
 */
export const PIPELINE_OPTION_FLAGS = {
  source_locale: '--source-locale',
  primary_keyword: '--keyword',
  page_type: '--page-type',
  providers: '--provider',
  pass_threshold: '--pass-threshold',
  max_repair_loops: '--max-repair-loops',
  cost_ceiling_usd: '--cost-ceiling',
  output_dir: '--out',
  run_id: '--run-id',
  write_outputs: '--no-write',
  backtranslate: '--no-backtranslate',
  repair: '--no-repair',
} as const satisfies Record<keyof PipelineOptions, string>;

// ---------------------------------------------------------------------------------------------------------------
// Value parsers (throw InvalidArgumentError: commander prints it and the CLI exits with 2)
// ---------------------------------------------------------------------------------------------------------------

const KNOWN_LOCALES = `known: ${LOCALES.join(', ')}`;

function canonicalLocale(value: string): LocaleCode | undefined {
  const wanted = value.trim().toLowerCase().replace('_', '-');
  return LOCALES.find((locale) => locale.toLowerCase() === wanted);
}

export function parseLocale(value: string): LocaleCode {
  const locale = canonicalLocale(value);
  if (!locale) throw new InvalidArgumentError(`unknown locale '${value}' (${KNOWN_LOCALES})`);
  return locale;
}

export function parseTargets(value: string): 'all' | LocaleCode[] {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) throw new InvalidArgumentError(`expected 'all' or a comma-separated list of locales (${KNOWN_LOCALES})`);
  const hasAll = parts.some((part) => part.toLowerCase() === 'all');
  if (hasAll && parts.length > 1) throw new InvalidArgumentError("'all' cannot be combined with other locales");
  if (hasAll) return 'all';
  const targets: LocaleCode[] = [];
  for (const part of parts) {
    const locale = canonicalLocale(part);
    if (!locale) throw new InvalidArgumentError(`unknown locale '${part}' (${KNOWN_LOCALES}; or 'all')`);
    if (!targets.includes(locale)) targets.push(locale);
  }
  return targets;
}

/** `--provider translation=openai:gpt`, repeatable; the last value for a stage wins. */
export function parseProviderRoute(value: string, previous: Record<string, string> | undefined): Record<string, string> {
  const at = value.indexOf('=');
  const stage = at === -1 ? '' : value.slice(0, at).trim();
  const ref = at === -1 ? '' : value.slice(at + 1).trim();
  if (!(STAGES as readonly string[]).includes(stage) || ref === '') {
    throw new InvalidArgumentError(`expected <stage>=<provider[:model]> with stage one of ${STAGES.join(', ')}, e.g. translation=openai:gpt`);
  }
  return { ...previous, [stage]: ref };
}

export function parseProviderList(value: string): string[] {
  const refs = value
    .split(',')
    .map((ref) => ref.trim())
    .filter((ref) => ref !== '');
  if (refs.length < 2) throw new InvalidArgumentError('expected at least two provider refs separated by commas, e.g. anthropic,openai:gpt-mini');
  return refs;
}

export function parseNumber(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) throw new InvalidArgumentError(`expected a number, got '${value}'`);
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Flag declarations
// ---------------------------------------------------------------------------------------------------------------

export interface InputFlags {
  input?: string;
  text?: string;
  format?: string;
}

export interface OptionFlags {
  sourceLocale?: string;
  keyword?: string;
  pageType?: string;
  provider?: Record<string, string>;
  passThreshold?: number;
  maxRepairLoops?: number;
  costCeiling?: number;
  out?: string;
  runId?: string;
  write?: boolean;
  backtranslate?: boolean;
  repair?: boolean;
}

export interface OutputFlags {
  json?: boolean;
  quiet?: boolean;
  strict?: boolean;
  strictReview?: boolean;
}

export function addInputFlags(cmd: Command, inputHelp: string): Command {
  return cmd
    .option('--input <url|file>', inputHelp)
    .option('--text <content>', 'inline content instead of --input')
    .option('--format <format>', 'format of --text: html, markdown or text (default text)');
}

export function addTargetsFlag(cmd: Command): Command {
  return cmd.option('--targets <all|locales>', "'all' (default) or a comma-separated list of locales, e.g. de-CH,it-IT", parseTargets);
}

export function addContentFlags(cmd: Command): Command {
  return cmd
    .option('--source-locale <locale>', 'override source-language detection, e.g. nl-NL, en-GB or en-*')
    .option('--keyword <text>', 'primary keyword in the source language (derived from the page when omitted)')
    .option('--page-type <type>', 'override the CONTENT/LEGAL classification', (value: string) => value.toUpperCase());
}

/** `--provider` is commander's option value; its placeholder avoids brackets, which commander reads as "optional argument". */
export function addEngineFlags(cmd: Command): Command {
  return cmd
    .option(
      '--provider <stage=provider:model>',
      `route one stage to a provider, e.g. translation=openai:gpt; repeatable; stages: ${STAGES.join(', ')}`,
      parseProviderRoute,
    )
    .option('--pass-threshold <score>', 'minimum quality score (0-100) for PASS', parseNumber)
    .option('--max-repair-loops <n>', 'repair iterations before HUMAN_REVIEW (0-5)', parseNumber)
    .option('--cost-ceiling <usd>', 'halt the run gracefully when this spend is exceeded', parseNumber)
    .option('--out <dir>', 'folder that receives the deliverables (default: output/<run_id>/)')
    .option('--run-id <id>', 'run id (default: generated)')
    .option('--no-backtranslate', 'skip the back-translation drift check')
    .option('--no-write', 'do not write deliverables to disk');
}

export function addOutputFlags(cmd: Command): Command {
  return cmd
    .option('--json', 'print the full JSON result to stdout and nothing else')
    .option('--quiet', 'no summary on stdout (errors still go to stderr)');
}

export function addStrictFlags(cmd: Command): Command {
  return cmd
    .option('--strict', 'exit with 4 when any locale verdict is FAIL')
    .option('--strict-review', 'with --strict, HUMAN_REVIEW also exits with 4 (implies --strict)');
}

// ---------------------------------------------------------------------------------------------------------------
// Flags -> request
// ---------------------------------------------------------------------------------------------------------------

/** Unvalidated `options`: keys are checked against the schema, values are checked by it afterwards. */
export type RawOptions = Partial<Record<keyof PipelineOptions, unknown>>;

/**
 * Only flags that were given end up in the options, so the engine's defaults stay in one place.
 * `repair`: `negated` = the command has `--no-repair` (default on); `enabled` = it has `--repair` (default off, validate).
 */
export function collectOptions(flags: OptionFlags, repair: 'negated' | 'enabled'): RawOptions {
  const options: RawOptions = {};
  if (flags.sourceLocale !== undefined) options.source_locale = flags.sourceLocale;
  if (flags.keyword !== undefined) options.primary_keyword = flags.keyword;
  if (flags.pageType !== undefined) options.page_type = flags.pageType;
  if (flags.provider !== undefined) options.providers = flags.provider;
  if (flags.passThreshold !== undefined) options.pass_threshold = flags.passThreshold;
  if (flags.maxRepairLoops !== undefined) options.max_repair_loops = flags.maxRepairLoops;
  if (flags.costCeiling !== undefined) options.cost_ceiling_usd = flags.costCeiling;
  if (flags.out !== undefined) options.output_dir = flags.out;
  if (flags.runId !== undefined) options.run_id = flags.runId;
  if (flags.write === false) options.write_outputs = false;
  if (flags.backtranslate === false) options.backtranslate = false;
  if (repair === 'negated' && flags.repair === false) options.repair = false;
  if (repair === 'enabled' && flags.repair === true) options.repair = true;
  return options;
}

const isUrl = (value: string): boolean => /^https?:\/\//i.test(value);
const isPageJson = (value: string): boolean => /\.json$/i.test(value);

/** `--input` is a URL when it starts with http(s)://, a page.json when `pageJson` is allowed and it ends in .json, else a file. */
export function inputFromFlags(flags: InputFlags, opts: { pageJson: boolean }): Record<string, unknown> {
  if (flags.input !== undefined && flags.text !== undefined) throw usageError('use either --input or --text, not both');
  if (flags.text !== undefined) return { kind: 'text', text: flags.text, ...(flags.format !== undefined ? { format: flags.format } : {}) };
  if (flags.format !== undefined) throw usageError('--format only applies to --text');
  if (flags.input === undefined) throw usageError('no content given: pass --input <url|file> or --text <content>');
  if (isUrl(flags.input)) return { kind: 'url', url: flags.input };
  if (opts.pageJson && isPageJson(flags.input)) return { kind: 'page_json', path: flags.input };
  return { kind: 'file', path: flags.input };
}

export interface ValidateFlags {
  input?: string;
  source?: string;
  sourceLocale?: string;
  target?: string;
  targetLocale?: string;
  blockType?: string;
}

/** `validate` takes a page.json (`--input`) or one source/target pair (`--source --target --target-locale`). */
export function validateInputFromFlags(flags: ValidateFlags): Record<string, unknown> {
  const pairFlags = [flags.source, flags.sourceLocale, flags.target, flags.targetLocale, flags.blockType];
  if (flags.input !== undefined) {
    if (pairFlags.some((value) => value !== undefined)) {
      throw usageError('use either --input <page.json> or the pair flags (--source, --target, --target-locale), not both');
    }
    if (!isPageJson(flags.input)) {
      throw usageError(`--input expects a <locale>/page.json written by a previous run, got '${flags.input}'; to validate raw text use --source, --target and --target-locale`);
    }
    return { kind: 'page_json', path: flags.input };
  }
  if (flags.source === undefined || flags.target === undefined || flags.targetLocale === undefined) {
    throw usageError('nothing to validate: pass --input <page.json>, or --source <text> --target <text> --target-locale <locale> (optionally --source-locale)');
  }
  return {
    kind: 'pair',
    source_text: flags.source,
    target_text: flags.target,
    target_locale: flags.targetLocale,
    ...(flags.sourceLocale !== undefined ? { source_locale: flags.sourceLocale } : {}),
    ...(flags.blockType !== undefined ? { block_type: flags.blockType } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Schema errors -> flag names
// ---------------------------------------------------------------------------------------------------------------

const FLAG_FOR_PATH: ReadonlyArray<readonly [string, string]> = [
  ['input.url', '--input'],
  ['input.path', '--input'],
  ['input.kind', '--input'],
  ['input.text', '--text'],
  ['input.format', '--format'],
  ['input.source_text', '--source'],
  ['input.source_locale', '--source-locale'],
  ['input.target_text', '--target'],
  ['input.target_locale', '--target-locale'],
  ['input.block_type', '--block-type'],
  ['targets', '--targets'],
  ['providers', '--providers'],
  ['judge_provider', '--judge'],
  ...Object.entries(PIPELINE_OPTION_FLAGS).map(([key, flag]): [string, string] => [`options.${key}`, flag]),
];

function flagFor(path: string): string | undefined {
  return FLAG_FOR_PATH.find(([key]) => path === key || path.startsWith(`${key}.`))?.[1];
}

/** The shared schema rejected the request the flags produced: say so in terms of flags. */
export function schemaUsageError(issues: readonly RequestIssue[]): ExitError {
  const lines = issues.map((issue) => `  ${flagFor(issue.path) ?? issue.path}: ${issue.message}`);
  return usageError(`invalid options\n${lines.join('\n')}`);
}
