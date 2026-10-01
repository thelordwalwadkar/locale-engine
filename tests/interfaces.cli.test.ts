import path from 'node:path';
import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, main, runProgram } from '../src/interfaces/cli.js';
import type { CliDeps } from '../src/interfaces/cli.js';
import { PIPELINE_OPTION_FLAGS } from '../src/interfaces/cli-flags.js';
import { toolVersion } from '../src/util/paths.js';
import { EngineError } from '../src/util/errors.js';
import { FakeEngine, makeRunReport } from './fixtures/interfaces/fake-engine.js';

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  engine: FakeEngine;
  getEngine: ReturnType<typeof vi.fn>;
}

async function cli(args: string[], setup?: (engine: FakeEngine) => void): Promise<CliRun> {
  const engine = new FakeEngine();
  setup?.(engine);
  let stdout = '';
  let stderr = '';
  const getEngine = vi.fn(async () => engine);
  const deps: CliDeps = {
    getEngine,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await runProgram(buildProgram(deps), args, deps);
  return { code, stdout, stderr, engine, getEngine };
}

const DEFAULT_OPTIONS = {};

describe('request mapping', () => {
  it('run --input <url> --targets all', async () => {
    const r = await cli(['run', '--input', 'https://example.nl/pompen', '--targets', 'all']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.engine.calls).toEqual([
      { method: 'runPipeline', request: { input: { kind: 'url', url: 'https://example.nl/pompen' }, targets: 'all', options: DEFAULT_OPTIONS } },
    ]);
  });

  it('targets default to all and are left to the schema default', async () => {
    const r = await cli(['run', '--input', 'https://example.nl/']);
    expect(r.engine.lastCall?.request).toEqual({ input: { kind: 'url', url: 'https://example.nl/' }, targets: 'all', options: {} });
  });

  it('a file input and a locale list', async () => {
    const r = await cli(['run', '--input', './docs/page.html', '--targets', 'de-CH,it-IT']);
    expect(r.engine.lastCall?.request).toEqual({ input: { kind: 'file', path: './docs/page.html' }, targets: ['de-CH', 'it-IT'], options: {} });
  });

  it('a Windows path is a file, not a URL', async () => {
    const r = await cli(['run', '--input', 'C:\\docs\\page.html']);
    expect(r.engine.lastCall?.request).toMatchObject({ input: { kind: 'file', path: 'C:\\docs\\page.html' } });
  });

  it('inline text with a format, every option flag, deduplicated and case-normalised targets', async () => {
    const r = await cli([
      'run',
      '--text',
      '<p>Hallo</p>',
      '--format',
      'html',
      '--targets',
      'de-DE, de-ch,DE-CH,it_it',
      '--source-locale',
      'nl-NL',
      '--keyword',
      'pomp',
      '--page-type',
      'legal',
      '--provider',
      'translation=openai:gpt',
      '--provider',
      'validation=anthropic',
      '--pass-threshold',
      '85',
      '--max-repair-loops',
      '1',
      '--cost-ceiling',
      '2.5',
      '--out',
      './o',
      '--run-id',
      'r1',
      '--no-backtranslate',
      '--no-repair',
      '--no-write',
    ]);
    expect(r.stderr).toBe('');
    expect(r.engine.lastCall).toEqual({
      method: 'runPipeline',
      request: {
        input: { kind: 'text', text: '<p>Hallo</p>', format: 'html' },
        targets: ['de-DE', 'de-CH', 'it-IT'],
        options: {
          source_locale: 'nl-NL',
          primary_keyword: 'pomp',
          page_type: 'LEGAL',
          providers: { translation: 'openai:gpt', validation: 'anthropic' },
          pass_threshold: 85,
          max_repair_loops: 1,
          cost_ceiling_usd: 2.5,
          output_dir: './o',
          run_id: 'r1',
          write_outputs: false,
          backtranslate: false,
          repair: false,
        },
      },
    });
  });

  it('the last --provider for a stage wins', async () => {
    const r = await cli(['run', '--text', 'x', '--provider', 'translation=a', '--provider', 'translation=b:m']);
    expect(r.engine.lastCall?.request).toMatchObject({ options: { providers: { translation: 'b:m' } } });
  });

  it('translate and localize call their own engine methods; localize reads a page.json', async () => {
    const t = await cli(['translate', '--input', './page.md', '--targets', 'de-DE']);
    expect(t.engine.lastCall).toEqual({ method: 'translateContent', request: { input: { kind: 'file', path: './page.md' }, targets: ['de-DE'], options: {} } });

    const l = await cli(['localize', '--input', 'output/run-1/de-CH/page.json']);
    expect(l.engine.lastCall).toEqual({
      method: 'localizeContent',
      request: { input: { kind: 'page_json', path: 'output/run-1/de-CH/page.json' }, targets: 'all', options: {} },
    });

    const raw = await cli(['localize', '--input', 'page.html', '--targets', 'en-GB']);
    expect(raw.engine.lastCall?.request).toMatchObject({ input: { kind: 'file', path: 'page.html' } });
  });

  it('only localize treats .json as a page.json', async () => {
    const r = await cli(['run', '--input', 'page.json']);
    expect(r.engine.lastCall?.request).toMatchObject({ input: { kind: 'file', path: 'page.json' } });
  });

  it('validate takes a page.json or a source/target pair', async () => {
    const page = await cli(['validate', '--input', 'output/run-1/de-CH/page.json']);
    expect(page.engine.lastCall).toEqual({ method: 'validateContent', request: { input: { kind: 'page_json', path: 'output/run-1/de-CH/page.json' }, options: {} } });

    const pair = await cli(['validate', '--source', 'Vraag een offerte aan', '--target', 'Fordern Sie ein Angebot an', '--target-locale', 'de-ch']);
    expect(pair.engine.lastCall?.request).toEqual({
      input: { kind: 'pair', source_text: 'Vraag een offerte aan', source_locale: 'nl-NL', target_text: 'Fordern Sie ein Angebot an', target_locale: 'de-CH', block_type: 'paragraph' },
      options: {},
    });

    const full = await cli([
      'validate', '--source', 'a', '--source-locale', 'en-GB', '--target', 'b', '--target-locale', 'it-IT', '--block-type', 'heading', '--repair', '--no-write',
    ]);
    expect(full.engine.lastCall?.request).toEqual({
      input: { kind: 'pair', source_text: 'a', source_locale: 'en-GB', target_text: 'b', target_locale: 'it-IT', block_type: 'heading' },
      options: { repair: true, write_outputs: false },
    });
  });

  it('compare maps providers and judge', async () => {
    const r = await cli(['compare', '--input', './p.html', '--targets', 'de-CH', '--providers', 'anthropic, openai:gpt-mini', '--judge', 'anthropic', '--no-repair']);
    expect(r.engine.lastCall).toEqual({
      method: 'compareModels',
      request: { input: { kind: 'file', path: './p.html' }, targets: ['de-CH'], providers: ['anthropic', 'openai:gpt-mini'], judge_provider: 'anthropic', options: { repair: false } },
    });
  });

  it('locales and providers test', async () => {
    const l = await cli(['locales']);
    expect(l.engine.lastCall).toEqual({ method: 'listLocales', request: undefined });
    const named = await cli(['providers', 'test', 'openai', 'anthropic']);
    expect(named.engine.lastCall).toEqual({ method: 'testProviders', request: ['openai', 'anthropic'] });
    const all = await cli(['providers', 'test']);
    expect(all.engine.lastCall).toEqual({ method: 'testProviders', request: [] });
  });

  it('has a flag for every PipelineOptions field', async () => {
    const program = buildProgram({ getEngine: async () => new FakeEngine(), stdout: () => undefined, stderr: () => undefined });
    const flagsOf = (name: string): string[] => (program.commands.find((c: Command) => c.name() === name)?.options ?? []).map((o) => o.long ?? '');
    for (const command of ['run', 'translate', 'localize', 'compare']) {
      for (const flag of Object.values(PIPELINE_OPTION_FLAGS)) expect(flagsOf(command), `${command} ${flag}`).toContain(flag);
    }
    const validate = flagsOf('validate');
    for (const flag of ['--provider', '--pass-threshold', '--max-repair-loops', '--cost-ceiling', '--out', '--run-id', '--no-write', '--no-backtranslate', '--repair', '--source-locale']) {
      expect(validate, `validate ${flag}`).toContain(flag);
    }
  });
});

describe('output', () => {
  it('prints a compact summary of the run', async () => {
    const r = await cli(['run', '--input', 'https://example.nl/pompen']);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe('Run run-1 | COMPLETE | 12.3 s | $0.0300');
    expect(lines[1]).toBe('Source: nl-NL (nl) | page type CONTENT | 1 segment, 2 words | https://example.nl/pompen');
    expect(r.stdout).toMatch(/Locale\s+Verdict\s+Score\s+Open min\/maj\/crit\s+Review\s+Cost/);
    expect(r.stdout).toMatch(/en-GB\s+PASS\s+96\.0\s+0\/0\/0\s+0\s+\$0\.0100/);
    expect(r.stdout).toMatch(/de-CH\s+HUMAN_REVIEW\s+95\.0\s+1\/1\/0\s+1\s+\$0\.0200/);
    expect(r.stdout).toContain('Output: /out/run-1');
    expect(r.stdout).toContain('localization_report.xlsx, executive_summary.md, run.json, + 2 per-locale files');
    expect(r.stderr).toBe('');
  });

  it('shows the evidence for a legal page, run log warnings, unpriced calls and a skipped output folder', async () => {
    const r = await cli(['run', '--input', 'x.html'], (e) => {
      e.report = makeRunReport({
        pageType: 'LEGAL',
        outputDir: null,
        locales: [{ locale: 'de-DE', unpricedCalls: 2 }],
        runLog: [
          { ts: 't', level: 'warn', code: 'PROVIDER_FALLBACK', message: 'm' },
          { ts: 't', level: 'warn', code: 'PROVIDER_FALLBACK', message: 'm' },
          { ts: 't', level: 'info', code: 'STAGE_START', message: 'm' },
          { ts: 't', level: 'error', code: 'PROVIDER_ERROR', message: 'm' },
        ],
      });
    });
    expect(r.stdout).toContain('page type LEGAL (url path contains "privacyverklaring")');
    expect(r.stdout).toContain('$0.0100*');
    expect(r.stdout).toContain('* cost excludes 2 calls with unknown pricing');
    expect(r.stdout).toContain('Run log: PROVIDER_FALLBACK (warn) x2, PROVIDER_ERROR (error) (details in run.json)');
    expect(r.stdout).not.toContain('STAGE_START');
    expect(r.stdout).toContain('Output: not written');
  });

  it('shows n/a instead of a score when validation did not run', async () => {
    const r = await cli(['translate', '--input', 'x.html'], (e) => {
      e.report = makeRunReport({ validate: false, locales: [{ locale: 'de-DE', verdict: 'HUMAN_REVIEW', score: 100, reasons: ['NOT_VALIDATED: translate-only run'] }] });
    });
    expect(r.stdout).toMatch(/de-DE\s+HUMAN_REVIEW\s+n\/a \(not validated\)/);
    expect(r.stdout).not.toContain('100.0');
    expect(r.stdout).toContain('Validation did not run for this step');
  });

  it('--json prints exactly one JSON document and nothing else', async () => {
    const r = await cli(['run', '--input', 'https://example.nl/', '--json']);
    expect(r.stderr).toBe('');
    expect(r.stdout.startsWith('{')).toBe(true);
    expect(r.stdout.endsWith('}\n')).toBe(true);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(JSON.stringify(r.engine.report)));
  });

  it('--json also holds for the other commands', async () => {
    const compare = await cli(['compare', '--input', 'x.html', '--providers', 'a,b', '--json']);
    expect(JSON.parse(compare.stdout)).toEqual(JSON.parse(JSON.stringify(compare.engine.compareReport)));
    const locales = await cli(['locales', '--json']);
    expect(JSON.parse(locales.stdout)).toEqual(JSON.parse(JSON.stringify(locales.engine.locales)));
    const providers = await cli(['providers', 'test', '--json']);
    expect(JSON.parse(providers.stdout)).toEqual(JSON.parse(JSON.stringify(providers.engine.providerResults)));
  });

  it('--json still prints the result when the run ends with a non-zero code', async () => {
    const r = await cli(['run', '--input', 'x.html', '--json', '--strict'], (e) => {
      e.report = makeRunReport({ locales: [{ locale: 'de-CH', verdict: 'FAIL', score: 50 }] });
    });
    expect(r.code).toBe(4);
    expect(JSON.parse(r.stdout).locales[0].verdict).toBe('FAIL');
    expect(r.stderr).toContain('--strict');
  });

  it('--quiet prints no summary', async () => {
    const r = await cli(['run', '--input', 'x.html', '--quiet']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('--quiet does not hide --json', async () => {
    const r = await cli(['run', '--input', 'x.html', '--quiet', '--json']);
    expect(JSON.parse(r.stdout).run_id).toBe('run-1');
  });

  it('prints the comparison tables and the workbook path', async () => {
    const r = await cli(['compare', '--input', 'x.html', '--providers', 'anthropic,openai']);
    expect(r.stdout).toContain('Comparison cmp-1 | judge openai/gpt-judge | providers: anthropic, openai');
    expect(r.stdout).toMatch(/anthropic\s+de-CH\s+PASS\s+97\.0\s+1\/0\/0/);
    expect(r.stdout).toMatch(/openai\s+de-CH\s+PASS_WITH_NOTES\s+91\.5\s+2\/1\/0/);
    expect(r.stdout).toMatch(/anthropic\s+5\s+400\/200\s+\$0\.0300\s+2\.5 s/);
    expect(r.stdout).toContain(`Workbook: ${path.join('/out/cmp-1', 'model_comparison.xlsx')}`);
  });

  it('prints the locales table', async () => {
    const r = await cli(['locales']);
    expect(r.stdout).toMatch(/Locale\s+Language\s+Region\s+Rules\s+Name/);
    expect(r.stdout).toMatch(/de-CH\s+de\s+CH\s+21\s+Swiss German/);
  });

  it('prints the providers table', async () => {
    const r = await cli(['providers', 'test']);
    expect(r.stdout).toMatch(/Provider\s+Model\s+Configured\s+OK\s+Latency\s+Cost\s+Error/);
    expect(r.stdout).toMatch(/anthropic\s+claude-x\s+yes\s+yes\s+812 ms\s+\$0\.0002/);
    expect(r.stdout).toMatch(/openai\s+gpt-x\s+no\s+no\s+-\s+-\s+NO_CREDENTIALS: set OPENAI_API_KEY/);
  });
});

describe('exit codes', () => {
  it('0 on success', async () => {
    expect((await cli(['run', '--input', 'x.html'])).code).toBe(0);
  });

  it('1 on an engine error, with the code, a hint and nothing on stdout', async () => {
    const r = await cli(['run', '--input', 'https://example.nl/'], (e) => {
      e.failure = new EngineError('FETCH_FAILED', 'could not fetch https://example.nl/: connection refused');
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('error [FETCH_FAILED]: could not fetch https://example.nl/: connection refused');
    expect(r.stderr).toContain('hint:');
    expect(r.stderr).not.toContain('at '); // no stack
  });

  it('1 with the message for PROVIDER_UNAVAILABLE (it names the variable to set)', async () => {
    const r = await cli(['run', '--input', 'x.html'], (e) => {
      e.failure = new EngineError('PROVIDER_UNAVAILABLE', 'no provider has credentials; set ANTHROPIC_API_KEY in .env');
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('error [PROVIDER_UNAVAILABLE]: no provider has credentials; set ANTHROPIC_API_KEY in .env');
  });

  it('1 on an unexpected error; the stack only with LOCALE_DEBUG=1', async () => {
    const boom = (e: FakeEngine): void => void (e.failure = new Error('boom'));
    const quiet = await cli(['locales'], boom);
    expect(quiet.code).toBe(1);
    expect(quiet.stderr).toBe('error: boom\n');

    vi.stubEnv('LOCALE_DEBUG', '1');
    const debug = await cli(['locales'], boom);
    expect(debug.stderr).toContain('error: boom');
    expect(debug.stderr).toMatch(/Error: boom\n\s+at /);
  });

  it('never prints a secret', async () => {
    vi.stubEnv('TEST_FAKE_API_KEY', 'sk-test-secret-value-123456');
    const r = await cli(['locales'], (e) => void (e.failure = new Error('401 for key sk-test-secret-value-123456')));
    expect(r.stderr).toContain('401 for key [REDACTED]');
    expect(r.stderr).not.toContain('sk-test-secret-value-123456');
  });

  it('3 when the engine throws COST_CEILING', async () => {
    const r = await cli(['run', '--input', 'x.html'], (e) => void (e.failure = new EngineError('COST_CEILING', 'cost ceiling exceeded')));
    expect(r.code).toBe(3);
  });

  it('3 for a halted run, after printing the result', async () => {
    const r = await cli(['run', '--input', 'x.html'], (e) => void (e.report = makeRunReport({ status: 'HALTED_COST_CEILING', costCeiling: 0.02 })));
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('HALTED_COST_CEILING');
    expect(r.stderr).toContain('halted: cost ceiling of $0.0200 reached');
    expect(r.stderr).toContain('--cost-ceiling');
  });

  it('1 for a run that FAILED', async () => {
    const r = await cli(['run', '--input', 'x.html'], (e) => void (e.report = makeRunReport({ status: 'FAILED' })));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('FAILED');
  });

  describe('--strict', () => {
    const withVerdict = (verdict: 'PASS' | 'FAIL' | 'HUMAN_REVIEW' | 'PASS_WITH_NOTES', reasons: string[] = []) => (e: FakeEngine) => {
      e.report = makeRunReport({ locales: [{ locale: 'en-GB' }, { locale: 'de-CH', verdict, reasons }] });
    };

    it('4 when a locale FAILs', async () => {
      const r = await cli(['run', '--input', 'x.html', '--strict'], withVerdict('FAIL'));
      expect(r.code).toBe(4);
      expect(r.stderr).toContain('--strict: 1 locale(s) did not pass: de-CH FAIL');
    });

    it('a FAIL is not an error without --strict', async () => {
      expect((await cli(['run', '--input', 'x.html'], withVerdict('FAIL'))).code).toBe(0);
    });

    it('HUMAN_REVIEW passes --strict but not --strict-review', async () => {
      expect((await cli(['run', '--input', 'x.html', '--strict'], withVerdict('HUMAN_REVIEW'))).code).toBe(0);
      const r = await cli(['run', '--input', 'x.html', '--strict-review'], withVerdict('HUMAN_REVIEW'));
      expect(r.code).toBe(4);
      expect(r.stderr).toContain('de-CH HUMAN_REVIEW');
    });

    it('a locale that was not validated is not a review failure', async () => {
      const r = await cli(['translate', '--input', 'x.html', '--strict-review'], (e) => {
        e.report = makeRunReport({ validate: false, locales: [{ locale: 'de-CH', verdict: 'HUMAN_REVIEW', reasons: ['NOT_VALIDATED: translate-only'] }] });
      });
      expect(r.code).toBe(0);
    });

    it('PASS and PASS_WITH_NOTES are fine', async () => {
      expect((await cli(['run', '--input', 'x.html', '--strict-review'], withVerdict('PASS_WITH_NOTES'))).code).toBe(0);
    });

    it('also applies to validate', async () => {
      const r = await cli(['validate', '--input', 'p/page.json', '--strict'], withVerdict('FAIL'));
      expect(r.code).toBe(4);
    });
  });

  describe('providers test', () => {
    it('1 when a configured provider fails', async () => {
      const r = await cli(['providers', 'test'], (e) => {
        e.providerResults = e.providerResults.map((p) => (p.provider === 'anthropic' ? { ...p, ok: false, error: 'AUTH: bad key' } : p));
      });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('AUTH: bad key');
      expect(r.stderr).toContain('1 configured provider(s) failed: anthropic');
    });

    it('0 when only an unconfigured provider fails', async () => {
      expect((await cli(['providers', 'test'])).code).toBe(0);
    });

    it('0, with advice, when nothing is configured', async () => {
      const r = await cli(['providers', 'test'], (e) => {
        e.providerResults = e.providerResults.map((p) => ({ ...p, configured: false, ok: false }));
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('No provider has credentials yet');
    });
  });

  describe('2 on a usage error, without touching the engine', () => {
    const usage: Array<[string, string[], string]> = [
      ['no input', ['run'], 'no content given: pass --input <url|file> or --text <content>'],
      ['input and text', ['run', '--input', 'a.html', '--text', 'x'], 'use either --input or --text, not both'],
      ['format without text', ['run', '--input', 'a.html', '--format', 'html'], '--format only applies to --text'],
      ['unknown flag', ['run', '--input', 'a.html', '--frobnicate'], "unknown option '--frobnicate'"],
      ['unknown command', ['publish'], "unknown command 'publish'"],
      ['unknown locale', ['run', '--input', 'a.html', '--targets', 'de-XX'], "unknown locale 'de-XX' (known: nl-NL, en-NL, en-GB, de-DE, de-AT, de-CH, it-IT; or 'all')"],
      ['all plus a locale', ['run', '--input', 'a.html', '--targets', 'all,de-CH'], "'all' cannot be combined with other locales"],
      ['empty targets', ['run', '--input', 'a.html', '--targets', ','], "expected 'all' or a comma-separated list of locales"],
      ['not a number', ['run', '--input', 'a.html', '--pass-threshold', 'abc'], "expected a number, got 'abc'"],
      ['out of range (schema)', ['run', '--input', 'a.html', '--pass-threshold', '150'], '--pass-threshold: Too big'],
      ['not an integer (schema)', ['run', '--input', 'a.html', '--max-repair-loops', '1.5'], '--max-repair-loops:'],
      ['bad format (schema)', ['run', '--text', 'x', '--format', 'pdf'], '--format: Invalid option'],
      ['bad page type (schema)', ['run', '--input', 'a.html', '--page-type', 'blog'], '--page-type: Invalid option'],
      ['bad url (schema)', ['run', '--input', 'https://'], '--input:'],
      ['empty text (schema)', ['run', '--text', ''], '--text:'],
      ['provider without stage', ['run', '--input', 'a.html', '--provider', 'openai'], 'expected <stage>=<provider[:model]>'],
      ['provider with unknown stage', ['run', '--input', 'a.html', '--provider', 'translate=openai'], 'language_detection, translation, localization, validation, backtranslation, repair'],
      ['compare without providers', ['compare', '--input', 'a.html'], "required option '--providers <a,b,c>' not specified"],
      ['compare with one provider', ['compare', '--input', 'a.html', '--providers', 'openai'], 'expected at least two provider refs'],
      ['validate with nothing', ['validate'], 'nothing to validate'],
      ['validate with a non-page.json', ['validate', '--input', 'notes.md'], '--input expects a <locale>/page.json'],
      ['validate mixing input and pair', ['validate', '--input', 'p.json', '--source', 'a'], 'use either --input <page.json> or the pair flags'],
      ['validate with an unknown target locale', ['validate', '--source', 'a', '--target', 'b', '--target-locale', 'fr-FR'], "unknown locale 'fr-FR'"],
      ['validate with a bad block type', ['validate', '--source', 'a', '--target', 'b', '--target-locale', 'de-CH', '--block-type', 'div'], '--block-type: Invalid option'],
      ['no command at all', [], 'Usage: locale'],
    ];
    it.each(usage)('%s', async (_name, args, message) => {
      const r = await cli(args);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(message);
      expect(r.stdout).toBe('');
      expect(r.engine.calls).toEqual([]);
      expect(r.getEngine).not.toHaveBeenCalled();
    });
  });

  it('--help and --version are not failures and never load the engine', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: locale');
    expect(help.stdout).toContain('providers');
    expect(help.getEngine).not.toHaveBeenCalled();
    const sub = await cli(['run', '--help']);
    expect(sub.code).toBe(0);
    expect(sub.stdout).toContain('--strict-review');
    expect(sub.stdout).toContain('--provider <stage=provider:model>');
    const version = await cli(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(toolVersion());
  });
});

describe('main', () => {
  it('runs against the real process streams and returns the exit code', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['node', 'locale', '--version'])).toBe(0);
    expect(out).toHaveBeenCalledWith(`${toolVersion()}\n`);
    expect(await main(['node', 'locale', 'run'])).toBe(2);
    expect(err.mock.calls.map((call) => String(call[0])).join('')).toContain('no content given');
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
