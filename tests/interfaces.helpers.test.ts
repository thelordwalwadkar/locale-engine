import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { InvalidArgumentError } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PipelineRequestSchema } from '../src/schemas/index.js';
import { collectOptions, inputFromFlags, parseNumber, parseProviderList, parseProviderRoute, parseTargets, schemaUsageError } from '../src/interfaces/cli-flags.js';
import { EXIT, ExitError, errorDetail, redactSecrets, requestIssues, toPublicError } from '../src/interfaces/errors.js';
import { NOT_VALIDATED_LABEL, formatCompareSummary, formatProvidersTable, formatRunSummary, isUnvalidated, renderTable } from '../src/interfaces/format.js';
import { allowedHostnamesFor, hostAllowed, originAllowed } from '../src/interfaces/host-guard.js';
import { createLazyEngine, isEntryPoint, parsePort, urlHost } from '../src/interfaces/runtime.js';
import { EngineError } from '../src/util/errors.js';
import { FakeEngine, makeCompareReport, makeProviderResults, makeRunReport } from './fixtures/interfaces/fake-engine.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('errors', () => {
  it('maps the engine errors a caller can act on, keeps their message, and hides everything else', () => {
    expect(toPublicError(new EngineError('RUN_NOT_FOUND', 'no run x'))).toEqual({ status: 404, payload: { code: 'RUN_NOT_FOUND', message: 'no run x' } });
    expect(toPublicError(new EngineError('PROVIDER_UNAVAILABLE', 'set ANTHROPIC_API_KEY')).status).toBe(503);
    for (const hidden of [new EngineError('CONFIG_INVALID', 'C:\\secret\\path'), new EngineError('INTERNAL', 'oops'), new Error('oops'), 'a string', undefined]) {
      expect(toPublicError(hidden)).toEqual({ status: 500, payload: { code: 'INTERNAL', message: 'internal error; the server log has the details' } });
    }
  });

  it('redacts the value of credential-looking environment variables, every time it occurs', () => {
    vi.stubEnv('TEST_FAKE_API_KEY', 'sk-test-secret-value-123456');
    vi.stubEnv('TEST_FAKE_TOKEN', 'token-value-abcdefgh');
    vi.stubEnv('TEST_SHORT_SECRET', 'short'); // below 8 characters: too likely to be a normal word
    vi.stubEnv('TEST_FAKE_NAME', 'plain-value-not-a-secret');
    const text = 'a sk-test-secret-value-123456 b sk-test-secret-value-123456 c token-value-abcdefgh short plain-value-not-a-secret';
    expect(redactSecrets(text)).toBe('a [REDACTED] b [REDACTED] c [REDACTED] short plain-value-not-a-secret');
  });

  it('errorDetail has the stack, without secrets', () => {
    vi.stubEnv('TEST_FAKE_API_KEY', 'sk-test-secret-value-123456');
    const detail = errorDetail(new Error('bad key sk-test-secret-value-123456'));
    expect(detail).toContain('Error: bad key [REDACTED]');
    expect(detail).toMatch(/\n\s+at /);
    expect(errorDetail('plain')).toBe('plain');
  });

  it('ExitError carries its exit code', () => {
    expect(new ExitError('m', EXIT.COST_CEILING).exitCode).toBe(3);
    expect(EXIT).toEqual({ OK: 0, FAILURE: 1, USAGE: 2, COST_CEILING: 3, STRICT: 4 });
  });

  describe('requestIssues', () => {
    const issues = (value: unknown): Array<{ path: string; message: string }> => {
      const parsed = PipelineRequestSchema.safeParse(value);
      return parsed.success ? [] : requestIssues(parsed.error);
    };

    it('reports the alternative of a failed union that matched furthest', () => {
      const [issue] = issues({ input: { kind: 'text', text: 'x' }, targets: ['de-CH', 'de-XX'] });
      expect(issue?.path).toBe('targets.1');
      expect(issue?.message).toContain('expected one of "nl-NL"|"en-NL"');
    });

    it('uses (root) for the body itself and dots for nesting', () => {
      expect(issues(undefined)[0]?.path).toBe('(root)');
      expect(issues({ input: { kind: 'text', text: 'x' }, options: { providers: { translation: 5 } } })[0]?.path).toBe('options.providers.translation');
    });

    it('lists every invalid field', () => {
      expect(issues({ input: { kind: 'url', url: 'x' }, targets: [], options: { pass_threshold: -1 } }).map((i) => i.path)).toEqual(['input.url', 'targets', 'options.pass_threshold']);
    });
  });
});

