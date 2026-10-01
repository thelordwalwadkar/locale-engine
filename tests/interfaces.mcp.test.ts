import { request as httpRequest } from 'node:http';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { buildMcpServer, describeMcpTools, parseMcpArgs, routeConsoleToStderr, startHttp, startStdio } from '../src/interfaces/mcp_server.js';
import { CompareReportSchema, ListLocalesResponseSchema, RunReportSchema } from '../src/schemas/index.js';
import { EngineError } from '../src/util/errors.js';
import { ExitError } from '../src/interfaces/errors.js';
import { FakeEngine } from './fixtures/interfaces/fake-engine.js';
import type { EngineMethod } from './fixtures/interfaces/fake-engine.js';

const TOOL_NAMES = ['run_pipeline', 'translate_content', 'localize_content', 'validate_content', 'compare_models', 'list_locales', 'get_run_report'];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function connect(engine: FakeEngine, log: (line: string) => void = () => undefined): Promise<Client> {
  const server = buildMcpServer(engine, { log });
  const client = new Client({ name: 'interfaces-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

/** The text of the first content block of a tool result. */
function textOf(result: object): string {
  const [block] = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  expect(block?.type).toBe('text');
  return block?.text ?? '';
}

describe('tools/list', () => {
  it('lists exactly the seven tools of spec 6.4', async () => {
    const client = await connect(new FakeEngine());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.outputSchema?.type, tool.name).toBe('object');
    }
  });

  it('describeMcpTools() is what a client sees', async () => {
    const client = await connect(new FakeEngine());
    const { tools } = await client.listTools();
    expect(describeMcpTools()).toEqual(tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema })));
  });

  it('tells an LLM client what to pass', () => {
    const descriptions = Object.fromEntries(describeMcpTools().map((t) => [t.name, t.description]));
    expect(descriptions['run_pipeline']).toContain("targets is 'all'");
    expect(descriptions['run_pipeline']).toContain("{kind:'url', url}");
    expect(descriptions['validate_content']).toContain("{kind:'pair'");
    expect(descriptions['compare_models']).toContain('at least two');
    expect(descriptions['list_locales']).toContain('no arguments');
  });

  it('marks the read-only tools', async () => {
    const client = await connect(new FakeEngine());
    const { tools } = await client.listTools();
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    expect(readOnly).toEqual(['list_locales', 'get_run_report']);
  });
});

