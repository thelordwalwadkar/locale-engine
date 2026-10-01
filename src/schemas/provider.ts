/**
 * Provider contract (spec §6.2). Everything the pipeline knows about an LLM vendor is in this file:
 * swapping a provider never touches the pipeline (R1).
 */
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { Stage } from './common.js';
import type { ProviderKind, StructuredOutputMode } from './config.js';

export const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

/** Per-call sampling parameters (defaults come from `config/stages.yaml`). */
export const StageParamsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive(),
  seed: z.number().int().optional(),
});
export type StageParams = z.infer<typeof StageParamsSchema>;

/**
 * Token usage of one logical call, summed over all of its attempts (transport retries and the schema-repair retry).
 * `input_tokens` EXCLUDES cache reads; `cached_input_tokens` counts them. When a model has no cached-input price, cached tokens are billed at
 * the normal input price, so the cost ceiling never under-counts.
 */
export const UsageSchema = z.object({
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  cached_input_tokens: z.number().int().min(0).optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const PROVIDER_WARNING_CODES = [
  'PARAM_UNSUPPORTED', // a requested sampling parameter was dropped (spec §0.2)
  'NATIVE_JSON_UNAVAILABLE', // provider rejected native structured output; fell back to prompted mode
  'SCHEMA_RETRY', // first response failed schema validation; retried once with a repair instruction
  'TRUNCATED_OUTPUT', // stop reason indicates max_tokens was hit
  'PRICING_UNKNOWN', // no pricing configured for the model; cost_usd is null
  'PRICING_UNVERIFIED', // pricing configured but `pricing_verified: false`
] as const;
export type ProviderWarningCode = (typeof PROVIDER_WARNING_CODES)[number];

export interface ProviderWarning {
  code: ProviderWarningCode;
  message: string;
}

export interface ProviderResult<T = unknown> {
  /** Parsed and schema-validated object when a `responseSchema` was given, else null. */
  parsed: T | null;
  /** The model's raw text (of the final successful attempt). */
  raw_text: string;
  usage: Usage;
  /** Wall-clock milliseconds across ALL attempts of this call. */
  latency_ms: number;
  /** null when the model has no configured pricing. Sum across attempts. */
  cost_usd: number | null;
  /** Provider instance name (key in providers.yaml). */
  provider: string;
  /** Provider-side model id actually used. */
  model: string;
  /** HTTP/SDK attempts including the schema-repair retry (>= 1). */
  attempts: number;
  warnings: ProviderWarning[];
  stop_reason?: string;
}

export type ProviderErrorCode =
  | 'NO_CREDENTIALS'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'BAD_REQUEST'
  | 'SERVER'
  | 'SCHEMA_INVALID' // response could not be parsed/validated even after the single retry
  | 'CONTENT_FILTER'
  | 'TRUNCATED'
  | 'UNKNOWN';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;
  /** Raw model text, when the failure is about its content (SCHEMA_INVALID). */
  readonly raw_text?: string;
  /**
   * What the failed call already cost (e.g. SCHEMA_INVALID after two model calls, or a truncated answer). Filled in by the provider base class
   * so that the run's cost ceiling never under-counts failures. Absent when nothing was spent (auth error, no credentials).
   */
  usage?: Usage;
  cost_usd?: number | null;
  attempts?: number;

  constructor(
    message: string,
    code: ProviderErrorCode,
    details: { provider: string; status?: number; retryable?: boolean; raw_text?: string; cause?: unknown },
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = 'ProviderError';
    this.code = code;
    this.provider = details.provider;
    if (details.status !== undefined) this.status = details.status;
    this.retryable = details.retryable ?? (code === 'RATE_LIMIT' || code === 'TIMEOUT' || code === 'NETWORK' || code === 'SERVER');
    if (details.raw_text !== undefined) this.raw_text = details.raw_text;
  }
}

export interface ProviderInfo {
  /** Key in providers.yaml. */
  name: string;
  kind: ProviderKind;
  /** Key into the provider's `models`. */
  model_key: string;
  /** Provider-side model id. */
  model_id: string;
  /** How this model is asked for JSON; the pipeline picks the prompt's output contract from it. */
  structured_output: StructuredOutputMode;
}

/**
 * The one interface the pipeline depends on. Implementations:
 *  - use native structured output / JSON mode when `info.structured_output` says so, else instruct + parse + validate + ONE retry;
 *  - drop unsupported parameters and report them in `warnings` (PARAM_UNSUPPORTED) — never throw for them;
 *  - throw `ProviderError` only after their own retry policy is exhausted;
 *  - never log or return credentials.
 */
export interface LLMProvider {
  readonly name: string;
  readonly info: ProviderInfo;
  complete<T = unknown>(
    system: string,
    messages: Message[],
    params: StageParams,
    responseSchema?: ZodType<T>,
  ): Promise<ProviderResult<T>>;
}

/** Something the registry noticed while resolving providers; copied into the run log by the orchestrator. */
export interface RegistryNote {
  code: 'PROVIDER_FALLBACK' | 'JUDGE_NOT_INDEPENDENT' | 'PROVIDER_OVERRIDE' | 'PRICING_UNVERIFIED';
  message: string;
  stage?: Stage;
}

export interface ProviderDescription extends ProviderInfo {
  /** true when credentials (or a reachable local server config) are available. */
  configured: boolean;
  /** Pricing known? */
  has_pricing: boolean;
  pricing_verified: boolean;
}

/**
 * Resolves which provider/model serves which stage (routing + per-run overrides + fallback). Built by `providers/registry.ts`.
 * Missing credentials for a routed provider are NOT an error: the stage falls back to `routing.default_provider` and a
 * `PROVIDER_FALLBACK` note is recorded (graceful degradation, ARCHITECTURE P6).
 */
export interface ProviderRegistry {
  forStage(stage: Stage): LLMProvider;
  /** `provider` or `provider:model-key`. Throws ProviderError('NO_CREDENTIALS') if unusable. */
  get(ref: string): LLMProvider;
  describe(): ProviderDescription[];
  readonly notes: readonly RegistryNote[];
}