describe('format', () => {
  it('renderTable pads columns, right-aligns where asked and leaves no trailing spaces', () => {
    const table = renderTable(['Name', 'N'], [['a', '1'], ['longer', '22']], ['l', 'r']);
    expect(table).toBe(['Name     N', 'a        1', 'longer  22'].join('\n'));
    expect(table.split('\n').every((line) => line === line.trimEnd())).toBe(true);
  });

  it('a run summary says which locales were not validated', () => {
    const report = makeRunReport({ validate: false, locales: [{ locale: 'de-DE', verdict: 'HUMAN_REVIEW', reasons: ['NOT_VALIDATED: translate-only'] }] });
    const locale = report.locales[0];
    expect(locale && isUnvalidated(report, locale)).toBe(true);
    expect(formatRunSummary(report)).toContain(NOT_VALIDATED_LABEL);
    const validated = makeRunReport();
    expect(validated.locales.some((l) => isUnvalidated(validated, l))).toBe(false);
  });

  it('a locale whose reasons start with NOT_VALIDATED is unvalidated even when stages.validate says true', () => {
    const report = makeRunReport({ locales: [{ locale: 'de-DE', verdict: 'HUMAN_REVIEW', reasons: ['NOT_VALIDATED: localize-only'] }] });
    expect(formatRunSummary(report)).toContain(NOT_VALIDATED_LABEL);
  });

  it('counts only open findings, per severity', () => {
    const report = makeRunReport({ locales: [{ locale: 'de-CH', open: { minor: 3, major: 2, critical: 1 } }] });
    const locale = report.locales[0];
    const findings = locale?.segments[0]?.validation?.findings ?? [];
    findings[0] && (findings[0].status = 'fixed');
    expect(formatRunSummary(report)).toMatch(/de-CH\s+PASS\s+96\.0\s+2\/2\/1\s/);
  });

  it('comparison totals fall back to the sum of the stages when there is no "all" row', () => {
    const report = makeCompareReport();
    report.cost_latency = [
      { provider: 'anthropic', stage: 'translation', calls: 2, input_tokens: 100, output_tokens: 50, cost_usd: 0.01, latency_ms: 1000 },
      { provider: 'anthropic', stage: 'localization', calls: 3, input_tokens: 200, output_tokens: 70, cost_usd: 0.02, latency_ms: 1500 },
    ];
    expect(formatCompareSummary(report)).toMatch(/anthropic\s+5\s+300\/120\s+\$0\.0300\s+2\.5 s/);
    expect(formatCompareSummary(report)).toMatch(/openai\s+0\s+0\/0\s+\$0\.0000\s+0\.0 s/);
  });

  it('a comparison without a written workbook says so', () => {
    const report = makeCompareReport();
    report.output_dir = null;
    report.artifacts = [];
    expect(formatCompareSummary(report)).toContain('Workbook: not written');
    expect(formatCompareSummary(makeCompareReport())).toContain(`Workbook: ${path.join('/out/cmp-1', 'model_comparison.xlsx')}`);
  });

  it('the providers table shows the first line of an error, shortened', () => {
    const [first] = makeProviderResults();
    if (!first) throw new Error('fixture');
    const table = formatProvidersTable([{ ...first, ok: false, error: `${'x'.repeat(100)}\nsecond line` }]);
    expect(table).not.toContain('second line');
    expect(table).toContain(`${'x'.repeat(69)}…`);
  });
});

