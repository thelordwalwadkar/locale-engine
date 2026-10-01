#!/usr/bin/env node
/**
 * `locale` — the command-line interface (spec §6.4). A thin adapter over `Engine`: flags become a request that the shared
 * schema validates, exactly one Engine method runs, its result is printed unchanged (`--json`) or summarised.
 * Exit codes: 0 ok, 1 runtime/engine error, 2 usage error, 3 cost ceiling, 4 `--strict` FAIL.
 */
import { Command, CommanderError } from 'commander';
import type { z } from 'zod';
import { loadDotEnv } from '../config/env.js';
import type { Engine } from '../pipeline/types.js';
import type { LocaleCode, RunReport } from '../schemas/index.js';
import { EngineError } from '../util/errors.js';
import type { EngineErrorCode } from '../util/errors.js';
import { toolVersion } from '../util/paths.js';
import { CAPABILITIES } from './capabilities.js';
import {
  addContentFlags,
  addEngineFlags,
  addInputFlags,
  addOutputFlags,
  addStrictFlags,
  addTargetsFlag,
  collectOptions,
  inputFromFlags,
  parseLocale,
  parseProviderList,
  schemaUsageError,
  validateInputFromFlags,
} from './cli-flags.js';
import type { InputFlags, OptionFlags, OutputFlags, ValidateFlags } from './cli-flags.js';
import { EXIT, ExitError, errorDetail, redactSecrets, requestIssues } from './errors.js';
import { formatCompareSummary, formatLocalesTable, formatProvidersTable, isUnvalidated, usd } from './format.js';
import { exitWhenFlushed, getDefaultEngine, isEntryPoint } from './runtime.js';

export interface CliDeps {
  getEngine: () => Promise<Engine>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

type PipelineFlags = InputFlags & OptionFlags & OutputFlags & { targets?: 'all' | LocaleCode[] };

const EXAMPLES = `
Examples:
  locale run --input https://example.nl/pompen --targets all
  locale run --input ./page.html --targets de-CH,it-IT --provider translation=openai:gpt --no-repair
  locale translate --input ./page.md --targets de-DE --out ./output
  locale localize --input ./output/<run_id>/de-CH/page.json
  locale validate --source "Vraag een offerte aan" --target "Fordern Sie ein Angebot an" --target-locale de-CH
  locale compare --input ./page.html --targets de-CH --providers anthropic,openai
  locale providers test`;

function parseRequest<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw schemaUsageError(requestIssues(parsed.error));
  return parsed.data;
}

/** `--json` prints the result and nothing else; `--quiet` prints nothing; otherwise the human rendering. */
function emit(deps: CliDeps, flags: OutputFlags, result: unknown, human: () => string): void {
  if (flags.json) deps.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else if (!flags.quiet) deps.stdout(`${human()}\n`);
}

/** The result was printed; turn a failed run, a halted run or a `--strict` violation into the matching exit code. */
function checkOutcome(report: RunReport, flags: OutputFlags): void {
  if (report.status === 'FAILED') {
    throw new ExitError(`run ${report.run_id} FAILED: no usable result; see run_log in run.json (or rerun with --json)`, EXIT.FAILURE);
  }
  if (report.status === 'HALTED_COST_CEILING') {
    throw new ExitError(
      `run ${report.run_id} halted: cost ceiling of ${usd(report.options.cost_ceiling_usd)} reached after ${usd(report.totals.cost_usd)}; raise --cost-ceiling (or LOCALE_COST_CEILING_USD) and re-run`,
      EXIT.COST_CEILING,
    );
  }
  if (!flags.strict && !flags.strictReview) return;
  const failing = report.locales.filter(
    (l) => l.verdict === 'FAIL' || (flags.strictReview === true && l.verdict === 'HUMAN_REVIEW' && !isUnvalidated(report, l)),
  );
  if (failing.length > 0) {
    throw new ExitError(`--strict: ${failing.length} locale(s) did not pass: ${failing.map((l) => `${l.target_locale} ${l.verdict}`).join(', ')}`, EXIT.STRICT);
  }
}

interface PipelineCommand {
  name: 'run' | 'translate' | 'localize';
  tool: 'run_pipeline' | 'translate_content' | 'localize_content';
  description: string;
  inputHelp: string;
  /** localize also takes the page.json written by translate. */
  pageJson: boolean;
}

