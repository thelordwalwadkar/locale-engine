import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  addUsage,
  BaseProvider,
  codeForStatus,
  costUsd,
  extraOption,
  httpError,
  reasoningEffort,
  resolveEndpoint,
  retryAfterFromHeaders,
  type ProviderFactoryArgs,
  type RawRequest,
  type RawResponse,
  type SamplingParam,
} from '../src/providers/base.js';
import { ProviderConfigSchema, ProviderError, type ProviderConfig, type StageParams } from '../src/schemas/index.js';
import { EngineError } from '../src/util/errors.js';

type Step = RawResponse | Error | ((req: RawRequest) => Promise<RawResponse>);

class ScriptedProvider extends BaseProvider {
  protected override readonly kind = 'custom' as const;
  protected override readonly schemaDialect = 'openai' as const;
  readonly requests: RawRequest[] = [];
  private readonly script: Step[];
  private readonly conflicts: boolean;

  constructor(args: ProviderFactoryArgs, script: Step[], opts: { secrets?: string[]; conflicts?: boolean } = {}) {
    super(args, opts.secrets ?? []);
    this.script = script;
    this.conflicts = opts.conflicts ?? false;
  }

  protected override conflictingParams(params: StageParams): readonly SamplingParam[] {
    return this.conflicts && params.temperature !== undefined && params.top_p !== undefined ? ['top_p'] : [];
  }

  protected override async rawComplete(req: RawRequest): Promise<RawResponse> {
    this.requests.push(req);
    const step = this.script.shift();
    if (step === undefined) throw new Error('script exhausted');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(req) : step;
  }
}

function providerConfig(model: Record<string, unknown> = {}, provider: Record<string, unknown> = {}): ProviderConfig {
  return ProviderConfigSchema.parse({
    kind: 'custom',
    module: 'x.mjs',
    default_model: 'm',
    max_retries: 2,
    timeout_ms: 5_000,
    models: { m: { id: 'model-x', structured_output: 'native', pricing: { input_per_mtok: 1, output_per_mtok: 2 }, pricing_verified: true, ...model } },
    ...provider,
  });
}

const sleeps: number[] = [];
function make(script: Step[], model: Record<string, unknown> = {}, provider: Record<string, unknown> = {}, opts: { secrets?: string[]; conflicts?: boolean } = {}) {
  sleeps.length = 0;
  const args: ProviderFactoryArgs = {
    name: 'scripted',
    config: providerConfig(model, provider),
    modelKey: 'm',
    env: {},
    sleep: async (ms) => void sleeps.push(ms),
  };
  return new ScriptedProvider(args, script, opts);
}

const reply = (text: string, extra: Partial<RawResponse> = {}): RawResponse => ({ text, usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'stop', ...extra });
const Schema = z.object({ results: z.array(z.object({ id: z.string(), n: z.number() })) });
const good = { results: [{ id: 'p-001', n: 1 }] };
const P: StageParams = { max_tokens: 256 };
const codes = (w: Array<{ code: string }>) => w.map((x) => x.code);

describe('sampling parameters', () => {
  it('drops unsupported parameters and warns only for the ones the caller set', async () => {
    const p = make([reply('hi')], { unsupported_params: ['temperature', 'seed'] });
    const r = await p.complete('sys', [{ role: 'user', content: 'x' }], { max_tokens: 100, temperature: 0.2, top_p: 0.9 });
    expect(p.requests[0]?.params).toEqual({ max_tokens: 100, top_p: 0.9 });
    expect(codes(r.warnings)).toEqual(['PARAM_UNSUPPORTED']);
    expect(r.warnings[0]?.message).toContain('temperature=0.2');
  });
  it('emits nothing when no unsupported parameter was requested', async () => {
    const p = make([reply('hi')], { unsupported_params: ['temperature', 'top_p', 'seed'] });
    const r = await p.complete('sys', [{ role: 'user', content: 'x' }], { max_tokens: 100 });
    expect(r.warnings).toEqual([]);
  });
  it('a 400 rejecting a sampling parameter drops it, retries and remembers it (no structured-output downgrade)', async () => {
    const p = make([httpError('scripted', 400, "Unsupported parameter: 'temperature' is not supported with this model."), reply(JSON.stringify(good)), reply(JSON.stringify(good))]);
    const r = await p.complete('s', [{ role: 'user', content: 'x' }], { max_tokens: 50, temperature: 0 }, Schema);
    expect(r.parsed).toEqual(good);
    expect(r.attempts).toBe(2);
    expect(p.requests[1]?.params).toEqual({ max_tokens: 50 });
    expect(p.requests[1]?.mode).toBe('native');
    expect(codes(r.warnings)).toEqual(['PARAM_UNSUPPORTED']);
    expect(p.info.structured_output).toBe('native');
    const again = await p.complete('s', [{ role: 'user', content: 'x' }], { max_tokens: 50, temperature: 0 }, Schema);
    expect(again.attempts).toBe(1);
    expect(p.requests[2]?.params).toEqual({ max_tokens: 50 });
    const q = make([httpError('scripted', 400, 'temperature and top_p cannot both be specified for this model'), reply('ok')]);
    await q.complete('s', [{ role: 'user', content: 'x' }], { max_tokens: 50, temperature: 0, top_p: 0.9 });
    expect(q.requests[1]?.params).toEqual({ max_tokens: 50, temperature: 0 });
  });
  it('drops a parameter that conflicts with another one (adapter hook)', async () => {
    const p = make([reply('hi')], {}, {}, { conflicts: true });
    const r = await p.complete('sys', [{ role: 'user', content: 'x' }], { max_tokens: 100, temperature: 0, top_p: 0.9 });
    expect(p.requests[0]?.params).toEqual({ max_tokens: 100, temperature: 0 });
    expect(r.warnings[0]?.message).toContain('top_p=0.9');
  });
});

