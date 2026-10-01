import { request as httpRequest } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApi, parseApiArgs, startApi } from '../src/interfaces/api.js';
import { ExitError } from '../src/interfaces/errors.js';
import type { ApiOptions } from '../src/interfaces/api.js';
import { REST_ROUTES } from '../src/interfaces/openapi.js';
import { toolVersion } from '../src/util/paths.js';
import { EngineError } from '../src/util/errors.js';
import type { EngineErrorCode } from '../src/util/errors.js';
import { FakeEngine, makeRunReport } from './fixtures/interfaces/fake-engine.js';

const apps: FastifyInstance[] = [];

function setup(opts?: ApiOptions): { app: FastifyInstance; engine: FakeEngine } {
  const engine = new FakeEngine();
  const app = buildApi(engine, opts);
  apps.push(app);
  return { app, engine };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const TEXT_BODY = { input: { kind: 'text', text: 'Hallo wereld' } };
const PARSED_TEXT_REQUEST = { input: { kind: 'text', text: 'Hallo wereld', format: 'text' }, targets: 'all', options: {} };

describe('POST routes', () => {
  const routes: Array<[string, string, unknown]> = [
    ['/v1/pipeline', 'runPipeline', TEXT_BODY],
    ['/v1/translate', 'translateContent', TEXT_BODY],
    ['/v1/localize', 'localizeContent', TEXT_BODY],
  ];
  it.each(routes)('%s calls %s with the schema-parsed body and returns the result unchanged', async (url, method, body) => {
    const { app, engine } = setup();
    const res = await app.inject({ method: 'POST', url, payload: body as object });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(engine.report)));
    expect(engine.calls).toEqual([{ method, request: PARSED_TEXT_REQUEST }]);
  });

  it('passes targets and options through', async () => {
    const { app, engine } = setup();
    const body = { input: { kind: 'url', url: 'https://example.nl/pompen' }, targets: ['de-CH', 'it-IT'], options: { repair: false, pass_threshold: 80, providers: { translation: 'openai:gpt' } } };
    const res = await app.inject({ method: 'POST', url: '/v1/pipeline', payload: body });
    expect(res.statusCode).toBe(200);
    expect(engine.lastCall?.request).toEqual(body);
  });

  it('/v1/validate takes a page.json or a pair', async () => {
    const { app, engine } = setup();
    const pair = { input: { kind: 'pair', source_text: 'Vraag een offerte aan', target_text: 'Fordern Sie ein Angebot an', target_locale: 'de-CH' } };
    const res = await app.inject({ method: 'POST', url: '/v1/validate', payload: pair });
    expect(res.statusCode).toBe(200);
    expect(engine.lastCall).toEqual({
      method: 'validateContent',
      request: { input: { kind: 'pair', source_locale: 'nl-NL', block_type: 'paragraph', source_text: 'Vraag een offerte aan', target_text: 'Fordern Sie ein Angebot an', target_locale: 'de-CH' }, options: {} },
    });
    const page = await app.inject({ method: 'POST', url: '/v1/validate', payload: { input: { kind: 'page_json', path: 'out/run-1/de-CH/page.json' }, options: { repair: true } } });
    expect(page.statusCode).toBe(200);
    expect(engine.lastCall?.request).toEqual({ input: { kind: 'page_json', path: 'out/run-1/de-CH/page.json' }, options: { repair: true } });
  });

  it('exposes exactly the seven capabilities (spec 6.4 lists six; /v1/compare is added for interface parity, rubric R6)', () => {
    expect(REST_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /v1/pipeline',
      'POST /v1/translate',
      'POST /v1/localize',
      'POST /v1/validate',
      'POST /v1/compare',
      'GET /v1/locales',
      'GET /v1/runs/:run_id',
    ]);
  });
});

