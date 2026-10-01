/** config/providers.yaml and .env.example stay consistent with each other and with the brief (model ids live only here). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { projectRoot } from '../src/util/paths.js';

const providers = loadConfig().providers;

describe('config/providers.yaml', () => {
  it('declares the expected providers and kinds', () => {
    const kinds = Object.fromEntries(Object.entries(providers.providers).map(([n, p]) => [n, p.kind]));
    expect(kinds).toEqual({
      anthropic: 'anthropic',
      openai: 'openai',
      google: 'google',
      deepseek: 'openai_compatible',
      mistral: 'openai_compatible',
      groq: 'openai_compatible',
      openrouter: 'openai_compatible',
      together: 'openai_compatible',
      ollama: 'ollama',
      mock: 'mock',
    });
    for (const [name, p] of Object.entries(providers.providers)) {
      if (p.kind === 'openai_compatible') expect(p.base_url, name).toMatch(/^https:\/\//);
    }
    expect(Object.keys(providers.providers['anthropic']?.models ?? {})).toEqual(['sonnet', 'opus', 'haiku']);
  });
  it('keeps the mock provider used by tests and the comparison harness', () => {
    const mock = providers.providers['mock'];
    expect(Object.keys(mock?.models ?? {})).toEqual(['mock-a', 'mock-b']);
    for (const m of Object.values(mock?.models ?? {})) expect(m).toMatchObject({ structured_output: 'native', pricing_verified: true, pricing: expect.any(Object) });
  });
  it('routes the judge to another vendor than the translator', () => {
    const r = providers.routing;
    expect(r.default_provider).toBe('anthropic');
    for (const s of ['translation', 'localization', 'repair', 'language_detection'] as const) expect(r.stages[s], s).toBe('anthropic');
    expect(r.stages.validation).toBe('openai');
    expect(r.stages.backtranslation).toBe('openai');
  });
  it('explains every price: verified ones name their source, unverified ones where to check', () => {
    for (const [name, p] of Object.entries(providers.providers)) {
      if (p.kind === 'mock') continue;
      for (const [key, m] of Object.entries(p.models)) {
        const where = `${name}:${key}`;
        expect(m.notes, where).toBeTruthy();
        if (m.pricing_verified) {
          expect(m.pricing, where).toBeDefined();
          expect(m.notes, where).toMatch(/Verified 2026-|Local model/);
        } else {
          expect(m.notes, where).toMatch(/https:\/\//);
        }
      }
    }
  });
});

describe('.env.example', () => {
  it('names exactly the variables providers.yaml reads', () => {
    const text = readFileSync(path.join(projectRoot(), '.env.example'), 'utf8');
    const declared = new Set([...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
    const referenced = new Set(Object.values(providers.providers).flatMap((p) => [p.api_key_env, p.base_url_env].filter((v): v is string => v !== undefined)));
    for (const v of referenced) expect(declared.has(v), v).toBe(true);
    const providerVars = [...declared].filter((v) => v !== undefined && /(?:_API_KEY|_BASE_URL|_HOST)$/.test(v));
    expect(new Set(providerVars)).toEqual(referenced);
  });
});