describe('structured-output strategies', () => {
  it('native: sends the sanitized schema, leaves the system prompt alone', async () => {
    const p = make([reply(JSON.stringify(good))]);
    const r = await p.complete('SYSTEM', [{ role: 'user', content: 'x' }], P, Schema);
    const req = p.requests[0];
    expect(req?.mode).toBe('native');
    expect(req?.system).toBe('SYSTEM');
    expect(req?.jsonSchema?.['$schema']).toBeUndefined();
    expect(req?.jsonSchema?.['additionalProperties']).toBe(false);
    expect(r.parsed).toEqual(good);
    expect(r.attempts).toBe(1);
  });
  it('json_mode: schema appended to the system prompt, no native schema', async () => {
    const p = make([reply(JSON.stringify(good))], { structured_output: 'json_mode' });
    await p.complete('SYSTEM', [{ role: 'user', content: 'x' }], P, Schema);
    const req = p.requests[0];
    expect(req?.mode).toBe('json_mode');
    expect(req?.jsonSchema).toBeUndefined();
    expect(req?.system.startsWith('SYSTEM\n\nRespond with JSON only, matching this JSON Schema:')).toBe(true);
    expect(req?.system).toContain('"results"');
  });
  it('prompted: suffix mentions <final_answer>', async () => {
    const p = make([reply(JSON.stringify(good))], { structured_output: 'prompted' });
    await p.complete('SYSTEM', [{ role: 'user', content: 'x' }], P, Schema);
    expect(p.requests[0]?.mode).toBe('prompted');
    expect(p.requests[0]?.system).toContain('<final_answer>');
  });
  it('no schema: plain text, parsed null, no suffix', async () => {
    const p = make([reply('free text')]);
    const r = await p.complete('SYSTEM', [{ role: 'user', content: 'x' }], P);
    expect(r.parsed).toBeNull();
    expect(r.raw_text).toBe('free text');
    expect(p.requests[0]?.system).toBe('SYSTEM');
    expect(p.requests[0]?.mode).toBe('prompted');
  });
  it.each([
    ['<thinking>', `<thinking>I will answer {"not": "this"}</thinking>\n<final_answer>\n${JSON.stringify(good)}\n</final_answer>`],
    ['fenced', 'Here you go:\n```json\n' + JSON.stringify(good, null, 2) + '\n```'],
    ['prose', `The result is ${JSON.stringify(good)} as requested.`],
  ])('prompted parsing handles %s output', async (_label, text) => {
    const p = make([reply(text)], { structured_output: 'prompted' });
    const r = await p.complete('s', [{ role: 'user', content: 'x' }], P, Schema);
    expect(r.parsed).toEqual(good);
    expect(r.attempts).toBe(1);
    expect(codes(r.warnings)).not.toContain('SCHEMA_RETRY');
  });
});