describe('GET routes', () => {
  it('/v1/locales', async () => {
    const { app, engine } = setup();
    const res = await app.inject({ method: 'GET', url: '/v1/locales' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(JSON.parse(JSON.stringify(engine.locales)));
    expect(engine.calls).toEqual([{ method: 'listLocales', request: undefined }]);
  });

  it('/v1/runs/:run_id with and without ?output_dir=', async () => {
    const { app, engine } = setup();
    const plain = await app.inject({ method: 'GET', url: '/v1/runs/run-1' });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().run_id).toBe('run-1');
    expect(engine.lastCall).toEqual({ method: 'getRunReport', request: { run_id: 'run-1' } });

    await app.inject({ method: 'GET', url: '/v1/runs/run-1?output_dir=%2Ftmp%2Fout' });
    expect(engine.lastCall?.request).toEqual({ run_id: 'run-1', output_dir: '/tmp/out' });
  });

  it('the path parameter wins over a run_id in the query string', async () => {
    const { app, engine } = setup();
    await app.inject({ method: 'GET', url: '/v1/runs/real?run_id=fake' });
    expect(engine.lastCall?.request).toEqual({ run_id: 'real' });
  });

  it('a repeated output_dir is a 400, not a guess', async () => {
    const { app, engine } = setup();
    const res = await app.inject({ method: 'GET', url: '/v1/runs/run-1?output_dir=a&output_dir=b' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.issues[0].path).toBe('output_dir');
    expect(engine.calls).toEqual([]);
  });
});

describe('request errors', () => {
  it('400 INVALID_REQUEST with one issue per invalid field', async () => {
    const { app, engine } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/pipeline', payload: { input: { kind: 'url', url: 'nope' }, options: { pass_threshold: 150 } } });
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.message).toContain('request is invalid:');
    expect(error.issues).toEqual([
      { path: 'input.url', message: 'Invalid URL' },
      { path: 'options.pass_threshold', message: 'Too big: expected number to be <=100' },
    ]);
    expect(engine.calls).toEqual([]);
  });

  it('names the valid locales for an unknown target', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/pipeline', payload: { ...TEXT_BODY, targets: ['de-XX'] } });
    expect(res.statusCode).toBe(400);
    const [issue] = res.json().error.issues;
    expect(issue.path).toBe('targets.0');
    expect(issue.message).toContain('"de-CH"');
  });

  it('says what the valid input kinds are', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/pipeline', payload: { input: { kind: 'ftp' } } });
    expect(res.json().error.issues[0]).toEqual({ path: 'input.kind', message: "Invalid discriminator value. Expected 'url' | 'file' | 'text' | 'page_json'" });
  });

  it('a missing body is a 400 about the body', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/pipeline' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.issues[0]).toEqual({ path: '(root)', message: 'Invalid input: expected object, received undefined' });
    const withType = await app.inject({ method: 'POST', url: '/v1/pipeline', headers: { 'content-type': 'application/json' }, payload: '' });
    expect(withType.statusCode).toBe(400);
    expect(withType.json().error.code).toBe('INVALID_REQUEST');
    const nonObject = await app.inject({ method: 'POST', url: '/v1/pipeline', payload: '[]', headers: { 'content-type': 'application/json' } });
    expect(nonObject.statusCode).toBe(400);
    expect(nonObject.json().error.issues[0].path).toBe('(root)');
  });

  it('400 for JSON that does not parse', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/pipeline', headers: { 'content-type': 'application/json' }, payload: '{"input":' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
  });

  it('415 for a body that is not JSON', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/pipeline', headers: { 'content-type': 'text/plain' }, payload: 'hello' });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(res.json().error.message).toContain('application/json');
  });

  it('413 over the body limit', async () => {
    const { app, engine } = setup({ bodyLimitBytes: 300 });
    const res = await app.inject({ method: 'POST', url: '/v1/pipeline', payload: { input: { kind: 'text', text: 'x'.repeat(1000) } } });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toEqual({ code: 'PAYLOAD_TOO_LARGE', message: expect.stringContaining('limit of 300 bytes') });
    expect(engine.calls).toEqual([]);
    const small = await app.inject({ method: 'POST', url: '/v1/pipeline', payload: { input: { kind: 'text', text: 'ok' } } });
    expect(small.statusCode).toBe(200);
  });

  it('accepts bodies up to 5 MB by default', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/pipeline', payload: { input: { kind: 'text', text: 'x'.repeat(4 * 1024 * 1024) } } });
    expect(res.statusCode).toBe(200);
  });

  it('404 for an unknown route, pointing at the OpenAPI document', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/v1/pipeline' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toEqual({ code: 'NOT_FOUND', message: 'no route GET /v1/pipeline; GET /openapi.json lists the routes' });
  });
});

