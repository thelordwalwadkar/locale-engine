/**
 * The real SDK clients (and Ollama's REST API) against local HTTP servers: proves the adapters work with genuine SDK
 * response objects and error classes, send the key only in headers, and never retry inside the SDK. Fully offline.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createProvider as createAnthropic } from '../src/providers/anthropic.js';
import { createProvider as createGoogle } from '../src/providers/google.js';
import { createProvider as createOllama } from '../src/providers/ollama.js';
import { createProvider as createOpenAI } from '../src/providers/openai.js';
import { createProvider as createCompatible } from '../src/providers/openai_compatible.js';
import { ProviderConfigSchema, type ProviderError } from '../src/schemas/index.js';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}
interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** Serves `replies` in order (the last one repeats) and records every request. */
async function serve(replies: Reply[]): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      const r = replies[Math.min(seen.length - 1, replies.length - 1)] ?? { status: 500, body: {} };
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
      res.end(JSON.stringify(r.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const KEY = 'sk-local-test-key-123';
const env = { TEST_KEY: KEY };
const Ok = z.object({ ok: z.boolean() });
const P = { max_tokens: 64 };
const cfg = (kind: string, base_url: string, model: Record<string, unknown> = {}, provider: Record<string, unknown> = {}) =>
  ProviderConfigSchema.parse({
    kind,
    api_key_env: 'TEST_KEY',
    base_url,
    default_model: 'm',
    max_retries: 0,
    timeout_ms: 5000,
    models: { m: { id: 'model-1', structured_output: 'native', pricing: { input_per_mtok: 1, output_per_mtok: 1 }, pricing_verified: true, ...model } },
    ...provider,
  });
const fail = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e as ProviderError);

describe('@anthropic-ai/sdk', () => {
  const message = (text: string) => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'model-1',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });

  it('native request through the SDK; the key travels in x-api-key only', async () => {
    const s = await serve([{ body: message('{"ok":true}') }]);
    const p = createAnthropic({ name: 'anthropic', config: cfg('anthropic', s.url), modelKey: 'm', env });
    const r = await p.complete('SYS', [{ role: 'user', content: 'hi' }], P, Ok);
    expect(r.parsed).toEqual({ ok: true });
    expect(r.usage).toEqual({ input_tokens: 11, output_tokens: 4 });
    expect(s.seen[0]?.url).toBe('/v1/messages');
    expect(s.seen[0]?.headers['x-api-key']).toBe(KEY);
    expect(s.seen[0]?.headers['authorization']).toBeUndefined();
    expect(s.seen[0]?.body).toMatchObject({ model: 'model-1', system: 'SYS', output_config: { format: { type: 'json_schema' } } });
  });
  it('429 + retry-after -> RATE_LIMIT with the hint; the SDK does not retry on its own', async () => {
    const s = await serve([{ status: 429, headers: { 'retry-after': '7' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Too many requests' } } }]);
    const p = createAnthropic({ name: 'anthropic', config: cfg('anthropic', s.url), modelKey: 'm', env });
    const e = await fail(p.complete('SYS', [{ role: 'user', content: 'hi' }], P, Ok));
    expect(e.code).toBe('RATE_LIMIT');
    expect((e as ProviderError & { retryAfterMs?: number }).retryAfterMs).toBe(7000);
    expect(e.message).not.toContain(KEY);
    expect(s.seen).toHaveLength(1);
  });
  it('a 400 rejecting the output format downgrades to prompted', async () => {
    const s = await serve([
      { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'output_config.format.schema: unsupported keyword' } } },
      { body: message('<final_answer>{"ok":true}</final_answer>') },
    ]);
    const p = createAnthropic({ name: 'anthropic', config: cfg('anthropic', s.url), modelKey: 'm', env });
    const r = await p.complete('SYS', [{ role: 'user', content: 'hi' }], P, Ok);
    expect(r.parsed).toEqual({ ok: true });
    expect(r.warnings.map((w) => w.code)).toContain('NATIVE_JSON_UNAVAILABLE');
    expect(s.seen[1]?.body['output_config']).toBeUndefined();
    expect(String(s.seen[1]?.body['system'])).toContain('Respond with JSON only');
  });
});

describe('openai SDK (Responses and Chat Completions)', () => {
  it('Responses API: strict json_schema, store false, cached tokens', async () => {
    const s = await serve([
      {
        body: {
          id: 'resp_1',
          object: 'response',
          created_at: 0,
          status: 'completed',
          model: 'model-1',
          output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }] }],
          usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 }, output_tokens: 6, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 36 },
          error: null,
          incomplete_details: null,
        },
      },
    ]);
    const p = createOpenAI({ name: 'openai', config: cfg('openai', `${s.url}/v1`), modelKey: 'm', env });
    const r = await p.complete('SYS', [{ role: 'user', content: 'hi' }], P, Ok);
    expect(r.parsed).toEqual({ ok: true });
    expect(r.usage).toEqual({ input_tokens: 20, output_tokens: 6, cached_input_tokens: 10 });
    expect(s.seen[0]?.url).toBe('/v1/responses');
    expect(s.seen[0]?.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(s.seen[0]?.headers['openai-organization']).toBeUndefined();
    expect(s.seen[0]?.body).toMatchObject({ store: false, instructions: 'SYS', text: { format: { type: 'json_schema', strict: true, name: 'response' } } });
  });
  it('401 -> AUTH, not retried', async () => {
    const s = await serve([{ status: 401, body: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } } }]);
    const p = createOpenAI({ name: 'openai', config: cfg('openai', `${s.url}/v1`, {}, { max_retries: 3 }), modelKey: 'm', env });
    expect((await fail(p.complete('SYS', [{ role: 'user', content: 'hi' }], P, Ok))).code).toBe('AUTH');
    expect(s.seen).toHaveLength(1);
  });
  it('Chat Completions (openai_compatible, json_mode): schema in the prompt, json_object, 503 retried by base.ts', async () => {
    const completion = {
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: 'deepseek-x',
      choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: '{"ok":true}', refusal: null } }],
      usage: { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43, prompt_cache_hit_tokens: 25 },
    };
    const s = await serve([{ status: 503, headers: { 'retry-after': '0' }, body: { error: { message: 'busy' } } }, { body: completion }]);
    const p = createCompatible({
      name: 'deepseek',
      config: cfg('openai_compatible', s.url, { structured_output: 'json_mode' }, { max_retries: 1 }),
      modelKey: 'm',
      env,
      sleep: async () => {},
    });
    const r = await p.complete('SYS', [{ role: 'user', content: 'hi' }], { max_tokens: 64, seed: 1 }, Ok);
    expect(r.parsed).toEqual({ ok: true });
    expect(r.attempts).toBe(2);
    expect(r.usage).toEqual({ input_tokens: 15, output_tokens: 3, cached_input_tokens: 25 });
    expect(s.seen[1]?.url).toBe('/chat/completions');
    const body = s.seen[1]?.body ?? {};
    expect(body['response_format']).toEqual({ type: 'json_object' });
    expect(body['seed']).toBe(1);
    const first = (body['messages'] as Array<{ role: string; content: string }>)[0];
    expect(first?.role).toBe('system');
    expect(first?.content).toContain('Respond with JSON only, matching this JSON Schema');
  });
});