const PIPELINE_COMMANDS: readonly PipelineCommand[] = [
  {
    name: 'run',
    tool: 'run_pipeline',
    description: 'Run the full pipeline: ingest, detect, translate, localize, validate, repair, export',
    inputHelp: 'page URL (http/https) or a local .html, .md, .txt or .docx file',
    pageJson: false,
  },
  {
    name: 'translate',
    tool: 'translate_content',
    description: 'Translate only (legal pages are never localized); writes a page.json per locale',
    inputHelp: 'page URL (http/https) or a local .html, .md, .txt or .docx file',
    pageJson: false,
  },
  {
    name: 'localize',
    tool: 'localize_content',
    description: 'Localize content for each target locale (translates first when the languages differ)',
    inputHelp: 'page URL, local file, or a <locale>/page.json written by `locale translate`',
    pageJson: true,
  },
];

function addPipelineCommand(program: Command, deps: CliDeps, spec: PipelineCommand): void {
  const cmd = program.command(spec.name).description(spec.description);
  addInputFlags(cmd, spec.inputHelp);
  addTargetsFlag(cmd);
  addContentFlags(cmd);
  addEngineFlags(cmd);
  cmd.option('--no-repair', 'skip the repair loop');
  addOutputFlags(cmd);
  addStrictFlags(cmd);
  cmd.action(async (flags: PipelineFlags) => {
    const cap = CAPABILITIES[spec.tool];
    const request = parseRequest(cap.input, {
      input: inputFromFlags(flags, { pageJson: spec.pageJson }),
      ...(flags.targets !== undefined ? { targets: flags.targets } : {}),
      options: collectOptions(flags, 'negated'),
    });
    const report = await cap.run(await deps.getEngine(), request);
    emit(deps, flags, report, () => cap.summarize(report));
    checkOutcome(report, flags);
  });
}

function addValidateCommand(program: Command, deps: CliDeps): void {
  const cmd = program
    .command('validate')
    .description('Lint, back-translate and judge an existing translation (a page.json, or one source/target text pair)')
    .option('--input <page.json>', 'a <locale>/page.json written by a previous run')
    .option('--source <text>', 'source text of a pair')
    .option('--source-locale <locale>', 'locale of --source (default nl-NL)')
    .option('--target <text>', 'translated text of a pair')
    .option('--target-locale <locale>', 'locale of --target, e.g. de-CH', parseLocale)
    .option('--block-type <type>', 'block type of the pair: paragraph (default), heading, list_item, table_cell, alt or anchor')
    .option('--repair', 'also run the repair loop on findings (off by default here)');
  addEngineFlags(cmd);
  addOutputFlags(cmd);
  addStrictFlags(cmd);
  cmd.action(async (flags: ValidateFlags & OptionFlags & OutputFlags) => {
    const cap = CAPABILITIES.validate_content;
    // Here --source-locale is the locale of the pair, not the pipeline's source-language override.
    const options = collectOptions({ ...flags, sourceLocale: undefined }, 'enabled');
    const request = parseRequest(cap.input, { input: validateInputFromFlags(flags), options });
    const report = await cap.run(await deps.getEngine(), request);
    emit(deps, flags, report, () => cap.summarize(report));
    checkOutcome(report, flags);
  });
}

function addCompareCommand(program: Command, deps: CliDeps): void {
  const cmd = program.command('compare').description('Run the same input through several providers and compare quality, cost and latency');
  addInputFlags(cmd, 'page URL (http/https) or a local .html, .md, .txt or .docx file');
  addTargetsFlag(cmd);
  addContentFlags(cmd);
  cmd
    .requiredOption('--providers <a,b,c>', 'two or more provider refs, e.g. anthropic,openai:gpt-mini', parseProviderList)
    .option('--judge <provider>', 'fixed judge for every candidate (default: the validation stage provider)');
  addEngineFlags(cmd);
  cmd.option('--no-repair', 'skip the repair loop');
  addOutputFlags(cmd);
  cmd.action(async (flags: PipelineFlags & { providers: string[]; judge?: string }) => {
    const cap = CAPABILITIES.compare_models;
    const request = parseRequest(cap.input, {
      input: inputFromFlags(flags, { pageJson: false }),
      ...(flags.targets !== undefined ? { targets: flags.targets } : {}),
      providers: flags.providers,
      ...(flags.judge !== undefined ? { judge_provider: flags.judge } : {}),
      options: collectOptions(flags, 'negated'),
    });
    const report = await cap.run(await deps.getEngine(), request);
    emit(deps, flags, report, () => formatCompareSummary(report));
  });
}

function addLocalesCommand(program: Command, deps: CliDeps): void {
  program
    .command('locales')
    .description('List the supported locales')
    .option('--json', 'print the full JSON result to stdout and nothing else')
    .action(async (flags: OutputFlags) => {
      const cap = CAPABILITIES.list_locales;
      const response = await cap.run(await deps.getEngine(), undefined);
      emit(deps, flags, response, () => formatLocalesTable(response));
    });
}