describe('engine errors', () => {
  const mapped: Array<[EngineErrorCode, number]> = [
    ['INPUT_INVALID', 400],
    ['UNSUPPORTED_FORMAT', 415],
    ['RUN_NOT_FOUND', 404],
    ['URL_BLOCKED', 422],
    ['ROBOTS_DISALLOWED', 422],
    ['FETCH_FAILED', 502],
    ['COST_CEILING', 422],
    ['UNSUPPORTED_ROUTE', 422],
    ['PROVIDER_UNAVAILABLE', 503],
  ];
  it.each(mapped)('%s -> %i with the engine message', async (code, status) => {
    const { app, engine } = setup();
    engine.failure = new EngineError(code, `message for ${code}`);
    const res = await app.inject({ method: 'POST', url: '/v1/pipeline', payload: TEXT_BODY });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: { code, message: `message for ${code}` } });
  });

  it('also on GET routes', async () => {
    const { app, engine } = setup();
    engine.failure = new EngineError('RUN_NOT_FOUND', 'no run nope in ./output');
    const res = await app.inject({ method: 'GET', url: '/v1/runs/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'RUN_NOT_FOUND', message: 'no run nope in ./output' } });
  });

  it.each<EngineErrorCode>(['CONFIG_INVALID', 'INTERNAL'])('%s is a 500 with a generic message', async (code) => {
    const { app, engine } = setup();
    engine.failure = new EngineError(code, 'details at C:\\srv\\config\\stages.yaml');
    const res = await app.inject({ method: 'POST', url: '/v1/pipeline', payload: TEXT_BODY });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'internal error; the server log has the details' } });
  });

  it('an unexpected error is a 500 that leaks neither message nor stack, but is logged', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const { app, engine } = setup({ logger: true });
    engine.failure = new TypeError('cannot read property x of undefined (/srv/app/engine.ts:42)');
    const res = await app.inject({ method: 'POST', url: '/v1/pipeline', payload: TEXT_BODY });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('cannot read property');
    expect(res.body).not.toContain('engine.ts');
    expect(res.json().error.code).toBe('INTERNAL');
    const log = lines.join('');
    expect(log).toContain('request failed');
    expect(log).toContain('cannot read property x of undefined');
  });

  it('redacts credentials that an engine message might carry', async () => {
    vi.stubEnv('TEST_FAKE_API_KEY', 'sk-test-secret-value-123456');
    const { app, engine } = setup();
    engine.failure = new EngineError('FETCH_FAILED', 'request with key sk-test-secret-value-123456 failed');
    const res = await app.inject({ method: 'POST', url: '/v1/pipeline', payload: TEXT_BODY });
    expect(res.json().error.message).toBe('request with key [REDACTED] failed');
    expect(res.body).not.toContain('sk-test-secret-value-123456');
  });
});

describe('operations endpoints', () => {
  it('GET /health', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: toolVersion() });
  });

  it('GET /openapi.json is an OpenAPI 3.1 document that describes every route', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toMatchObject({ title: 'locale-engine API', version: toolVersion() });
    expect(Object.keys(doc.paths).sort()).toEqual(['/health', '/openapi.json', '/v1/compare', '/v1/locales', '/v1/localize', '/v1/pipeline', '/v1/runs/{run_id}', '/v1/translate', '/v1/validate']);
    const operation = (p: string, m: string): Record<string, unknown> => doc.paths[p][m];
    expect(operation('/v1/pipeline', 'post').operationId).toBe('run_pipeline');
    expect(operation('/v1/translate', 'post').operationId).toBe('translate_content');
    expect(operation('/v1/localize', 'post').operationId).toBe('localize_content');
    expect(operation('/v1/validate', 'post').operationId).toBe('validate_content');
    expect(operation('/v1/locales', 'get').operationId).toBe('list_locales');
    expect(operation('/v1/runs/{run_id}', 'get').operationId).toBe('get_run_report');
    expect(doc.paths['/v1/runs/{run_id}'].get.parameters).toEqual([
      { name: 'run_id', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
      { name: 'output_dir', in: 'query', required: false, schema: { type: 'string' } },
    ]);
    expect(Object.keys(doc.paths['/v1/pipeline'].post.responses)).toEqual(['200', '400', '413', '415', '422', '500', '502', '503']);
    expect(Object.keys(doc.components.schemas).sort()).toEqual(
      ['CompareReport', 'CompareRequest', 'ErrorResponse', 'GetRunReportRequest', 'HealthResponse', 'ListLocalesResponse', 'PipelineRequest', 'RunReport', 'ValidateRequest'],
    );
  });

  it('every $ref in the OpenAPI document resolves', async () => {
    const { app } = setup();
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (typeof node === 'object' && node !== null) {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref' && typeof value === 'string') refs.push(value);
          else walk(value);
        }
      }
    };
    walk(doc);
    expect(refs.length).toBeGreaterThan(10);
    for (const ref of refs) {
      expect(ref).toMatch(/^#\/components\/schemas\/\w+$/);
      expect(doc.components.schemas[ref.split('/').pop() as string], ref).toBeDefined();
    }
  });
});

