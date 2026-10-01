/** R6 (interface parity): same capabilities, identical schemas, same validation, same request reaching the engine. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApi } from '../src/interfaces/api.js';
import { ALL_CAPABILITIES, CAPABILITIES } from '../src/interfaces/capabilities.js';
import { buildProgram, runProgram } from '../src/interfaces/cli.js';
import { PIPELINE_OPTION_FLAGS } from '../src/interfaces/cli-flags.js';
import { buildMcpServer } from '../src/interfaces/mcp_server.js';
import {
  CompareRequestSchema,
  GetRunReportRequestSchema,
  ListLocalesResponseSchema,
  PipelineOptionsSchema,
  PipelineRequestSchema,
  RunReportSchema,
  ValidateRequestSchema,
  CompareReportSchema,
} from '../src/schemas/index.js';
import { FakeEngine } from './fixtures/interfaces/fake-engine.js';

type Json = Record<string, unknown>;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function mcpClient(engine: FakeEngine): Promise<Client> {
  const server = buildMcpServer(engine, { log: () => undefined });
  const client = new Client({ name: 'parity', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function restApi(engine: FakeEngine): Promise<ReturnType<typeof buildApi>> {
  const app = buildApi(engine);
  closers.push(() => app.close());
  return app;
}

async function cliRun(engine: FakeEngine, args: string[]): Promise<{ code: number; stderr: string }> {
  let stderr = '';
  const deps = { getEngine: async () => engine, stdout: () => undefined, stderr: (t: string) => void (stderr += t) };
  const code = await runProgram(buildProgram(deps), args, deps);
  return { code, stderr };
}

/** A schema node of the OpenAPI document, following one `$ref` into components. */
const resolve = (doc: Json, node: unknown): Json => {
  const ref = (node as { $ref?: string }).$ref;
  return ref ? ((doc['components'] as { schemas: Record<string, Json> }).schemas[ref.split('/').pop() as string] as Json) : (node as Json);
};

/** The JSON schema node of an OpenAPI request body or response. */
const schemaOf = (holder: unknown): Json => (holder as { content: Record<string, { schema: Json }> }).content['application/json']?.schema as Json;

const REST_ROUTE: Record<string, [method: string, path: string]> = {
  run_pipeline: ['post', '/v1/pipeline'],
  translate_content: ['post', '/v1/translate'],
  localize_content: ['post', '/v1/localize'],
  validate_content: ['post', '/v1/validate'],
  compare_models: ['post', '/v1/compare'],
  list_locales: ['get', '/v1/locales'],
  get_run_report: ['get', '/v1/runs/{run_id}'],
};

describe('identical JSON Schemas across REST, MCP and the schema the CLI validates with', () => {
  const direct = (schema: z.ZodType, io: 'input' | 'output'): Json => z.toJSONSchema(schema, { target: 'draft-7', io });

  it('every capability uses the shared schema objects', () => {
    expect(CAPABILITIES.run_pipeline.input).toBe(PipelineRequestSchema);
    expect(CAPABILITIES.translate_content.input).toBe(PipelineRequestSchema);
    expect(CAPABILITIES.localize_content.input).toBe(PipelineRequestSchema);
    expect(CAPABILITIES.validate_content.input).toBe(ValidateRequestSchema);
    expect(CAPABILITIES.compare_models.input).toBe(CompareRequestSchema);
    expect(CAPABILITIES.get_run_report.input).toBe(GetRunReportRequestSchema);
    expect(CAPABILITIES.list_locales.input).toBeUndefined();
    for (const name of ['run_pipeline', 'translate_content', 'localize_content', 'validate_content', 'get_run_report'] as const) {
      expect(CAPABILITIES[name].output).toBe(RunReportSchema);
    }
    expect(CAPABILITIES.compare_models.output).toBe(CompareReportSchema);
    expect(CAPABILITIES.list_locales.output).toBe(ListLocalesResponseSchema);
  });

  it('request schemas: REST body == MCP inputSchema == z.toJSONSchema(schema)', async () => {
    const app = await restApi(new FakeEngine());
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Json;
    const { tools } = await (await mcpClient(new FakeEngine())).listTools();
    for (const [name, [method, path]] of Object.entries(REST_ROUTE)) {
      const cap = ALL_CAPABILITIES.find((c) => c.name === name);
      const mcp = tools.find((t) => t.name === name);
      if (!cap?.input || method !== 'post') continue;
      const operation = (doc['paths'] as Record<string, Record<string, Json>>)[path]?.[method] as Json;
      const body = resolve(doc, schemaOf(operation['requestBody']));
      expect(body, `${name} REST vs direct`).toEqual(direct(cap.input, 'input'));
      expect(mcp?.inputSchema, `${name} MCP vs direct`).toEqual(direct(cap.input, 'input'));
      expect(mcp?.inputSchema, `${name} MCP vs REST`).toEqual(body);
    }
  });

  it('result schemas: REST 200 == MCP outputSchema == z.toJSONSchema(schema)', async () => {
    const app = await restApi(new FakeEngine());
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Json;
    const { tools } = await (await mcpClient(new FakeEngine())).listTools();
    for (const [name, [method, path]] of Object.entries(REST_ROUTE)) {
      const cap = ALL_CAPABILITIES.find((c) => c.name === name);
      const mcp = tools.find((t) => t.name === name);
      const operation = (doc['paths'] as Record<string, Record<string, Json>>)[path]?.[method] as Json;
      const rest = resolve(doc, schemaOf((operation['responses'] as Json)['200']));
      expect(rest, `${name} REST vs direct`).toEqual(direct(cap?.output as z.ZodType, 'output'));
      expect(mcp?.outputSchema, `${name} MCP vs REST`).toEqual(rest);
    }
  });

  it('compare_models has the same schemas over MCP as the shared ones', async () => {
    const { tools } = await (await mcpClient(new FakeEngine())).listTools();
    const compare = tools.find((t) => t.name === 'compare_models');
    expect(compare?.inputSchema).toEqual(direct(CompareRequestSchema, 'input'));
    expect(compare?.outputSchema).toEqual(direct(CompareReportSchema, 'output'));
  });

  it('GET /v1/runs/{run_id} parameters == the properties of the MCP inputSchema', async () => {
    const app = await restApi(new FakeEngine());
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Json;
    const { tools } = await (await mcpClient(new FakeEngine())).listTools();
    const input = tools.find((t) => t.name === 'get_run_report')?.inputSchema as { properties: Record<string, Json>; required: string[] };
    const parameters = ((doc['paths'] as Json)['/v1/runs/{run_id}'] as Json)['get'] as { parameters: Array<{ name: string; required: boolean; schema: Json }> };
    expect(Object.fromEntries(parameters.parameters.map((p) => [p.name, p.schema]))).toEqual(input.properties);
    expect(parameters.parameters.filter((p) => p.required).map((p) => p.name)).toEqual(input.required);
  });

  it('list_locales takes no arguments anywhere', async () => {
    const { tools } = await (await mcpClient(new FakeEngine())).listTools();
    expect(tools.find((t) => t.name === 'list_locales')?.inputSchema).toEqual({ type: 'object', properties: {} });
    const app = await restApi(new FakeEngine());
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as Json;
    const get = ((doc['paths'] as Json)['/v1/locales'] as Json)['get'] as Json;
    expect(get['parameters']).toBeUndefined();
    expect(get['requestBody']).toBeUndefined();
  });
});