describe('edge_broken_json (spec §5.2): one schema-repair retry', () => {
  it('garbage then valid JSON -> SCHEMA_RETRY, attempts 2, repair turn appended', async () => {
    const p = make([reply('Sorry, here is prose only.'), reply(JSON.stringify(good))], { structured_output: 'prompted' });
    const r = await p.complete('s', [{ role: 'user', content: 'translate' }], P, Schema);
    expect(r.parsed).toEqual(good);
    expect(r.attempts).toBe(2);
    expect(codes(r.warnings)).toContain('SCHEMA_RETRY');
    const second = p.requests[1]?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[1]?.content).toBe('Sorry, here is prose only.');
    expect(second[2]?.content).toContain('Return ONLY valid JSON matching the schema');
    expect(r.usage).toEqual({ input_tokens: 200, output_tokens: 100 });
    expect(r.cost_usd).toBeCloseTo((200 * 1 + 100 * 2) / 1e6, 12);
  });
  it('lists the Zod issues of a wrong-shape answer', async () => {
    const p = make([reply(JSON.stringify({ results: [{ id: 'p-001', n: 'one' }] })), reply(JSON.stringify(good))]);
    await p.complete('s', [{ role: 'user', content: 'x' }], P, Schema);
    expect(p.requests[1]?.messages[2]?.content).toContain('results.0.n');
  });
  it('replaces an empty answer with a marker (empty assistant turns are rejected by some APIs)', async () => {
    const p = make([reply('   '), reply(JSON.stringify(good))]);
    await p.complete('s', [{ role: 'user', content: 'x' }], P, Schema);
    expect(p.requests[1]?.messages[1]?.content).toBe('(empty response)');
  });
  it('garbage twice -> SCHEMA_INVALID with the raw text', async () => {
    const p = make([reply('nope'), reply('still nope')]);
    const err = await p.complete('s', [{ role: 'user', content: 'x' }], P, Schema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('SCHEMA_INVALID');
    expect((err as ProviderError).raw_text).toBe('still nope');
    expect(p.requests).toHaveLength(2);
  });
  it('truncated twice -> TRUNCATED (the orchestrator can split the batch); a valid truncated answer only warns', async () => {
    const cut = reply('{"results": [{"id": "p-0', { truncated: true, stop_reason: 'max_tokens' });
    const p = make([cut, { ...cut }]);
    const err = await p.complete('s', [{ role: 'user', content: 'x' }], P, Schema).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('TRUNCATED');
    expect(p.requests[1]?.messages[2]?.content).toContain('cut off');
    const q = make([reply(JSON.stringify(good), { truncated: true, stop_reason: 'max_tokens' })]);
    const r = await q.complete('s', [{ role: 'user', content: 'x' }], P, Schema);
    expect(codes(r.warnings)).toEqual(['TRUNCATED_OUTPUT']);
  });
});

describe('native-mode fallback', () => {
  const rejection = () => httpError('scripted', 400, 'response_format json_schema is not supported with this model');
  it('a 4xx about structured output -> retry once in prompted mode, remembered for the instance', async () => {
    const p = make([rejection(), reply(JSON.stringify(good)), reply(JSON.stringify(good))]);
    const r = await p.complete('SYS', [{ role: 'user', content: 'x' }], P, Schema);
    expect(r.parsed).toEqual(good);
    expect(r.attempts).toBe(2);
    expect(codes(r.warnings)).toContain('NATIVE_JSON_UNAVAILABLE');
    expect(p.requests.map((q) => q.mode)).toEqual(['native', 'prompted']);
    expect(p.requests[1]?.jsonSchema).toBeUndefined();
    expect(p.requests[1]?.system).toContain('Respond with JSON only');
    expect(p.info.structured_output).toBe('prompted');
    const again = await p.complete('SYS', [{ role: 'user', content: 'x' }], P, Schema);
    expect(again.attempts).toBe(1);
    expect(p.requests[2]?.mode).toBe('prompted');
    expect(codes(again.warnings)).not.toContain('NATIVE_JSON_UNAVAILABLE');
  });
  it('json_mode is downgraded the same way', async () => {
    const p = make([httpError('scripted', 400, 'Invalid response_format type json_object'), reply(JSON.stringify(good))], { structured_output: 'json_mode' });
    const r = await p.complete('s', [{ role: 'user', content: 'x' }], P, Schema);
    expect(codes(r.warnings)).toContain('NATIVE_JSON_UNAVAILABLE');
    expect(p.info.structured_output).toBe('prompted');
  });
  it('other 4xx errors are not treated as a structured-output rejection', async () => {
    const p = make([httpError('scripted', 400, 'messages: roles must alternate')]);
    const err = await p.complete('s', [{ role: 'user', content: 'x' }], P, Schema).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('BAD_REQUEST');
    expect(p.info.structured_output).toBe('native');
  });
  it('a schema the dialect cannot express goes prompted for that call only', async () => {
    const p = make([reply(JSON.stringify({ tags: { a: 1 } }))]);
    const r = await p.complete('s', [{ role: 'user', content: 'x' }], P, z.object({ tags: z.record(z.string(), z.number()) }));
    expect(r.parsed).toEqual({ tags: { a: 1 } });
    expect(p.requests[0]?.mode).toBe('prompted');
    expect(codes(r.warnings)).toContain('NATIVE_JSON_UNAVAILABLE');
    expect(p.info.structured_output).toBe('native');
  });
});

