/**
 * Provider registry (spec §6.2, ARCHITECTURE P4 / P6): which provider and model serve each stage.
 *  - Precedence: per-run override (note PROVIDER_OVERRIDE) > `routing.stages` > `routing.default_provider`;
 *    references are `provider` or `provider:model-key` (default model: `default_model`).
 *  - A routed provider without credentials falls back to the default provider (PROVIDER_FALLBACK); only when the default
 *    is unusable too does `forStage` throw NO_CREDENTIALS naming what to set.
 *  - Judge independence: validation / backtranslation on the same provider name as translation -> JUDGE_NOT_INDEPENDENT.
 *  - Models whose pricing is unverified (or missing) get one PRICING_UNVERIFIED note when first used.
 *  - `kind: custom` modules need an async import while `forStage` is synchronous: `createProviderRegistryAsync` imports
 *    them first; the synchronous factory accepts them through `preloaded`.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  LLMProvider,
  ProviderConfig,
  ProviderDescription,
  ProviderRegistry,
  ProvidersConfig,
  RegistryNote,
  Stage,
} from '../schemas/index.js';
import { EngineError, errorMessage } from '../util/errors.js';
import { projectRoot } from '../util/paths.js';
import { createProvider as createAnthropic, type AnthropicClientFactory } from './anthropic.js';
import { MissingCredentialsError, resolveEndpoint, type ProviderFactoryArgs } from './base.js';
import { createProvider as createGoogle, type GeminiClientFactory } from './google.js';
import { createMockProvider, type MockScript } from './mock.js';
import { createProvider as createOllama, type FetchLike } from './ollama.js';
import { createProvider as createOpenAI, type OpenAIClientFactory } from './openai.js';
import { createProvider as createOpenAICompatible, type ChatClientFactory } from './openai_compatible.js';

/** Client factories per adapter kind (tests inject fakes; production uses the SDK defaults). */
export interface ClientFactories {
  anthropic?: AnthropicClientFactory;
  openai?: OpenAIClientFactory;
  google?: GeminiClientFactory;
  openai_compatible?: ChatClientFactory;
  ollama?: FetchLike;
}

/** What a `kind: custom` module exports. */
export interface CustomProviderModule {
  createProvider(args: ProviderFactoryArgs): LLMProvider;
}

export interface ProviderRegistryOptions {
  config: ProvidersConfig;
  /** Where credentials are read. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Per-run routing: stage -> `provider` or `provider:model-key`. */
  overrides?: Partial<Record<Stage, string>>;
  mockScript?: MockScript;
  clientFactories?: ClientFactories;
  /** Already imported `kind: custom` modules by provider name (createProviderRegistryAsync fills this). */
  preloaded?: Readonly<Record<string, CustomProviderModule>>;
}

interface Target {
  name: string;
  modelKey: string;
  config: ProviderConfig;
}

const JUDGE_STAGES = ['validation', 'backtranslation'] as const;