describe('the same capabilities', () => {
  it('every MCP tool has a REST route and the other way round (seven capabilities, three interfaces)', async () => {
    const { tools } = await (await mcpClient(new FakeEngine())).listTools();
    const toolNames = tools.map((t) => t.name);
    expect(Object.keys(REST_ROUTE).every((name) => toolNames.includes(name))).toBe(true);
    expect(toolNames.filter((name) => !(name in REST_ROUTE))).toEqual([]);
  });

  it('every CLI command but providers test is an MCP tool', () => {
    const program = buildProgram({ getEngine: async () => new FakeEngine(), stdout: () => undefined, stderr: () => undefined });
    expect(program.commands.map((c) => c.name())).toEqual(['run', 'translate', 'localize', 'validate', 'compare', 'locales', 'providers']);
    const byCommand: Record<string, string> = { run: 'run_pipeline', translate: 'translate_content', localize: 'localize_content', validate: 'validate_content', compare: 'compare_models', locales: 'list_locales' };
    for (const tool of Object.values(byCommand)) expect(ALL_CAPABILITIES.map((c) => c.name)).toContain(tool);
  });

  it('every PipelineOptions field has a CLI flag', () => {
    expect(Object.keys(PIPELINE_OPTION_FLAGS).sort()).toEqual(Object.keys(PipelineOptionsSchema.shape).sort());
  });
});