describe('cost', () => {
  it('prices input, cached input and output per 1M tokens', () => {
    const pricing = { input_per_mtok: 2, output_per_mtok: 10, cached_input_per_mtok: 0.2 };
    expect(costUsd({ input_tokens: 1000, output_tokens: 500, cached_input_tokens: 2000 }, pricing)).toBeCloseTo(0.0074, 12);
    // no cached price: cache reads are billed at the input price (a ceiling never under-counts)
    expect(costUsd({ input_tokens: 0, output_tokens: 0, cached_input_tokens: 1_000_000 }, { input_per_mtok: 3, output_per_mtok: 1 })).toBeCloseTo(3, 12);
    expect(costUsd({ input_tokens: 1, output_tokens: 1 }, undefined)).toBeNull();
    expect(addUsage({ input_tokens: 1, output_tokens: 2 }, { input_tokens: 3, output_tokens: 4, cached_input_tokens: 5 })).toEqual({ input_tokens: 4, output_tokens: 6, cached_input_tokens: 5 });
  });
  it('unknown pricing -> cost null + PRICING_UNKNOWN; unverified -> PRICING_UNVERIFIED', async () => {
    const unknown = await make([reply('x')], { pricing: undefined, pricing_verified: false }).complete('s', [{ role: 'user', content: 'x' }], P);
    expect(unknown.cost_usd).toBeNull();
    expect(codes(unknown.warnings)).toEqual(['PRICING_UNKNOWN']);
    const unverified = await make([reply('x')], { pricing_verified: false }).complete('s', [{ role: 'user', content: 'x' }], P);
    expect(unverified.cost_usd).toBeCloseTo((100 + 100) / 1e6, 12);
    expect(codes(unverified.warnings)).toEqual(['PRICING_UNVERIFIED']);
  });
});