describe('loopback guard', () => {
  it('guards loopback binds only', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.2', 'LOCALHOST']) expect(allowedHostnamesFor(host), host).toEqual(['localhost', '127.0.0.1', '[::1]']);
    for (const host of ['0.0.0.0', '192.168.1.5', 'example.com', '::']) expect(allowedHostnamesFor(host), host).toBeUndefined();
  });

  it('LOCALE_ALLOWED_HOSTS adds the hostnames a reverse proxy forwards', () => {
    const env = { LOCALE_ALLOWED_HOSTS: ' API.example.com, ,tools.example.com ' };
    expect(allowedHostnamesFor('127.0.0.1', env)).toEqual(['localhost', '127.0.0.1', '[::1]', 'api.example.com', 'tools.example.com']);
    expect(allowedHostnamesFor('0.0.0.0', env)).toBeUndefined();
  });

  const allowed = ['localhost', '127.0.0.1', '[::1]'];

  it('Host: local names with or without a port; a missing Host is not a browser', () => {
    for (const host of ['localhost', 'localhost:8787', '127.0.0.1:1', '[::1]:8788', 'LocalHost:80', undefined]) expect(hostAllowed(host, allowed), String(host)).toBe(true);
    for (const host of ['evil.example', 'evil.example:8787', 'localhost.evil.example', '127.0.0.1.evil.example', '0.0.0.0:8787', '[::2]', 'a b', '']) expect(hostAllowed(host, allowed), host).toBe(false);
  });

  it('Origin: local pages only; "null" and garbage are refused; absent is fine', () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1', 'https://[::1]:9', undefined]) expect(originAllowed(origin, allowed), String(origin)).toBe(true);
    for (const origin of ['https://evil.example', 'null', 'file://', 'nonsense', 'http://localhost.evil.example']) expect(originAllowed(origin, allowed), origin).toBe(false);
  });
});

