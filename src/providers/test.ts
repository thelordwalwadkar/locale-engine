/**
 * `providers test` (spec Phase 2): one trivial schema-bound request per provider. Never throws: every failure becomes
 * `error`, and a provider without credentials is reported (`configured: false`) without any network call.
 */
import { z } from 'zod';
import type { LLMProvider, ProviderDescription, ProviderRegistry, ProviderTestResult } from '../schemas/index.js';
import { errorMessage } from '../util/errors.js';
import { MissingCredentialsError } from './base.js';

const ReplySchema = z.object({ ok: z.boolean(), echo: z.string() });
const SYSTEM = 'You are the connectivity check of a localization engine. Follow the instruction exactly.';
const PROMPT = 'Return a JSON object with "ok" set to true and "echo" set to the string "locale".';
/** Small, yet enough for models whose thinking cannot be switched off (Claude Opus 5.5, GPT-6) to still answer. */
const MAX_TOKENS = 1024;

/** `names`: provider names or `provider:model-key` refs; default: every configured provider (its default model). */
export async function testProviders(registry: ProviderRegistry, names?: string[]): Promise<ProviderTestResult[]> {
  const described = registry.describe();
  const refs = names && names.length > 0 ? names : [...new Set(described.filter((d) => d.configured).map((d) => d.name))];
  return Promise.all(refs.map((ref) => testOne(registry, ref, described)));
}

async function testOne(registry: ProviderRegistry, ref: string, described: ProviderDescription[]): Promise<ProviderTestResult> {
  const [name = ref, modelKey] = ref.split(':');
  // describe() lists each provider's default model first.
  const entry = described.find((d) => d.name === name && (modelKey === undefined || d.model_key === modelKey));
  const result: ProviderTestResult = {
    provider: name,
    model: entry?.model_id ?? '',
    configured: entry?.configured ?? false,
    ok: false,
    structured_output: entry?.structured_output ?? 'unknown',
    latency_ms: null,
    cost_usd: null,
    warnings: [],
    error: null,
  };
  let provider: LLMProvider;
  try {
    provider = registry.get(ref);
  } catch (e) {
    return { ...result, configured: e instanceof MissingCredentialsError ? false : result.configured, error: e instanceof MissingCredentialsError ? `missing ${e.missing.join(', ')}` : errorMessage(e) };
  }
  const started = performance.now();
  try {
    const r = await provider.complete(SYSTEM, [{ role: 'user', content: PROMPT }], { max_tokens: MAX_TOKENS, temperature: 0 }, ReplySchema);
    const ok = r.parsed?.ok === true;
    const warnings: string[] = r.warnings.map((w) => w.code);
    if (r.parsed?.echo !== 'locale') warnings.push('ECHO_MISMATCH');
    return {
      ...result,
      model: r.model,
      configured: true,
      ok,
      structured_output: provider.info.structured_output,
      latency_ms: r.latency_ms,
      cost_usd: r.cost_usd,
      warnings,
      error: ok ? null : 'the model did not answer "ok": true',
    };
  } catch (e) {
    return {
      ...result,
      model: provider.info.model_id,
      configured: true,
      structured_output: provider.info.structured_output,
      latency_ms: Math.round(performance.now() - started),
      error: errorMessage(e),
    };
  }
}