describe('the same request reaches the engine', () => {
  async function viaAll(args: { cli: string[]; tool: string; method: 'post'; path: string; body: Json; engineMethod: string }): Promise<unknown[]> {
    const requests: unknown[] = [];
    const fromCli = new FakeEngine();
    expect((await cliRun(fromCli, args.cli)).code).toBe(0);
    requests.push(fromCli.lastCall?.request);

    const fromRest = new FakeEngine();
    const res = await (await restApi(fromRest)).inject({ method: 'POST', url: args.path, payload: args.body });
    expect(res.statusCode).toBe(200);
    requests.push(fromRest.lastCall?.request);

    const fromMcp = new FakeEngine();
    const result = await (await mcpClient(fromMcp)).callTool({ name: args.tool, arguments: args.body });
    expect(result.isError).toBeFalsy();
    requests.push(fromMcp.lastCall?.request);

    for (const engine of [fromCli, fromRest, fromMcp]) expect(engine.lastCall?.method).toBe(args.engineMethod);
    return requests;
  }

  it('run_pipeline', async () => {
    const [cli, rest, mcp] = await viaAll({
      cli: ['run', '--text', 'Hallo wereld', '--targets', 'de-CH,it-IT', '--no-repair', '--pass-threshold', '80', '--provider', 'translation=openai:gpt'],
      tool: 'run_pipeline',
      method: 'post',
      path: '/v1/pipeline',
      body: { input: { kind: 'text', text: 'Hallo wereld' }, targets: ['de-CH', 'it-IT'], options: { repair: false, pass_threshold: 80, providers: { translation: 'openai:gpt' } } },
      engineMethod: 'runPipeline',
    });
    expect(rest).toEqual(cli);
    expect(mcp).toEqual(cli);
    expect(cli).toEqual({
      input: { kind: 'text', text: 'Hallo wereld', format: 'text' },
      targets: ['de-CH', 'it-IT'],
      options: { repair: false, pass_threshold: 80, providers: { translation: 'openai:gpt' } },
    });
  });

  it('translate_content', async () => {
    const [cli, rest, mcp] = await viaAll({
      cli: ['translate', '--input', 'https://example.nl/pompen'],
      tool: 'translate_content',
      method: 'post',
      path: '/v1/translate',
      body: { input: { kind: 'url', url: 'https://example.nl/pompen' } },
      engineMethod: 'translateContent',
    });
    expect(rest).toEqual(cli);
    expect(mcp).toEqual(cli);
  });

  it('localize_content', async () => {
    const [cli, rest, mcp] = await viaAll({
      cli: ['localize', '--input', 'out/run-1/de-CH/page.json', '--targets', 'de-CH'],
      tool: 'localize_content',
      method: 'post',
      path: '/v1/localize',
      body: { input: { kind: 'page_json', path: 'out/run-1/de-CH/page.json' }, targets: ['de-CH'] },
      engineMethod: 'localizeContent',
    });
    expect(rest).toEqual(cli);
    expect(mcp).toEqual(cli);
  });

  it('validate_content', async () => {
    const [cli, rest, mcp] = await viaAll({
      cli: ['validate', '--source', 'Vraag een offerte aan', '--target', 'Fordern Sie ein Angebot an', '--target-locale', 'de-CH', '--repair'],
      tool: 'validate_content',
      method: 'post',
      path: '/v1/validate',
      body: { input: { kind: 'pair', source_text: 'Vraag een offerte aan', target_text: 'Fordern Sie ein Angebot an', target_locale: 'de-CH' }, options: { repair: true } },
      engineMethod: 'validateContent',
    });
    expect(rest).toEqual(cli);
    expect(mcp).toEqual(cli);
  });

  it('compare_models', async () => {
    const [cli, rest, mcp] = await viaAll({
      cli: ['compare', '--input', 'x.html', '--targets', 'de-CH', '--providers', 'anthropic,openai', '--judge', 'anthropic'],
      tool: 'compare_models',
      method: 'post',
      path: '/v1/compare',
      body: { input: { kind: 'file', path: 'x.html' }, targets: ['de-CH'], providers: ['anthropic', 'openai'], judge_provider: 'anthropic' },
      engineMethod: 'compareModels',
    });
    expect(rest).toEqual(cli);
    expect(mcp).toEqual(cli);
  });
});

describe('the same validation', () => {
  it('an out-of-range option is rejected by all three interfaces for the same reason', async () => {
    const engine = new FakeEngine();
    const rest = await (await restApi(engine)).inject({ method: 'POST', url: '/v1/pipeline', payload: { input: { kind: 'text', text: 'x' }, options: { pass_threshold: 150 } } });
    expect(rest.statusCode).toBe(400);
    expect(rest.json().error.issues).toEqual([{ path: 'options.pass_threshold', message: 'Too big: expected number to be <=100' }]);

    const mcp = await (await mcpClient(engine)).callTool({ name: 'run_pipeline', arguments: { input: { kind: 'text', text: 'x' }, options: { pass_threshold: 150 } } });
    expect(mcp.isError).toBe(true);
    expect(JSON.stringify(mcp.content)).toContain('Too big: expected number to be <=100');

    const cli = await cliRun(engine, ['run', '--text', 'x', '--pass-threshold', '150']);
    expect(cli.code).toBe(2);
    expect(cli.stderr).toContain('--pass-threshold: Too big: expected number to be <=100');
    expect(engine.calls).toEqual([]);
  });

  it('an unknown locale is rejected by all three (REST and CLI also name the valid ones)', async () => {
    const engine = new FakeEngine();
    const rest = await (await restApi(engine)).inject({ method: 'POST', url: '/v1/pipeline', payload: { input: { kind: 'text', text: 'x' }, targets: ['de-XX'] } });
    expect(rest.json().error.issues[0].message).toContain('"de-CH"');
    const mcp = await (await mcpClient(engine)).callTool({ name: 'run_pipeline', arguments: { input: { kind: 'text', text: 'x' }, targets: ['de-XX'] } });
    expect(mcp.isError).toBe(true);
    expect(JSON.stringify(mcp.content)).toContain('at targets'); // the SDK reports a failed union without its alternatives
    const cli = await cliRun(engine, ['run', '--text', 'x', '--targets', 'de-XX']);
    expect(cli.stderr).toContain('de-CH');
    expect(engine.calls).toEqual([]);
  });
});