describe('@google/genai', () => {
  it('generateContent with responseJsonSchema; key in x-goog-api-key, never in the URL', async () => {
    const s = await serve([
      {
        body: {
          candidates: [{ content: { role: 'model', parts: [{ text: 'thinking', thought: true }, { text: '{"ok":true}' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 7, totalTokenCount: 32 },
          modelVersion: 'model-1',
        },
      },
    ]);
    const p = createGoogle({ name: 'google', config: cfg('google', s.url), modelKey: 'm', env });
    const r = await p.complete('SYS', [{ role: 'user', content: 'hi' }], P, Ok);
    expect(r.parsed).toEqual({ ok: true });
    expect(r.usage).toEqual({ input_tokens: 20, output_tokens: 12 });
    expect(s.seen[0]?.url).toMatch(/\/models\/model-1:generateContent$/);
    expect(s.seen[0]?.url).not.toContain(KEY);
    expect(s.seen[0]?.headers['x-goog-api-key']).toBe(KEY);
    expect(s.seen[0]?.body).toMatchObject({ generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 64 } });
  });
  it('429 with RetryInfo -> RATE_LIMIT carrying the delay; the SDK does not retry', async () => {
    const s = await serve([
      { status: 429, body: { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }] } } },
    ]);
    const p = createGoogle({ name: 'google', config: cfg('google', s.url), modelKey: 'm', env });
    const e = await fail(p.complete('SYS', [{ role: 'user', content: 'hi' }], P, Ok));
    expect(e.code).toBe('RATE_LIMIT');
    expect((e as ProviderError & { retryAfterMs?: number }).retryAfterMs).toBe(2000);
    expect(s.seen).toHaveLength(1);
  });
});

describe('ollama REST', () => {
  it('posts /api/chat with the schema as format and reads token counts', async () => {
    const s = await serve([{ body: { model: 'qwen3:8b', message: { role: 'assistant', content: '{"ok":true}' }, done: true, done_reason: 'stop', prompt_eval_count: 9, eval_count: 4 } }]);
    const p = createOllama({ name: 'ollama', config: cfg('ollama', s.url, { pricing: { input_per_mtok: 0, output_per_mtok: 0 } }, { api_key_env: undefined }), modelKey: 'm', env: {} });
    const r = await p.complete('SYS', [{ role: 'user', content: 'hi' }], { max_tokens: 64, temperature: 0 }, Ok);
    expect(r.parsed).toEqual({ ok: true });
    expect([r.usage.input_tokens, r.usage.output_tokens, r.cost_usd]).toEqual([9, 4, 0]);
    expect(s.seen[0]?.url).toBe('/api/chat');
    expect(s.seen[0]?.body).toMatchObject({ model: 'model-1', stream: false, options: { num_predict: 64, temperature: 0 }, format: { type: 'object' } });
  });
  it('model not found -> BAD_REQUEST; unreachable server -> NETWORK', async () => {
    const s = await serve([{ status: 404, body: { error: 'model "model-1" not found, try pulling it first' } }]);
    const p = createOllama({ name: 'ollama', config: cfg('ollama', s.url, {}, { api_key_env: undefined }), modelKey: 'm', env: {} });
    const e = await fail(p.complete('SYS', [{ role: 'user', content: 'hi' }], P));
    expect([e.code, e.message.includes('try pulling it first')]).toEqual(['BAD_REQUEST', true]);
    const closed = await serve([{ body: {} }]);
    await new Promise((resolve) => servers.pop()?.close(resolve));
    const q = createOllama({ name: 'ollama', config: cfg('ollama', closed.url, {}, { api_key_env: undefined }), modelKey: 'm', env: {} });
    expect((await fail(q.complete('SYS', [{ role: 'user', content: 'hi' }], P))).code).toBe('NETWORK');
  });
});