describe('transport retries', () => {
  it('retries RATE_LIMIT / SERVER, honours Retry-After, counts every attempt', async () => {
    const p = make([httpError('scripted', 429, 'slow down', { retryAfterMs: 3000 }), httpError('scripted', 503, 'overloaded'), reply(JSON.stringify(good))]);
    const r = await p.complete('s', [{ role: 'user', content: 'x' }], P, Schema);
    expect(r.parsed).toEqual(good);
    expect(r.attempts).toBe(3);
    expect(sleeps[0]).toBe(3000);
    expect(sleeps[1]).toBeLessThanOrEqual(2000);
    expect(r.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
  });
  it('gives up after max_retries and rethrows the last error', async () => {
    const p = make([httpError('scripted', 500, 'a'), httpError('scripted', 500, 'b')], {}, { max_retries: 1 });
    const err = await p.complete('s', [{ role: 'user', content: 'x' }], P).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('SERVER');
    expect(p.requests).toHaveLength(2);
  });
  it('does not retry AUTH / BAD_REQUEST, nor a Retry-After longer than a minute', async () => {
    const auth = make([httpError('scripted', 401, 'bad key')]);
    expect(((await auth.complete('s', [{ role: 'user', content: 'x' }], P).catch((e: unknown) => e)) as ProviderError).code).toBe('AUTH');
    expect(auth.requests).toHaveLength(1);
    const long = make([httpError('scripted', 429, 'quota', { retryAfterMs: 120_000 })]);
    expect(((await long.complete('s', [{ role: 'user', content: 'x' }], P).catch((e: unknown) => e)) as ProviderError).code).toBe('RATE_LIMIT');
    expect(long.requests).toHaveLength(1);
  });
  it('maps an attempt that outlives timeout_ms to TIMEOUT and wraps unknown errors', async () => {
    const hang = (req: RawRequest) =>
      new Promise<RawResponse>((_resolve, reject) => req.signal?.addEventListener('abort', () => reject(new Error('socket closed'))));
    const p = make([hang], {}, { timeout_ms: 20, max_retries: 0 });
    const err = await p.complete('s', [{ role: 'user', content: 'x' }], P).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('TIMEOUT');
    const q = make([new Error('weird')], {}, { max_retries: 0 });
    const err2 = await q.complete('s', [{ role: 'user', content: 'x' }], P).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(ProviderError);
    expect((err2 as ProviderError).code).toBe('UNKNOWN');
  });
  it('never returns a credential in an error message', async () => {
    const p = make([httpError('scripted', 401, 'invalid x-api-key sk-test-SECRET-123')], {}, {}, { secrets: ['sk-test-SECRET-123'] });
    const err = (await p.complete('s', [{ role: 'user', content: 'x' }], P).catch((e: unknown) => e)) as ProviderError;
    expect(err.message).not.toContain('sk-test-SECRET-123');
    expect(err.message).toContain('[REDACTED]');
  });
});

describe('helpers', () => {
  it('maps HTTP status to error codes', () => {
    expect([401, 403, 408, 429, 400, 404, 422, 500, 529, undefined].map(codeForStatus)).toEqual([
      'AUTH', 'AUTH', 'TIMEOUT', 'RATE_LIMIT', 'BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST', 'SERVER', 'SERVER', 'UNKNOWN',
    ]);
    expect(httpError('p', 503, 'x').retryable).toBe(true);
    expect(httpError('p', 400, 'x').retryable).toBe(false);
  });
  it('reads Retry-After headers', () => {
    expect(retryAfterFromHeaders(new Headers({ 'retry-after-ms': '1500' }))).toBe(1500);
    expect(retryAfterFromHeaders(new Headers({ 'retry-after': '2' }))).toBe(2000);
    expect(retryAfterFromHeaders(new Headers())).toBeUndefined();
  });
  it('resolves credentials per kind; base_url_env overrides base_url', () => {
    const cfg = (o: Record<string, unknown>) => ProviderConfigSchema.parse({ default_model: 'm', models: { m: { id: 'x' } }, ...o });
    expect(resolveEndpoint(cfg({ kind: 'anthropic', api_key_env: 'K' }), {}).missing).toEqual(['K']);
    expect(resolveEndpoint(cfg({ kind: 'anthropic', api_key_env: 'K' }), { K: ' v ' }).apiKey).toBe('v');
    expect(resolveEndpoint(cfg({ kind: 'ollama', base_url: 'http://a', base_url_env: 'H' }), { H: 'http://b' })).toEqual({ baseUrl: 'http://b', missing: [] });
    expect(resolveEndpoint(cfg({ kind: 'openai_compatible', api_key_env: 'K' }), { K: 'v' }).missing).toEqual(['base_url']);
    expect(resolveEndpoint(cfg({ kind: 'openai_compatible', base_url: 'http://local' }), {}).missing).toEqual([]);
    expect(resolveEndpoint(cfg({ kind: 'mock' }), {}).missing).toEqual([]);
  });
  it('validates adapter knobs in `extra`', () => {
    const cfg = providerConfig({}, { extra: { reasoning_effort: { m: 'low' }, bad: 3 } });
    expect(reasoningEffort('p', cfg, 'm', ['low', 'high'])).toBe('low');
    expect(reasoningEffort('p', cfg, 'other', ['low', 'high'])).toBeUndefined();
    expect(() => reasoningEffort('p', providerConfig({}, { extra: { reasoning_effort: { m: 'huge' } } }), 'm', ['low'])).toThrow(EngineError);
    expect(() => extraOption('p', cfg, 'bad', z.string())).toThrow(/providers\.p\.extra\.bad/);
  });
});

describe('spend of failed calls (feeds the cost ceiling)', () => {
  it('a call that fails after the repair retry carries its usage, cost and attempts', async () => {
    const p = make([reply('not json'), reply('still not json')]);
    const e = (await p.complete('s', [{ role: 'user', content: 'x' }], P, Schema).catch((x: unknown) => x)) as ProviderError;
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.code).toBe('SCHEMA_INVALID');
    expect(e.attempts).toBe(2);
    expect(e.usage).toEqual({ input_tokens: 200, output_tokens: 100 });
    expect(e.cost_usd).toBeCloseTo((200 * 1 + 100 * 2) / 1e6, 10);
  });
  it('a call that never reached the model carries no spend', async () => {
    const p = make([httpError('scripted', 401, 'bad key')]);
    const e = (await p.complete('s', [{ role: 'user', content: 'x' }], P).catch((x: unknown) => x)) as ProviderError;
    expect(e.code).toBe('AUTH');
    expect(e.usage).toBeUndefined();
  });
});
