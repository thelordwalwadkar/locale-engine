/**
 * Adapter mapping with fake clients (no network): request building, response / usage / stop-reason parsing, error mapping.
 * The real SDKs against local HTTP servers are covered in providers.sdk.test.ts.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ApiError } from '@google/genai';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildAnthropicRequest,
  createProvider as createAnthropic,
  defaultAnthropicClient,
  mapAnthropicError,
  parseAnthropicMessage,
  type AnthropicClientFactory,
  type AnthropicMessageLike,
} from '../src/providers/anthropic.js';
import { MissingCredentialsError, TransportError, type RawRequest } from '../src/providers/base.js';
import { buildGeminiRequest, createProvider as createGoogle, mapGeminiError, parseGeminiResponse, readGeminiErrorBody } from '../src/providers/google.js';
import { buildOllamaRequest, normalizeOllamaHost, parseOllamaResponse } from '../src/providers/ollama.js';
import { buildOpenAIRequest, createProvider as createOpenAI, defaultOpenAIClient, mapOpenAIError, parseOpenAIResponse } from '../src/providers/openai.js';
import { buildChatRequest, createProvider as createCompatible, parseChatCompletion } from '../src/providers/openai_compatible.js';
import { ProviderConfigSchema, ProviderError, type ProviderConfig } from '../src/schemas/index.js';

const KEY = 'sk-test-key-000';
const env = { TEST_KEY: KEY };
const cfg = (kind: string, model: Record<string, unknown> = {}, provider: Record<string, unknown> = {}): ProviderConfig =>
  ProviderConfigSchema.parse({
    kind,
    api_key_env: 'TEST_KEY',
    default_model: 'm',
    max_retries: 0,
    timeout_ms: 5000,
    models: { m: { id: 'model-1', structured_output: 'native', pricing: { input_per_mtok: 1, output_per_mtok: 1 }, pricing_verified: true, ...model } },
    ...provider,
  });
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const req = (over: Partial<RawRequest> = {}): RawRequest => ({
  system: 'SYS',
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'bad' },
    { role: 'user', content: 'fix it' },
  ],
  params: { max_tokens: 300, temperature: 0.2 },
  mode: 'native',
  jsonSchema: schema,
  ...over,
});
const Ok = z.object({ ok: z.boolean() });
const codeOf = (e: unknown) => (e as ProviderError).code;

describe('anthropic', () => {
  it('builds Messages requests: output_config.format for native, effort, no system when empty', () => {
    const body = buildAnthropicRequest(req(), 'claude-x', 'low');
    expect(body).toMatchObject({ model: 'claude-x', max_tokens: 300, system: 'SYS', temperature: 0.2, output_config: { format: { type: 'json_schema', schema }, effort: 'low' } });
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const plain = buildAnthropicRequest(req({ mode: 'json_mode', system: '' }), 'claude-x');
    expect(plain.output_config).toBeUndefined();
    expect(plain.system).toBeUndefined();
  });
  it('parses text blocks, cache usage and stop reasons', () => {
    const msg: AnthropicMessageLike = {
      content: [{ type: 'thinking' }, { type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40, cache_creation_input_tokens: 2 },
    };
    expect(parseAnthropicMessage(msg, 'a')).toEqual({ text: '{"ok":true}', usage: { input_tokens: 12, output_tokens: 5, cached_input_tokens: 40 }, stop_reason: 'max_tokens', truncated: true });
    expect(parseAnthropicMessage({ ...msg, stop_reason: 'model_context_window_exceeded' }, 'a').truncated).toBe(true);
    expect(() => parseAnthropicMessage({ ...msg, stop_reason: 'refusal' }, 'a')).toThrow(expect.objectContaining({ code: 'CONTENT_FILTER' }));
  });
  it('maps SDK errors to provider codes, with Retry-After', () => {
    const rate = mapAnthropicError(Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }, undefined, new Headers({ 'retry-after': '3' })), 'a');
    expect(rate).toBeInstanceOf(TransportError);
    expect(rate.code).toBe('RATE_LIMIT');
    expect((rate as TransportError).retryAfterMs).toBe(3000);
    expect(mapAnthropicError(Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, undefined, new Headers()), 'a').code).toBe('SERVER');
    expect(mapAnthropicError(Anthropic.APIError.generate(401, undefined, 'bad key', new Headers()), 'a').code).toBe('AUTH');
    expect(mapAnthropicError(Anthropic.APIError.generate(400, undefined, 'bad', new Headers()), 'a').code).toBe('BAD_REQUEST');
    expect(mapAnthropicError(new Anthropic.APIConnectionTimeoutError(), 'a').code).toBe('TIMEOUT');
    expect(mapAnthropicError(new Anthropic.APIConnectionError({ message: 'reset' }), 'a').code).toBe('NETWORK');
    expect(mapAnthropicError(new Error('odd'), 'a').code).toBe('UNKNOWN');
  });
  it('wires the client factory: key, timeout, signal, parameter rules of Claude 4.x', async () => {
    const seen: { init?: unknown; body?: Anthropic.MessageCreateParamsNonStreaming; signal?: AbortSignal } = {};
    const factory: AnthropicClientFactory = (init) => {
      seen.init = init;
      return {
        messages: {
          create: async (body, options) => {
            seen.body = body;
            if (options?.signal) seen.signal = options.signal;
            return { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } };
          },
        },
      };
    };
    const p = createAnthropic({ name: 'anthropic', config: cfg('anthropic', { unsupported_params: [] }), modelKey: 'm', env, clientFactory: factory });
    const r = await p.complete('SYS', [{ role: 'user', content: 'x' }], { max_tokens: 50, temperature: 0, top_p: 0.9, seed: 7 }, Ok);
    expect(seen.init).toEqual({ apiKey: KEY, timeoutMs: 5000 });
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(seen.body).toMatchObject({ temperature: 0, output_config: { format: { type: 'json_schema' } } });
    expect(seen.body).not.toHaveProperty('top_p'); // never together with temperature
    expect(r.warnings.filter((w) => w.code === 'PARAM_UNSUPPORTED').map((w) => w.message.split('=')[0])).toEqual(['seed', 'top_p']);
    expect(r.parsed).toEqual({ ok: true });
    expect(p.info).toEqual({ name: 'anthropic', kind: 'anthropic', model_key: 'm', model_id: 'model-1', structured_output: 'native' });
  });
  it('throws MissingCredentialsError without a key and builds an SDK client with retries off', () => {
    expect(() => createAnthropic({ name: 'anthropic', config: cfg('anthropic'), modelKey: 'm', env: {} })).toThrow(MissingCredentialsError);
    const client = defaultAnthropicClient({ apiKey: KEY, timeoutMs: 1000 }) as unknown as Anthropic;
    expect(client.maxRetries).toBe(0);
    expect(client.baseURL).toBe('https://api.anthropic.com');
  });
});

describe('openai (Responses API)', () => {
  it('builds strict json_schema / json_object requests with store: false', () => {
    const body = buildOpenAIRequest(req(), 'gpt-x', 'low');
    expect(body).toMatchObject({
      model: 'gpt-x',
      instructions: 'SYS',
      max_output_tokens: 300,
      store: false,
      temperature: 0.2,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'response', strict: true, schema } },
    });
    expect(body.input).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'bad' },
      { role: 'user', content: 'fix it' },
    ]);
    expect(buildOpenAIRequest(req({ mode: 'json_mode' }), 'gpt-x').text).toEqual({ format: { type: 'json_object' } });
    expect(buildOpenAIRequest(req({ mode: 'prompted' }), 'gpt-x').text).toBeUndefined();
  });
  it('reads final-answer text, cached tokens, incomplete status, refusals', () => {
    const msg = (phase: string | null, text: string) => ({ type: 'message', phase, content: [{ type: 'output_text', text }] });
    const res = {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'reasoning' }, msg('commentary', 'Let me think.'), msg('final_answer', '{"ok":true}')],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } },
    };
    expect(parseOpenAIResponse(res, 'o')).toEqual({ text: '{"ok":true}', usage: { input_tokens: 40, output_tokens: 20, cached_input_tokens: 60 }, stop_reason: 'incomplete:max_output_tokens', truncated: true });
    expect(parseOpenAIResponse({ status: 'completed', output: [msg(null, 'a'), msg(null, 'b')] }, 'o')).toMatchObject({ text: 'ab', stop_reason: 'completed', truncated: false });
    expect(() => parseOpenAIResponse({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }, 'o')).toThrow(expect.objectContaining({ code: 'CONTENT_FILTER' }));
    expect(() => parseOpenAIResponse({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }, 'o')).toThrow(expect.objectContaining({ code: 'CONTENT_FILTER' }));
    expect(() => parseOpenAIResponse({ status: 'failed', error: { message: 'boom' }, output: [] }, 'o')).toThrow(expect.objectContaining({ code: 'SERVER' }));
  });
  it('maps SDK errors (retry-after-ms) and drops seed, which the Responses API lacks', async () => {
    const e = mapOpenAIError(OpenAI.APIError.generate(429, { message: 'rate' }, undefined, new Headers({ 'retry-after-ms': '250' })), 'o');
    expect([e.code, (e as TransportError).retryAfterMs]).toEqual(['RATE_LIMIT', 250]);
    expect(mapOpenAIError(new OpenAI.APIConnectionTimeoutError(), 'o').code).toBe('TIMEOUT');
    expect(mapOpenAIError(new OpenAI.APIUserAbortError(), 'o').code).toBe('TIMEOUT');
    let body: OpenAI.Responses.ResponseCreateParamsNonStreaming | undefined;
    const p = createOpenAI({
      name: 'openai',
      config: cfg('openai', { unsupported_params: ['temperature', 'top_p'] }),
      modelKey: 'm',
      env,
      clientFactory: () => ({
        responses: {
          create: async (b) => {
            body = b;
            return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }], usage: { input_tokens: 5, output_tokens: 1 } };
          },
        },
      }),
    });
    const r = await p.complete('SYS', [{ role: 'user', content: 'x' }], { max_tokens: 50, temperature: 0, top_p: 1, seed: 3 }, Ok);
    expect(r.parsed).toEqual({ ok: true });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('seed');
    expect(r.warnings.filter((w) => w.code === 'PARAM_UNSUPPORTED')).toHaveLength(3);
    const client = defaultOpenAIClient({ apiKey: KEY, timeoutMs: 1000 }) as unknown as OpenAI;
    expect([client.maxRetries, client.baseURL, client.organization]).toEqual([0, 'https://api.openai.com/v1', null]);
  });
});

describe('openai_compatible (Chat Completions)', () => {
  it('builds chat requests with response_format, seed, reasoning_effort and vendor fields', () => {
    const body = buildChatRequest(req({ params: { max_tokens: 99, seed: 4, top_p: 0.5 } }), 'deepseek-x', { effort: 'high', extraBody: { provider: { require_parameters: true }, model: 'hijack' } });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(body).toMatchObject({
      model: 'deepseek-x',
      max_tokens: 99,
      seed: 4,
      top_p: 0.5,
      reasoning_effort: 'high',
      provider: { require_parameters: true },
      response_format: { type: 'json_schema', json_schema: { name: 'response', schema, strict: true } },
    });
    expect(buildChatRequest(req({ mode: 'json_mode' }), 'x').response_format).toEqual({ type: 'json_object' });
    expect(buildChatRequest(req({ mode: 'prompted' }), 'x').response_format).toBeUndefined();
  });
  it('parses content, cached tokens (standard and DeepSeek), truncation, refusals', () => {
    const base = { choices: [{ finish_reason: 'length', message: { content: '{"ok"', refusal: null } }], usage: { prompt_tokens: 50, completion_tokens: 9, prompt_cache_hit_tokens: 20 } };
    expect(parseChatCompletion(base, 'c')).toEqual({ text: '{"ok"', usage: { input_tokens: 30, output_tokens: 9, cached_input_tokens: 20 }, stop_reason: 'length', truncated: true });
    expect(parseChatCompletion({ ...base, usage: { prompt_tokens: 50, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 10 } } }, 'c').usage.cached_input_tokens).toBe(10);
    expect(() => parseChatCompletion({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'no' } }] }, 'c')).toThrow(expect.objectContaining({ code: 'CONTENT_FILTER' }));
    expect(() => parseChatCompletion({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }, 'c')).toThrow(expect.objectContaining({ code: 'CONTENT_FILTER' }));
    expect(() => parseChatCompletion({ choices: [] }, 'c')).toThrow(expect.objectContaining({ code: 'SERVER' }));
  });
  it('needs a base URL; a keyless local server gets a placeholder key', async () => {
    expect(() => createCompatible({ name: 'x', config: cfg('openai_compatible'), modelKey: 'm', env })).toThrow(MissingCredentialsError);
    let apiKey = '';
    const p = createCompatible({
      name: 'vllm',
      config: cfg('openai_compatible', {}, { api_key_env: undefined, base_url: 'http://127.0.0.1:1/v1' }),
      modelKey: 'm',
      env: {},
      clientFactory: (init) => {
        apiKey = init.apiKey;
        return { chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }) } } };
      },
    });
    expect((await p.complete('s', [{ role: 'user', content: 'x' }], { max_tokens: 10 }, Ok)).parsed).toEqual({ ok: true });
    expect(apiKey).toBe('not-needed');
  });
});

describe('google (Gemini)', () => {
  it('builds generateContent requests: roles, systemInstruction, responseJsonSchema, thinking level', () => {
    const r = buildGeminiRequest(req({ params: { max_tokens: 64, top_p: 0.9, seed: 1 } }), 'gemini-x', 'low');
    expect(r.model).toBe('gemini-x');
    expect(r.contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'bad' }] },
      { role: 'user', parts: [{ text: 'fix it' }] },
    ]);
    expect(r.config).toMatchObject({ systemInstruction: 'SYS', maxOutputTokens: 64, topP: 0.9, seed: 1, responseMimeType: 'application/json', responseJsonSchema: schema, thinkingConfig: { thinkingLevel: 'LOW' } });
    const jm = buildGeminiRequest(req({ mode: 'json_mode' }), 'g').config;
    expect([jm?.responseMimeType, jm?.responseJsonSchema]).toEqual(['application/json', undefined]);
    expect(buildGeminiRequest(req({ mode: 'prompted' }), 'g').config?.responseMimeType).toBeUndefined();
  });
  it('skips thought parts; counts thoughts as output and cached content separately', () => {
    const res = {
      candidates: [{ content: { parts: [{ text: 'hmm', thought: true }, { text: '{"ok":true}' }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 30, candidatesTokenCount: 8, thoughtsTokenCount: 12, toolUsePromptTokenCount: 5 },
    };
    expect(parseGeminiResponse(res, 'g')).toEqual({ text: '{"ok":true}', usage: { input_tokens: 75, output_tokens: 20, cached_input_tokens: 30 }, stop_reason: 'MAX_TOKENS', truncated: true });
    expect(() => parseGeminiResponse({ candidates: [{ finishReason: 'SAFETY' }] }, 'g')).toThrow(expect.objectContaining({ code: 'CONTENT_FILTER' }));
    expect(() => parseGeminiResponse({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }, 'g')).toThrow(expect.objectContaining({ code: 'CONTENT_FILTER' }));
  });
  it('maps ApiError bodies, including RetryInfo', () => {
    const body = JSON.stringify({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }] } });
    expect(readGeminiErrorBody(body)).toEqual({ message: 'RESOURCE_EXHAUSTED: Quota exceeded', retryAfterMs: 30000 });
    const e = mapGeminiError(new ApiError({ message: body, status: 429 }), 'g');
    expect([e.code, (e as TransportError).retryAfterMs]).toEqual(['RATE_LIMIT', 30000]);
    expect(mapGeminiError(new ApiError({ message: 'not json', status: 400 }), 'g').code).toBe('BAD_REQUEST');
    expect(mapGeminiError(Object.assign(new Error('x'), { name: 'AbortError' }), 'g').code).toBe('TIMEOUT');
    expect(mapGeminiError(new TypeError('fetch failed'), 'g').code).toBe('NETWORK');
  });
  it('drops temperature for Gemini 3 when configured and passes the key to the factory', async () => {
    let key = '';
    const p = createGoogle({
      name: 'google',
      config: cfg('google', { unsupported_params: ['temperature'] }),
      modelKey: 'm',
      env,
      clientFactory: (init) => {
        key = init.apiKey;
        return {
          models: {
            generateContent: async (params) => {
              expect(params.config?.temperature).toBeUndefined();
              return { candidates: [{ content: { parts: [{ text: '{"ok":false}' }] }, finishReason: 'STOP' }] };
            },
          },
        };
      },
    });
    const r = await p.complete('s', [{ role: 'user', content: 'x' }], { max_tokens: 10, temperature: 0 }, Ok);
    expect([key, r.parsed?.ok, r.warnings[0]?.code]).toEqual([KEY, false, 'PARAM_UNSUPPORTED']);
  });
});

describe('ollama', () => {
  it('normalizes OLLAMA_HOST values', () => {
    expect(normalizeOllamaHost('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
    expect(normalizeOllamaHost('localhost')).toBe('http://localhost:11434');
    expect(normalizeOllamaHost('0.0.0.0:9999')).toBe('http://127.0.0.1:9999');
    expect(normalizeOllamaHost('https://ollama.example.com')).toBe('https://ollama.example.com');
  });
  it('builds /api/chat bodies: format, options, think, keep_alive', () => {
    const body = buildOllamaRequest(req({ params: { max_tokens: 64, temperature: 0.1, top_p: 0.9, seed: 5 } }), 'qwen3:8b', { think: false, keepAlive: '5m' });
    expect(body).toEqual({
      model: 'qwen3:8b',
      stream: false,
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'bad' },
        { role: 'user', content: 'fix it' },
      ],
      options: { num_predict: 64, temperature: 0.1, top_p: 0.9, seed: 5 },
      format: schema,
      think: false,
      keep_alive: '5m',
    });
    expect(buildOllamaRequest(req({ mode: 'json_mode' }), 'm').format).toBe('json');
    expect(buildOllamaRequest(req({ mode: 'prompted' }), 'm').format).toBeUndefined();
  });
  it('parses usage and done_reason', () => {
    expect(parseOllamaResponse({ message: { content: 'hi' }, done_reason: 'length', prompt_eval_count: 12, eval_count: 3 }, 'l')).toEqual({ text: 'hi', usage: { input_tokens: 12, output_tokens: 3 }, stop_reason: 'length', truncated: true });
    expect(() => parseOllamaResponse('nope', 'l')).toThrow(ProviderError);
  });
});

describe('error codes are retryable exactly for transient failures', () => {
  it.each([
    ['RATE_LIMIT', true],
    ['SERVER', true],
    ['NETWORK', true],
    ['TIMEOUT', true],
    ['AUTH', false],
    ['BAD_REQUEST', false],
    ['CONTENT_FILTER', false],
  ] as const)('%s -> %s', (code, retryable) => {
    expect(new ProviderError('x', code, { provider: 'p' }).retryable).toBe(retryable);
    expect(codeOf(new ProviderError('x', code, { provider: 'p' }))).toBe(code);
  });
});