describe('tools/call', () => {
  const textArgs = { input: { kind: 'text', text: 'Hallo wereld' } };
  const calls: Array<[string, Record<string, unknown> | undefined, EngineMethod, z.ZodType]> = [
    ['run_pipeline', textArgs, 'runPipeline', RunReportSchema],
    ['translate_content', textArgs, 'translateContent', RunReportSchema],
    ['localize_content', { input: { kind: 'page_json', path: 'out/run-1/de-CH/page.json' }, targets: ['de-CH'] }, 'localizeContent', RunReportSchema],
    ['validate_content', { input: { kind: 'pair', source_text: 'a', target_text: 'b', target_locale: 'de-CH' } }, 'validateContent', RunReportSchema],
    ['compare_models', { ...textArgs, providers: ['anthropic', 'openai'] }, 'compareModels', CompareReportSchema],
    ['list_locales', undefined, 'listLocales', ListLocalesResponseSchema],
    ['get_run_report', { run_id: 'run-1' }, 'getRunReport', RunReportSchema],
  ];

  it.each(calls)('%s calls one engine method and returns schema-valid structured content', async (name, args, method, schema) => {
    const engine = new FakeEngine();
    const client = await connect(engine);
    const result = await client.callTool({ name, ...(args ? { arguments: args } : {}) });
    expect(result.isError).toBeFalsy();
    expect(engine.calls.map((c) => c.method)).toEqual([method]);
    expect(schema.safeParse(result.structuredContent).success).toBe(true);
  });

  it('run_pipeline: the engine gets the schema-parsed request, the result comes back unchanged', async () => {
    const engine = new FakeEngine();
    const client = await connect(engine);
    const result = await client.callTool({ name: 'run_pipeline', arguments: { input: { kind: 'text', text: 'Hallo wereld' }, options: { repair: false } } });
    expect(engine.lastCall?.request).toEqual({ input: { kind: 'text', text: 'Hallo wereld', format: 'text' }, targets: 'all', options: { repair: false } });
    expect(result.structuredContent).toEqual(JSON.parse(JSON.stringify(engine.report)));
  });

  it('the text block is a short summary followed by the JSON', async () => {
    const engine = new FakeEngine();
    const client = await connect(engine);
    const result = await client.callTool({ name: 'run_pipeline', arguments: textArgs });
    const text = textOf(result);
    const jsonAt = text.indexOf('\n\n{');
    const summary = text.slice(0, jsonAt);
    expect(summary).toContain('Run run-1 | COMPLETE');
    expect(summary).toMatch(/de-CH\s+HUMAN_REVIEW\s+95\.0\s+1\/1\/0/);
    expect(summary.split('\n').length).toBeLessThan(20);
    expect(JSON.parse(text.slice(jsonAt + 2))).toEqual(JSON.parse(JSON.stringify(engine.report)));
  });

  it('list_locales accepts a call with and without arguments', async () => {
    const client = await connect(new FakeEngine());
    expect((await client.callTool({ name: 'list_locales' })).isError).toBeFalsy();
    expect((await client.callTool({ name: 'list_locales', arguments: {} })).isError).toBeFalsy();
  });

  it('an engine failure is an isError result with {code, message}, not a protocol error', async () => {
    const engine = new FakeEngine();
    engine.failure = new EngineError('URL_BLOCKED', "'http://10.0.0.5/' is a private address");
    const client = await connect(engine);
    const result = await client.callTool({ name: 'run_pipeline', arguments: { input: { kind: 'url', url: 'http://10.0.0.5/' } } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({ code: 'URL_BLOCKED', message: "'http://10.0.0.5/' is a private address" });
  });

  it('an unexpected failure is generic for the client and logged for the operator', async () => {
    const engine = new FakeEngine();
    engine.failure = new TypeError('x is not a function (/srv/app/engine.ts:42)');
    const logged: string[] = [];
    const client = await connect(engine, (line) => logged.push(line));
    const result = await client.callTool({ name: 'get_run_report', arguments: { run_id: 'r' } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({ code: 'INTERNAL', message: 'internal error; the server log has the details' });
    expect(logged.join('\n')).toContain('x is not a function');
  });

  it('never shows a credential', async () => {
    vi.stubEnv('TEST_FAKE_API_KEY', 'sk-test-secret-value-123456');
    const engine = new FakeEngine();
    engine.failure = new EngineError('FETCH_FAILED', 'key sk-test-secret-value-123456 rejected');
    const client = await connect(engine);
    const result = await client.callTool({ name: 'list_locales' });
    expect(textOf(result)).toContain('[REDACTED]');
    expect(textOf(result)).not.toContain('sk-test-secret-value-123456');
  });

  it('invalid arguments are an isError result and never reach the engine', async () => {
    const engine = new FakeEngine();
    const client = await connect(engine);
    const result = await client.callTool({ name: 'run_pipeline', arguments: { input: { kind: 'url', url: 'nope' }, options: { pass_threshold: 150 } } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('pass_threshold');
    const missing = await client.callTool({ name: 'run_pipeline' });
    expect(missing.isError).toBe(true);
    expect(engine.calls).toEqual([]);
  });

  it('an unknown tool is an error result too', async () => {
    const client = await connect(new FakeEngine());
    const result = await client.callTool({ name: 'delete_everything' });
    expect(result.isError).toBe(true);
  });
});

describe('stdio hygiene', () => {
  it('building the server, describing the tools and calling them writes nothing to stdout', async () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const engine = new FakeEngine();
    const client = await connect(engine);
    describeMcpTools();
    await client.listTools();
    await client.callTool({ name: 'run_pipeline', arguments: { input: { kind: 'text', text: 'Hallo' } } });
    await client.callTool({ name: 'get_run_report', arguments: { run_id: 'r' } });
    engine.failure = new Error('boom');
    await client.callTool({ name: 'list_locales' });
    expect(stdout).not.toHaveBeenCalled();
  });

  it('over real stdio framing only JSON-RPC frames reach stdout', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const received: string[] = [];
    stdout.on('data', (chunk: Buffer) => received.push(chunk.toString('utf8')));
    const server = await startStdio(new FakeEngine(), { stdin, stdout });
    cleanups.push(() => server.close());
    const send = (message: object): void => void stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_locales', arguments: {} } });
    const frames = (): Array<{ jsonrpc: string; id: number; result: Record<string, unknown> }> =>
      received.join('').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
    await vi.waitFor(() => expect(frames()).toHaveLength(3));
    expect(frames().map((f) => [f.jsonrpc, f.id])).toEqual([['2.0', 1], ['2.0', 2], ['2.0', 3]]);
    expect((frames()[1]?.result['tools'] as unknown[]).length).toBe(7);
    expect(received.join('')).not.toMatch(/^(?!\{).+$/m); // every line starts a JSON object
  });

  it('routeConsoleToStderr sends console.log, info and debug to console.error and can be undone', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const original = console.log;
    const restore = routeConsoleToStderr();
    console.log('from a dependency');
    console.info('info');
    console.debug('debug');
    expect(error).toHaveBeenCalledTimes(3);
    expect(console.log).not.toBe(original);
    restore();
    expect(console.log).toBe(original);
  });
});

function rawRequest(url: string, opts: { method: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: target.hostname, port: target.port, path: target.pathname, method: opts.method, headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => void (body += chunk.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

describe('streamable HTTP', () => {
  async function serve(engine = new FakeEngine()): Promise<{ url: string; engine: FakeEngine }> {
    const running = await startHttp({ engine, port: 0, log: () => undefined });
    cleanups.push(() => running.close());
    return { url: running.url, engine };
  }

  it('answers an MCP client over HTTP on an ephemeral loopback port', async () => {
    const { url, engine } = await serve();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    cleanups.push(() => client.close());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    const locales = await client.callTool({ name: 'list_locales' });
    expect(ListLocalesResponseSchema.safeParse(locales.structuredContent).success).toBe(true);
    const run = await client.callTool({ name: 'run_pipeline', arguments: { input: { kind: 'text', text: 'Hallo' }, targets: ['de-CH'] } });
    expect(RunReportSchema.safeParse(run.structuredContent).success).toBe(true);
    expect(engine.lastCall).toEqual({ method: 'runPipeline', request: { input: { kind: 'text', text: 'Hallo', format: 'text' }, targets: ['de-CH'], options: {} } });
  });

  it('serves several clients at once (stateless)', async () => {
    const { url } = await serve();
    const clients = await Promise.all(
      [1, 2, 3].map(async () => {
        const client = new Client({ name: 'parallel', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(url)));
        cleanups.push(() => client.close());
        return client;
      }),
    );
    const lists = await Promise.all(clients.map((c) => c.listTools()));
    for (const list of lists) expect(list.tools).toHaveLength(7);
  });

  it('only POST on the MCP path', async () => {
    const { url } = await serve();
    const get = await rawRequest(url, { method: 'GET' });
    expect(get.status).toBe(405);
    expect(get.headers['allow']).toBe('POST');
    const other = await rawRequest(url.replace('/mcp', '/elsewhere'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(other.status).toBe(404);
    expect(JSON.parse(other.body).error.message).toContain('/mcp');
  });

  it('refuses a foreign Host or Origin (DNS rebinding)', async () => {
    const { url, engine } = await serve();
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const host = await rawRequest(url, { method: 'POST', headers: { ...headers, host: 'evil.example:8788' }, body });
    expect(host.status).toBe(403);
    const origin = await rawRequest(url, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body });
    expect(origin.status).toBe(403);
    expect(engine.calls).toEqual([]);
  });

  it('rejects a body that is not JSON-RPC without calling the engine', async () => {
    const { url, engine } = await serve();
    const res = await rawRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"nope":' });
    expect(res.status).toBe(400);
    expect(engine.calls).toEqual([]);
  });

  it('honours --path', async () => {
    const running = await startHttp({ engine: new FakeEngine(), port: 0, path: '/tools', log: () => undefined });
    cleanups.push(() => running.close());
    expect(running.url).toMatch(/\/tools$/);
    const client = new Client({ name: 'path-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools).toHaveLength(7);
  });
});

describe('bin arguments', () => {
  it('no flags means stdio', () => {
    expect(parseMcpArgs([])).toEqual({ mode: 'stdio' });
  });

  it('--http with optional host, port and path', () => {
    expect(parseMcpArgs(['--http'])).toEqual({ mode: 'http', listen: {} });
    expect(parseMcpArgs(['--http', '--port', '9000', '--host', '0.0.0.0', '--path', '/rpc'])).toEqual({ mode: 'http', listen: { port: 9000, host: '0.0.0.0', path: '/rpc' } });
  });

  it('--help', () => {
    expect(parseMcpArgs(['--help'])).toEqual({ mode: 'help' });
    expect(parseMcpArgs(['-h'])).toEqual({ mode: 'help' });
  });

  it.each([
    [['--port', '9000'], '--host, --port and --path only apply with --http'],
    [['--http', '--port', 'abc'], "--port expects a port number between 0 and 65535, got 'abc'"],
    [['--http', '--port', '70000'], '--port expects a port number'],
    [['--http', '--path', 'mcp'], "--path must start with '/'"],
    [['--stdio'], "Unknown option '--stdio'"],
  ])('%j is a usage error', (args, message) => {
    let error: unknown;
    try {
      parseMcpArgs(args);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ExitError);
    expect((error as ExitError).exitCode).toBe(2);
    expect((error as ExitError).message).toContain(message);
  });
});
