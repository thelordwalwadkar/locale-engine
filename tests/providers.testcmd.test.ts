import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { AnthropicClientFactory } from '../src/providers/anthropic.js';
import { httpError } from '../src/providers/base.js';
import type { OpenAIClientFactory } from '../src/providers/openai.js';
import { createProviderRegistry, createProviderRegistryAsync } from '../src/providers/registry.js';
import { testProviders } from '../src/providers/test.js';
import { ProvidersConfigSchema, ProviderTestResultSchema } from '../src/schemas/index.js';
import { fixturesDir } from '../src/util/paths.js';

const config = ProvidersConfigSchema.parse({
  version: 1,
  providers: {
    anthropic: {
      kind: 'anthropic',
      api_key_env: 'ANTHROPIC_API_KEY',
      default_model: 'sonnet',
      models: { sonnet: { id: 'claude-sonnet-x', structured_output: 'native', unsupported_params: ['temperature', 'top_p'], pricing: { input_per_mtok: 2, output_per_mtok: 10 }, pricing_verified: true } },
    },
    openai: { kind: 'openai', api_key_env: 'OPENAI_API_KEY', default_model: 'sol', models: { sol: { id: 'gpt-sol', structured_output: 'native' } } },
    mock: { kind: 'mock', default_model: 'mock-a', models: { 'mock-a': { id: 'mock-a', structured_output: 'native', pricing: { input_per_mtok: 1, output_per_mtok: 2 }, pricing_verified: true } } },
  },
  routing: { default_provider: 'anthropic', stages: { validation: 'openai' } },
});

function anthropicReplying(text: string, calls: unknown[]): AnthropicClientFactory {
  return () => ({
    messages: {
      create: async (body) => {
        calls.push(body);
        return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 10 } };
      },
    },
  });
}

describe('testProviders', () => {
  it('sends one small schema-bound request per configured provider and reports latency, cost, warnings', async () => {
    const calls: unknown[] = [];
    let openaiBuilt = 0;
    const openai: OpenAIClientFactory = () => {
      openaiBuilt++;
      return { responses: { create: async () => ({ output: [] }) } };
    };
    const registry = createProviderRegistry({
      config,
      env: { ANTHROPIC_API_KEY: 'a-key-1234' },
      clientFactories: { anthropic: anthropicReplying('{"ok": true, "echo": "locale"}', calls), openai },
    });
    const results = await testProviders(registry);
    for (const r of results) expect(ProviderTestResultSchema.safeParse(r).success).toBe(true);
    expect(results.map((r) => r.provider)).toEqual(['anthropic', 'mock']); // default: configured providers only
    const a = results[0];
    expect(a).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-x', configured: true, ok: true, structured_output: 'native', error: null, warnings: ['PARAM_UNSUPPORTED'] });
    expect(a?.cost_usd).toBeCloseTo((40 * 2 + 10 * 10) / 1e6, 12);
    expect(typeof a?.latency_ms).toBe('number');
    expect(calls[0]).toMatchObject({ max_tokens: 1024, output_config: { format: { type: 'json_schema' } } });
    expect(openaiBuilt).toBe(0);
  });
  it('reports an unconfigured provider without any network call', async () => {
    let built = 0;
    const registry = createProviderRegistry({ config, env: {}, clientFactories: { openai: () => ((built++), { responses: { create: async () => ({ output: [] }) } }) } });
    const [r] = await testProviders(registry, ['openai']);
    expect(r).toEqual({ provider: 'openai', model: 'gpt-sol', configured: false, ok: false, structured_output: 'native', latency_ms: null, cost_usd: null, warnings: [], error: 'missing OPENAI_API_KEY' });
    expect(built).toBe(0);
  });
  it('the mock provider answers the connectivity check offline, with native and with prompted structured output', async () => {
    const [r] = await testProviders(createProviderRegistry({ config, env: {} }), ['mock']);
    expect(ProviderTestResultSchema.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({ provider: 'mock', model: 'mock-a', configured: true, ok: true, structured_output: 'native', error: null, warnings: [] });
    expect(typeof r?.cost_usd).toBe('number');

    const prompted = ProvidersConfigSchema.parse({
      version: 1,
      providers: { mock: { kind: 'mock', default_model: 'mock-p', models: { 'mock-p': { id: 'mock-p', structured_output: 'prompted' } } } },
      routing: { default_provider: 'mock', stages: {} },
    });
    const [p] = await testProviders(createProviderRegistry({ config: prompted, env: {} }), ['mock']);
    expect(p).toMatchObject({ provider: 'mock', model: 'mock-p', configured: true, ok: true, structured_output: 'prompted', error: null });
  });
  it('captures provider failures, wrong answers and unknown names as errors', async () => {
    const failing: AnthropicClientFactory = () => ({ messages: { create: async () => Promise.reject(httpError('anthropic', 401, 'invalid x-api-key')) } });
    const registry = createProviderRegistry({ config: ProvidersConfigSchema.parse({ ...config, providers: { ...config.providers, anthropic: { ...config.providers['anthropic'], max_retries: 0 } } }), env: { ANTHROPIC_API_KEY: 'a-key-1234' }, clientFactories: { anthropic: failing } });
    const [bad, unknown] = await testProviders(registry, ['anthropic', 'nope']);
    expect(bad).toMatchObject({ configured: true, ok: false });
    expect(bad?.error).toContain('HTTP 401');
    expect(typeof bad?.latency_ms).toBe('number');
    expect(unknown).toMatchObject({ provider: 'nope', configured: false, ok: false });
    expect(unknown?.error).toContain('unknown provider');
    const wrong = createProviderRegistry({ config, env: { ANTHROPIC_API_KEY: 'a-key-1234' }, clientFactories: { anthropic: anthropicReplying('{"ok": false, "echo": "x"}', []) } });
    const [w] = await testProviders(wrong, ['anthropic']);
    expect(w).toMatchObject({ ok: false, error: 'the model did not answer "ok": true' });
    expect(w?.warnings).toContain('ECHO_MISMATCH');
  });
  it('works for a provider added through YAML only (kind: custom)', async () => {
    const fixture = ProvidersConfigSchema.parse(parseYaml(readFileSync(path.join(fixturesDir(), 'providers', 'custom-providers.yaml'), 'utf8')));
    const [r] = await testProviders(await createProviderRegistryAsync({ config: fixture, env: {} }), ['echo']);
    expect(r).toMatchObject({ provider: 'echo', model: 'echo-model-1', configured: true, ok: true, cost_usd: 0 });
    expect(r?.warnings).toEqual(['PARAM_UNSUPPORTED', 'ECHO_MISMATCH']); // the echo adapter repeats the prompt
  });
});