describe('runtime', () => {
  it('createLazyEngine loads once, only when asked, and retries after a failure', async () => {
    const engine = new FakeEngine();
    const load = vi.fn(async () => engine);
    const get = createLazyEngine(load);
    expect(load).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(engine);
    expect(b).toBe(engine);
    expect(load).toHaveBeenCalledTimes(1);

    const flaky = vi.fn().mockRejectedValueOnce(new Error('config broken')).mockResolvedValue(engine);
    const retry = createLazyEngine(flaky);
    await expect(retry()).rejects.toThrow('config broken');
    await expect(retry()).resolves.toBe(engine);
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('parsePort accepts 0..65535 and refuses the rest with a usage error', () => {
    expect(parsePort('0')).toBe(0);
    expect(parsePort('8787')).toBe(8787);
    expect(parsePort('65535')).toBe(65535);
    for (const bad of ['', ' ', 'abc', '-1', '65536', '8787.5', '1e3']) {
      expect(() => parsePort(bad), bad).toThrow(ExitError);
    }
    expect(() => parsePort('x', 'LOCALE_API_PORT')).toThrow("LOCALE_API_PORT expects a port number between 0 and 65535, got 'x'");
  });

  it('urlHost brackets IPv6 literals', () => {
    expect(urlHost('127.0.0.1')).toBe('127.0.0.1');
    expect(urlHost('::1')).toBe('[::1]');
    expect(urlHost('[::1]')).toBe('[::1]');
  });

  it('isEntryPoint is true only for the script node was started with', () => {
    const self = fileURLToPath(import.meta.url);
    const moduleUrl = pathToFileURL(self).href;
    expect(isEntryPoint(moduleUrl, self)).toBe(true);
    expect(isEntryPoint(moduleUrl, path.relative(process.cwd(), self))).toBe(true);
    if (process.platform === 'win32') expect(isEntryPoint(moduleUrl, self.toUpperCase())).toBe(true);
    expect(isEntryPoint(moduleUrl, path.join(path.dirname(self), 'interfaces.cli.test.ts'))).toBe(false);
    expect(isEntryPoint(moduleUrl, path.join(path.dirname(self), 'does-not-exist.ts'))).toBe(false);
    expect(isEntryPoint(moduleUrl, undefined)).toBe(false);
  });
});

describe('cli flags', () => {
  it('parseTargets', () => {
    expect(parseTargets('all')).toBe('all');
    expect(parseTargets(' ALL ')).toBe('all');
    expect(parseTargets('de-CH,it-IT')).toEqual(['de-CH', 'it-IT']);
    expect(parseTargets('de_ch, EN-gb ,de-CH')).toEqual(['de-CH', 'en-GB']);
    expect(() => parseTargets('de-CH,fr-FR')).toThrow(InvalidArgumentError);
    expect(() => parseTargets('de-CH,fr-FR')).toThrow("unknown locale 'fr-FR' (known: nl-NL, en-NL, en-GB, de-DE, de-AT, de-CH, it-IT; or 'all')");
    expect(() => parseTargets('')).toThrow("expected 'all' or a comma-separated list of locales");
    expect(() => parseTargets('de-CH,all')).toThrow("'all' cannot be combined");
  });

  it('parseProviderRoute', () => {
    expect(parseProviderRoute('translation=openai:gpt', undefined)).toEqual({ translation: 'openai:gpt' });
    expect(parseProviderRoute(' repair = anthropic ', { translation: 'a' })).toEqual({ translation: 'a', repair: 'anthropic' });
    const previous = { translation: 'a' };
    parseProviderRoute('translation=b', previous);
    expect(previous).toEqual({ translation: 'a' }); // not mutated
    for (const bad of ['translation', 'translation=', '=openai', 'translate=openai', 'language-detection=x']) {
      expect(() => parseProviderRoute(bad, undefined), bad).toThrow(InvalidArgumentError);
    }
  });

  it('parseProviderList and parseNumber', () => {
    expect(parseProviderList('a, b:m ,c')).toEqual(['a', 'b:m', 'c']);
    expect(() => parseProviderList('a')).toThrow('at least two');
    expect(() => parseProviderList(' , ')).toThrow('at least two');
    expect(parseNumber('85')).toBe(85);
    expect(parseNumber('0.5')).toBe(0.5);
    for (const bad of ['', ' ', 'abc', 'NaN', 'Infinity']) expect(() => parseNumber(bad), bad).toThrow(InvalidArgumentError);
  });

  it('collectOptions puts only the given flags into the options', () => {
    expect(collectOptions({}, 'negated')).toEqual({});
    expect(collectOptions({ write: true, backtranslate: true, repair: true }, 'negated')).toEqual({});
    expect(collectOptions({ repair: false }, 'negated')).toEqual({ repair: false });
    expect(collectOptions({ repair: true }, 'enabled')).toEqual({ repair: true });
    expect(collectOptions({ repair: undefined }, 'enabled')).toEqual({});
  });

  it('inputFromFlags', () => {
    expect(inputFromFlags({ input: 'HTTPS://example.nl/x' }, { pageJson: false })).toEqual({ kind: 'url', url: 'HTTPS://example.nl/x' });
    expect(inputFromFlags({ input: 'a/PAGE.JSON' }, { pageJson: true })).toEqual({ kind: 'page_json', path: 'a/PAGE.JSON' });
    expect(inputFromFlags({ input: 'a/page.json' }, { pageJson: false })).toEqual({ kind: 'file', path: 'a/page.json' });
    expect(inputFromFlags({ text: 'x' }, { pageJson: false })).toEqual({ kind: 'text', text: 'x' });
    expect(inputFromFlags({ text: 'x', format: 'markdown' }, { pageJson: false })).toEqual({ kind: 'text', text: 'x', format: 'markdown' });
  });

  it('schema errors are reported in terms of flags, unmapped paths as they are', () => {
    const error = schemaUsageError([
      { path: 'options.providers.translation', message: 'm1' },
      { path: 'input.format', message: 'm2' },
      { path: 'something.else', message: 'm3' },
    ]);
    expect(error.exitCode).toBe(2);
    expect(error.message).toBe('invalid options\n  --provider: m1\n  --format: m2\n  something.else: m3');
  });
});