function addProvidersCommand(program: Command, deps: CliDeps): void {
  const providers = program.command('providers').description('Inspect the LLM providers');
  providers
    .command('test [names...]')
    .description('Send a trivial schema-bound request to each provider (all configured ones when no name is given)')
    .option('--json', 'print the full JSON result to stdout and nothing else')
    .action(async (names: string[], flags: OutputFlags) => {
      const results = await (await deps.getEngine()).testProviders(names);
      emit(deps, flags, results, () => {
        const table = formatProvidersTable(results);
        return results.some((r) => r.configured)
          ? table
          : `${table}\n\nNo provider has credentials yet: copy .env.example to .env and set the API key named by api_key_env in config/providers.yaml.`;
      });
      const failed = results.filter((r) => r.configured && !r.ok);
      if (failed.length > 0) {
        throw new ExitError(`${failed.length} configured provider(s) failed: ${failed.map((r) => r.provider).join(', ')}`, EXIT.FAILURE);
      }
    });
}

export function buildProgram(deps: CliDeps): Command {
  // Everything is configured before the subcommands are created: commander copies these settings into each of them.
  const program = new Command('locale')
    .description('Translate, localize and validate B2B web content for several locales.')
    .version(toolVersion(), '-V, --version')
    .exitOverride()
    .configureOutput({ writeOut: deps.stdout, writeErr: deps.stderr })
    .showHelpAfterError('(add --help for usage)')
    .addHelpText('after', EXAMPLES);
  for (const spec of PIPELINE_COMMANDS) addPipelineCommand(program, deps, spec);
  addValidateCommand(program, deps);
  addCompareCommand(program, deps);
  addLocalesCommand(program, deps);
  addProvidersCommand(program, deps);
  return program;
}

const HINTS: Partial<Record<EngineErrorCode, string>> = {
  FETCH_FAILED: 'check the URL and your network, then retry; or save the page and pass the file with --input <file>',
  ROBOTS_DISALLOWED: "the site's robots.txt forbids fetching this page; save it yourself and pass the file with --input <file>",
  URL_BLOCKED: 'private, loopback and link-local addresses are blocked (ingest.block_private_networks in config/stages.yaml)',
  UNSUPPORTED_FORMAT: 'use a .html, .htm, .md, .markdown, .txt or .docx file, or pass the content with --text',
  CONFIG_INVALID: 'fix the file named in the message (config/ folder) and run again',
};

/** Prints what went wrong and returns the exit code. Stack traces only with `LOCALE_DEBUG=1`; secrets never. */
function reportFailure(error: unknown, stderr: (text: string) => void): number {
  if (error instanceof CommanderError) {
    // commander has already printed its message; `--help` and `--version` are not failures
    return error.code === 'commander.helpDisplayed' || error.code === 'commander.version' ? EXIT.OK : EXIT.USAGE;
  }
  if (error instanceof ExitError) {
    stderr(`error: ${redactSecrets(error.message)}\n${error.exitCode === EXIT.USAGE ? '(add --help for usage)\n' : ''}`);
    return error.exitCode;
  }
  if (error instanceof EngineError) {
    const hint = HINTS[error.code];
    stderr(`error [${error.code}]: ${redactSecrets(error.message)}\n${hint ? `  hint: ${hint}\n` : ''}`);
  } else {
    stderr(`error: ${redactSecrets(error instanceof Error ? error.message : String(error))}\n`);
  }
  if (process.env['LOCALE_DEBUG'] === '1') stderr(`${errorDetail(error)}\n`);
  return error instanceof EngineError && error.code === 'COST_CEILING' ? EXIT.COST_CEILING : EXIT.FAILURE;
}

/** Parses `args` (without node and script), runs the command and returns the process exit code. Never calls `process.exit`. */
export async function runProgram(program: Command, args: readonly string[], io: Pick<CliDeps, 'stderr'>): Promise<number> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return EXIT.OK;
  } catch (error) {
    return reportFailure(error, io.stderr);
  }
}

export async function main(argv: readonly string[] = process.argv): Promise<number> {
  const deps: CliDeps = {
    getEngine: getDefaultEngine,
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
  };
  // `locale locales | head -1` closes the pipe early: that is not an error worth a stack trace.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(EXIT.OK);
    throw error;
  });
  try {
    loadDotEnv();
  } catch (error) {
    return reportFailure(error, deps.stderr);
  }
  return runProgram(buildProgram(deps), argv.slice(2), deps);
}

if (isEntryPoint(import.meta.url)) void main().then(exitWhenFlushed);