describe('loopback guard', () => {
  const guarded = ['localhost', '127.0.0.1', '[::1]'];

  it('refuses a foreign Host (DNS rebinding) before doing anything', async () => {
    const { app, engine } = setup({ allowedHosts: guarded });
    const res = await app.inject({ method: 'POST', url: '/v1/pipeline', headers: { host: 'evil.example:8787' }, payload: TEXT_BODY });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('HOST_NOT_ALLOWED');
    expect(engine.calls).toEqual([]);
  });

  it('refuses a foreign Origin', async () => {
    const { app } = setup({ allowedHosts: guarded });
    const res = await app.inject({ method: 'GET', url: '/health', headers: { host: 'localhost:8787', origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
  });

  it.each([['localhost:8787'], ['127.0.0.1:8787'], ['[::1]:8787'], ['LOCALHOST']])('accepts Host %s', async (host) => {
    const { app } = setup({ allowedHosts: guarded });
    const res = await app.inject({ method: 'GET', url: '/health', headers: { host } });
    expect(res.statusCode).toBe(200);
  });

  it('accepts a local page as Origin and requests without one', async () => {
    const { app } = setup({ allowedHosts: guarded });
    const res = await app.inject({ method: 'GET', url: '/health', headers: { host: 'localhost:8787', origin: 'http://localhost:3000' } });
    expect(res.statusCode).toBe(200);
  });

  it('is off unless requested', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('bin arguments', () => {
  it('--host, --port and --help', () => {
    expect(parseApiArgs([])).toEqual({ help: false });
    expect(parseApiArgs(['--host', '0.0.0.0', '--port', '9000'])).toEqual({ help: false, host: '0.0.0.0', port: 9000 });
    expect(parseApiArgs(['-h'])).toEqual({ help: true });
  });

  it.each([
    [['--port', 'abc'], "--port expects a port number between 0 and 65535, got 'abc'"],
    [['--port'], "Option '--port <value>' argument missing"],
    [['--bind', 'x'], "Unknown option '--bind'"],
    [['extra'], "Unexpected argument 'extra'"],
  ])('%j is a usage error', (args, message) => {
    let error: unknown;
    try {
      parseApiArgs(args);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ExitError);
    expect((error as ExitError).exitCode).toBe(2);
    expect((error as ExitError).message).toContain(message);
  });
});

describe('startApi', () => {
  it('listens on loopback and answers over a real socket', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const engine = new FakeEngine();
    const running = await startApi({ engine, port: 0 });
    try {
      expect(running.url).toBe(`http://127.0.0.1:${running.port}`);
      expect(running.port).toBeGreaterThan(0);
      const health = await fetch(`${running.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok', version: toolVersion() });

      const pipeline = await fetch(`${running.url}/v1/pipeline`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(TEXT_BODY) });
      expect(pipeline.status).toBe(200);
      expect(((await pipeline.json()) as { run_id: string }).run_id).toBe(makeRunReport().run_id);

      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: running.port, path: '/health', headers: { host: 'evil.example' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(403);
    } finally {
      await running.close();
    }
  });

  it('a port that is not a number is a usage error', async () => {
    vi.stubEnv('LOCALE_API_PORT', 'http');
    await expect(startApi({ engine: new FakeEngine() })).rejects.toThrow("LOCALE_API_PORT expects a port number between 0 and 65535, got 'http'");
  });
});