export function createProviderRegistry(opts: ProviderRegistryOptions): ProviderRegistry {
  const { config } = opts;
  const env = opts.env ?? process.env;
  const notes: RegistryNote[] = [];
  const noted = new Set<string>();
  const instances = new Map<string, LLMProvider>();
  const byStage = new Map<Stage, LLMProvider>();

  const note = (key: string, n: RegistryNote): void => {
    if (noted.has(key)) return;
    noted.add(key);
    notes.push(n);
  };

  const parse = (ref: string, where: string): Target => {
    const [name = '', modelKey, ...rest] = ref.split(':');
    const pc = config.providers[name];
    if (!pc || rest.length > 0) {
      throw new EngineError('INPUT_INVALID', `${where}: unknown provider "${ref}" (configured: ${Object.keys(config.providers).join(', ')})`);
    }
    const key = modelKey || pc.default_model;
    if (!pc.models[key]) {
      throw new EngineError('INPUT_INVALID', `${where}: provider "${name}" has no model "${key}" (models: ${Object.keys(pc.models).join(', ')})`);
    }
    return { name, modelKey: key, config: pc };
  };

  const missing = (t: Target): string[] => resolveEndpoint(t.config, env).missing;

  const build = (t: Target): LLMProvider => {
    const args = { name: t.name, config: t.config, modelKey: t.modelKey, env };
    const f = opts.clientFactories ?? {};
    switch (t.config.kind) {
      case 'anthropic':
        return createAnthropic({ ...args, ...(f.anthropic ? { clientFactory: f.anthropic } : {}) });
      case 'openai':
        return createOpenAI({ ...args, ...(f.openai ? { clientFactory: f.openai } : {}) });
      case 'google':
        return createGoogle({ ...args, ...(f.google ? { clientFactory: f.google } : {}) });
      case 'openai_compatible':
        return createOpenAICompatible({ ...args, ...(f.openai_compatible ? { clientFactory: f.openai_compatible } : {}) });
      case 'ollama':
        return createOllama({ ...args, ...(f.ollama ? { clientFactory: f.ollama } : {}) });
      case 'mock':
        return createMockProvider(t.name, t.config, opts.mockScript, t.modelKey);
      case 'custom': {
        const mod = opts.preloaded?.[t.name];
        if (!mod) {
          throw new EngineError(
            'CONFIG_INVALID',
            `provider "${t.name}" is kind "custom": create the registry with createProviderRegistryAsync() so "${t.config.module ?? ''}" is imported first`,
          );
        }
        const provider: unknown = mod.createProvider(args);
        if (!isProvider(provider)) {
          throw new EngineError('CONFIG_INVALID', `providers.${t.name}.module: createProvider() must return an LLMProvider ({ name, info, complete })`);
        }
        return provider;
      }
    }
  };

  const instantiate = (t: Target): LLMProvider => {
    const key = `${t.name}:${t.modelKey}`;
    const cached = instances.get(key);
    if (cached) return cached;
    const provider = build(t);
    instances.set(key, provider);
    const model = t.config.models[t.modelKey];
    if (model && !model.pricing_verified) {
      note(`pricing:${key}`, {
        code: 'PRICING_UNVERIFIED',
        message: model.pricing
          ? `${key} (${model.id}): pricing not verified against the vendor's price page; costs are estimates`
          : `${key} (${model.id}): no pricing configured; cost_usd is reported as null`,
      });
    }
    return provider;
  };

  const checkJudgeIndependence = (): void => {
    const translator = byStage.get('translation');
    if (!translator) return;
    for (const stage of JUDGE_STAGES) {
      const judge = byStage.get(stage);
      if (judge && judge.name === translator.name) {
        note('judge', {
          code: 'JUDGE_NOT_INDEPENDENT',
          stage,
          message: `${stage} runs on "${judge.name}", the provider that translated: self-preference bias is possible (ARCHITECTURE P4)`,
        });
      }
    }
  };

  const forStage = (stage: Stage): LLMProvider => {
    const resolved = byStage.get(stage);
    if (resolved) return resolved;
    const override = opts.overrides?.[stage];
    const routed = config.routing.stages[stage] ?? config.routing.default_provider;
    const ref = override ?? routed;
    let target = parse(ref, override !== undefined ? `per-run provider for ${stage}` : `routing.stages.${stage}`);
    if (override !== undefined) {
      note(`override:${stage}`, { code: 'PROVIDER_OVERRIDE', stage, message: `${stage}: per-run provider "${override}" instead of "${routed}"` });
    }
    const gaps = missing(target);
    if (gaps.length > 0) {
      const fallback = parse(config.routing.default_provider, 'routing.default_provider');
      const fallbackGaps = fallback.name === target.name ? gaps : missing(fallback);
      if (fallbackGaps.length > 0) {
        throw new MissingCredentialsError(
          fallback.name === target.name
            ? `${stage}: provider "${target.name}" is not configured: set ${gaps.join(', ')} in .env`
            : `${stage}: provider "${target.name}" is not configured (set ${gaps.join(', ')}) and neither is the default provider "${fallback.name}" (set ${fallbackGaps.join(', ')})`,
          target.name,
          [...new Set([...gaps, ...fallbackGaps])],
        );
      }
      note(`fallback:${stage}`, {
        code: 'PROVIDER_FALLBACK',
        stage,
        message: `${stage}: "${target.name}" is not configured (set ${gaps.join(', ')}); using the default provider "${fallback.name}"`,
      });
      target = fallback;
    }
    const provider = instantiate(target);
    byStage.set(stage, provider);
    checkJudgeIndependence();
    return provider;
  };

  const get = (ref: string): LLMProvider => {
    const target = parse(ref, 'provider reference');
    const gaps = missing(target);
    if (gaps.length > 0) throw new MissingCredentialsError(`provider "${target.name}" is not configured: set ${gaps.join(', ')} in .env`, target.name, gaps);
    return instantiate(target);
  };

  /** Every provider/model; each provider's default model is listed first. */
  const describe = (): ProviderDescription[] => {
    const out: ProviderDescription[] = [];
    for (const [name, pc] of Object.entries(config.providers)) {
      const configured = resolveEndpoint(pc, env).missing.length === 0;
      const keys = [pc.default_model, ...Object.keys(pc.models).filter((k) => k !== pc.default_model)];
      for (const key of keys) {
        const model = pc.models[key];
        if (!model) continue;
        out.push({
          name,
          kind: pc.kind,
          model_key: key,
          model_id: model.id,
          structured_output: instances.get(`${name}:${key}`)?.info.structured_output ?? model.structured_output,
          configured,
          has_pricing: model.pricing !== undefined,
          pricing_verified: model.pricing_verified,
        });
      }
    }
    return out;
  };

  return { forStage, get, describe, notes };
}

/** Imports every `kind: custom` module (paths relative to the project root, or absolute), then builds the registry. */
export async function createProviderRegistryAsync(opts: ProviderRegistryOptions): Promise<ProviderRegistry> {
  const preloaded: Record<string, CustomProviderModule> = { ...opts.preloaded };
  for (const [name, pc] of Object.entries(opts.config.providers)) {
    if (pc.kind === 'custom' && !preloaded[name]) preloaded[name] = await importCustomProvider(name, pc);
  }
  return createProviderRegistry({ ...opts, preloaded });
}

export async function importCustomProvider(name: string, pc: ProviderConfig): Promise<CustomProviderModule> {
  if (!pc.module) throw new EngineError('CONFIG_INVALID', `providers.${name}: kind "custom" requires "module"`);
  const file = path.isAbsolute(pc.module) ? pc.module : path.resolve(projectRoot(), pc.module);
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (e) {
    throw new EngineError('CONFIG_INVALID', `providers.${name}.module: cannot import ${file}: ${errorMessage(e)}`, undefined, e);
  }
  const create: unknown = isRecord(mod) ? mod['createProvider'] : undefined;
  if (typeof create !== 'function') throw new EngineError('CONFIG_INVALID', `providers.${name}.module (${file}) must export createProvider(args)`);
  return { createProvider: (args) => create(args) as LLMProvider };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isProvider(v: unknown): v is LLMProvider {
  return isRecord(v) && typeof v['name'] === 'string' && typeof v['complete'] === 'function' && isRecord(v['info']);
}
