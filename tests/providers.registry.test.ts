import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { loadConfig } from '../src/config/load.js';
import type { AnthropicClientFactory } from '../src/providers/anthropic.js';
import { MissingCredentialsError } from '../src/providers/base.js';
import type { OpenAIClientFactory } from '../src/providers/openai.js';
import { createProviderRegistry, createProviderRegistryAsync, type ClientFactories } from '../src/providers/registry.js';
import { ProvidersConfigSchema, type ProvidersConfig } from '../src/schemas/index.js';
import { EngineError } from '../src/util/errors.js';
import { fixturesDir } from '../src/util/paths.js';

const anthropicFake: AnthropicClientFactory = () => ({
  messages: { create: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) },
});
const openaiFake: OpenAIClientFactory = () => ({
  responses: { create: async () => ({ status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } }) },
});
const clientFactories: ClientFactories = { anthropic: anthropicFake, openai: openaiFake };

const config: ProvidersConfig = ProvidersConfigSchema.parse({
  version: 1,
  providers: {
    anthropic: {
      kind: 'anthropic',
      api_key_env: 'ANTHROPIC_API_KEY',
      default_model: 'sonnet',
      models: {
        haiku: { id: 'claude-haiku-x', pricing: { input_per_mtok: 1, output_per_mtok: 5 }, pricing_verified: true },
        sonnet: { id: 'claude-sonnet-x', pricing: { input_per_mtok: 2, output_per_mtok: 10 }, pricing_verified: true },
      },
    },
    openai: {
      kind: 'openai',
      api_key_env: 'OPENAI_API_KEY',
      default_model: 'sol',
      models: {
        sol: { id: 'gpt-sol', pricing: { input_per_mtok: 2, output_per_mtok: 10 }, pricing_verified: true },
        luna: { id: 'gpt-luna', pricing: { input_per_mtok: 0.1, output_per_mtok: 0.5 }, pricing_verified: false },
      },
    },
    groq: { kind: 'openai_compatible', api_key_env: 'GROQ_API_KEY', base_url: 'https://example.invalid/v1', default_model: 'oss', models: { oss: { id: 'oss-x' } } },
    ollama: { kind: 'ollama', base_url: 'http://127.0.0.1:9', default_model: 'q', models: { q: { id: 'qwen:x', pricing: { input_per_mtok: 0, output_per_mtok: 0 }, pricing_verified: true } } },
    mock: { kind: 'mock', default_model: 'mock-a', models: { 'mock-a': { id: 'mock-a', structured_output: 'native', pricing: { input_per_mtok: 1, output_per_mtok: 2 }, pricing_verified: true } } },
  },
  routing: { default_provider: 'anthropic', stages: { translation: 'anthropic', validation: 'openai', backtranslation: 'openai', language_detection: 'anthropic:haiku' } },
});
const allKeys = { ANTHROPIC_API_KEY: 'a-key-1234', OPENAI_API_KEY: 'o-key-1234' };
const codes = (notes: readonly { code: string }[]) => notes.map((n) => n.code);

describe('routing', () => {
  it('routes stages, uses the default provider for unlisted stages and caches instances per provider:model', () => {
    const r = createProviderRegistry({ config, env: allKeys, clientFactories });
    expect(r.forStage('translation').info).toMatchObject({ name: 'anthropic', model_key: 'sonnet', model_id: 'claude-sonnet-x' });
    expect(r.forStage('validation').info).toMatchObject({ name: 'openai', model_key: 'sol' });
    expect(r.forStage('language_detection').info.model_key).toBe('haiku');
    expect(r.forStage('repair')).toBe(r.forStage('translation'));
    expect(r.get('anthropic:sonnet')).toBe(r.forStage('localization'));
    expect(r.notes).toEqual([]);
  });
  it('per-run overrides win and are noted once', () => {
    const r = createProviderRegistry({ config, env: allKeys, clientFactories, overrides: { validation: 'mock', translation: 'openai:luna' } });
    expect(r.forStage('validation').info.kind).toBe('mock');
    r.forStage('validation');
    expect(r.forStage('translation').info.model_id).toBe('gpt-luna');
    expect(r.notes.filter((n) => n.code === 'PROVIDER_OVERRIDE').map((n) => n.stage)).toEqual(['validation', 'translation']);
    expect(codes(r.notes)).toContain('PRICING_UNVERIFIED');
  });
  it('rejects unknown references', () => {
    const r = createProviderRegistry({ config, env: allKeys, clientFactories });
    expect(() => r.get('nope')).toThrow(EngineError);
    expect(() => r.get('openai:nope')).toThrow(/no model "nope"/);
    expect(() => createProviderRegistry({ config, env: allKeys, overrides: { repair: 'ghost' } }).forStage('repair')).toThrow(/unknown provider "ghost"/);
  });
});

describe('credentials', () => {
  it('a routed provider without a key falls back to the default provider (PROVIDER_FALLBACK naming both)', () => {
    const r = createProviderRegistry({ config, env: { ANTHROPIC_API_KEY: 'a-key-1234' }, clientFactories });
    expect(r.forStage('validation').name).toBe('anthropic');
    const fallback = r.notes.find((n) => n.code === 'PROVIDER_FALLBACK');
    expect(fallback?.stage).toBe('validation');
    expect(fallback?.message).toContain('"openai"');
    expect(fallback?.message).toContain('OPENAI_API_KEY');
    expect(fallback?.message).toContain('"anthropic"');
  });
  it('JUDGE_NOT_INDEPENDENT is noted once when the judge ends up on the translator', () => {
    const r = createProviderRegistry({ config, env: { ANTHROPIC_API_KEY: 'a-key-1234' }, clientFactories });
    r.forStage('validation');
    r.forStage('translation');
    r.forStage('backtranslation');
    expect(r.notes.filter((n) => n.code === 'JUDGE_NOT_INDEPENDENT')).toHaveLength(1);
    const independent = createProviderRegistry({ config, env: allKeys, clientFactories });
    independent.forStage('translation');
    independent.forStage('validation');
    expect(codes(independent.notes)).not.toContain('JUDGE_NOT_INDEPENDENT');
  });
  it('throws NO_CREDENTIALS naming the variables when the default is unusable too', () => {
    const r = createProviderRegistry({ config, env: {}, clientFactories });
    expect(() => r.forStage('translation')).toThrow(expect.objectContaining({ code: 'NO_CREDENTIALS', missing: ['ANTHROPIC_API_KEY'] }));
    expect(() => r.forStage('validation')).toThrow(MissingCredentialsError);
    expect(() => r.forStage('validation')).toThrow(/OPENAI_API_KEY.*ANTHROPIC_API_KEY/);
    expect(() => r.get('openai')).toThrow(expect.objectContaining({ code: 'NO_CREDENTIALS', missing: ['OPENAI_API_KEY'] }));
  });
  it('ollama and mock need no key', () => {
    const r = createProviderRegistry({ config, env: {}, clientFactories });
    expect(r.get('ollama').info.kind).toBe('ollama');
    expect(r.get('mock').info.kind).toBe('mock');
  });
});

describe('notes and describe()', () => {
  it('notes unverified or missing pricing once per model', () => {
    const r = createProviderRegistry({ config, env: { ...allKeys, GROQ_API_KEY: 'g-key-1234' }, clientFactories });
    r.get('openai:luna');
    r.get('openai:luna');
    r.get('groq');
    const pricing = r.notes.filter((n) => n.code === 'PRICING_UNVERIFIED');
    expect(pricing).toHaveLength(2);
    expect(pricing[1]?.message).toContain('no pricing configured');
  });
  it('lists every provider/model with configured and pricing flags, default model first', () => {
    const d = createProviderRegistry({ config, env: { ANTHROPIC_API_KEY: 'a-key-1234' }, clientFactories }).describe();
    expect(d.map((x) => `${x.name}:${x.model_key}`)).toEqual(['anthropic:sonnet', 'anthropic:haiku', 'openai:sol', 'openai:luna', 'groq:oss', 'ollama:q', 'mock:mock-a']);
    expect(Object.fromEntries(d.map((x) => [x.name, x.configured]))).toEqual({ anthropic: true, openai: false, groq: false, ollama: true, mock: true });
    expect(d.find((x) => x.model_key === 'luna')).toMatchObject({ has_pricing: true, pricing_verified: false, structured_output: 'prompted', kind: 'openai' });
    expect(d.find((x) => x.name === 'groq')?.has_pricing).toBe(false);
  });
});

describe('kind: custom (R1: a provider added through YAML only)', () => {
  const fixture = ProvidersConfigSchema.parse(parseYaml(readFileSync(path.join(fixturesDir(), 'providers', 'custom-providers.yaml'), 'utf8')));
  it('the async registry imports the module and the provider works with no code change', async () => {
    const r = await createProviderRegistryAsync({ config: fixture, env: {} });
    const p = r.forStage('translation');
    expect(p.info).toMatchObject({ name: 'echo', kind: 'custom', model_id: 'echo-model-1' });
    const res = await p.complete('sys', [{ role: 'user', content: 'Hallo' }], { max_tokens: 10, temperature: 0.2 }, z.object({ echo: z.string() }));
    expect(res.parsed).toEqual({ echo: 'Hallo' });
    expect(res.warnings.map((w) => w.code)).toEqual(['PARAM_UNSUPPORTED']);
    expect(r.forStage('validation').info.kind).toBe('mock');
  });
  it('the sync registry explains that custom modules need the async factory', () => {
    const r = createProviderRegistry({ config: fixture, env: {} });
    expect(() => r.forStage('translation')).toThrow(/createProviderRegistryAsync/);
  });
  it('bad modules are configuration errors', async () => {
    const broken = ProvidersConfigSchema.parse({ ...fixture, providers: { ...fixture.providers, echo: { ...fixture.providers['echo'], module: 'tests/fixtures/providers/missing.mjs' } } });
    await expect(createProviderRegistryAsync({ config: broken, env: {} })).rejects.toThrow(/cannot import/);
    const r = createProviderRegistry({ config: fixture, env: {}, preloaded: { echo: { createProvider: () => ({}) as never } } });
    expect(() => r.forStage('translation')).toThrow(/must return an LLMProvider/);
  });
});

describe('config/providers.yaml', () => {
  const real = loadConfig().providers;
  it('routes the judge to a different vendor than the translator when both keys exist', () => {
    const r = createProviderRegistry({ config: real, env: allKeys, clientFactories });
    expect(r.forStage('validation').name).not.toBe(r.forStage('translation').name);
    expect(r.forStage('backtranslation').name).toBe(r.forStage('validation').name);
    expect(codes(r.notes)).not.toContain('JUDGE_NOT_INDEPENDENT');
  });
  it('degrades gracefully with only the default key', () => {
    const r = createProviderRegistry({ config: real, env: { ANTHROPIC_API_KEY: 'a-key-1234' }, clientFactories });
    r.forStage('translation');
    r.forStage('validation');
    expect(codes(r.notes)).toEqual(expect.arrayContaining(['PROVIDER_FALLBACK', 'JUDGE_NOT_INDEPENDENT']));
  });
});
