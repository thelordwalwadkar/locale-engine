/**
 * Anthropic Messages API adapter. Targets @anthropic-ai/sdk 0.129.0 (its .d.ts and the claude-api skill, 2026-09-30).
 *  - native: `output_config.format = { type: 'json_schema', schema }` (structured outputs on Claude Opus 5.5, Sonnet 5.5,
 *    Haiku 4.5, …; the deprecated top-level `output_format` is not used). The Messages API has no JSON mode, so json_mode
 *    is sent like prompted. `messages.parse()` is not used: base.ts validates with the pipeline's own Zod schemas.
 *  - Sampling: models released after Claude Opus 4.6 reject non-default temperature / top_p (400) -> `unsupported_params`
 *    in providers.yaml; Claude 4.x rejects temperature together with top_p -> top_p is dropped when both are set; the API
 *    has no seed. Thinking stays at the model default (always-on adaptive on Opus 5.5); `extra.reasoning_effort`
 *    maps to `output_config.effort`. Only `text` blocks are read.
 *  - Usage: `input_tokens` excludes cache reads (-> cached_input_tokens); cache writes are counted as input.
 *  - Stop reasons: `max_tokens` / `model_context_window_exceeded` = truncated; `refusal` -> CONTENT_FILTER.
 *  - The key is passed explicitly with `authToken: null` and a `baseURL` from providers.yaml only, so ANTHROPIC_AUTH_TOKEN,
 *    ANTHROPIC_BASE_URL and CLI profiles are never used implicitly; `maxRetries: 0` because base.ts owns retries.
 */
import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { ProviderError, type LLMProvider, type StageParams, type Usage } from '../schemas/index.js';
import {
  BaseProvider,
  mapSdkError,
  reasoningEffort,
  usableEndpoint,
  type ClientInit,
  type ProviderFactoryArgs,
  type RawRequest,
  type RawResponse,
  type SamplingParam,
} from './base.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AnthropicEffort = (typeof EFFORTS)[number];

/** The part of a Messages API response the adapter reads (the SDK's `Message` satisfies it). */
export interface AnthropicMessageLike {
  content: ReadonlyArray<{ type: string; text?: string }>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
}

export interface AnthropicClientLike {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): PromiseLike<AnthropicMessageLike>;
  };
}

export type AnthropicClientFactory = (init: ClientInit) => AnthropicClientLike;

export const defaultAnthropicClient: AnthropicClientFactory = (init) =>
  new Anthropic({ apiKey: init.apiKey, authToken: null, baseURL: init.baseUrl ?? null, timeout: init.timeoutMs, maxRetries: 0 });

export function buildAnthropicRequest(req: RawRequest, modelId: string, effort?: AnthropicEffort): Anthropic.MessageCreateParamsNonStreaming {
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model: modelId,
    max_tokens: req.params.max_tokens,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (req.system !== '') body.system = req.system;
  if (req.params.temperature !== undefined) body.temperature = req.params.temperature;
  if (req.params.top_p !== undefined) body.top_p = req.params.top_p;
  const output: Anthropic.OutputConfig = {};
  if (req.mode === 'native' && req.jsonSchema) output.format = { type: 'json_schema', schema: req.jsonSchema };
  if (effort) output.effort = effort;
  if (output.format || output.effort) body.output_config = output;
  return body;
}

export function parseAnthropicMessage(msg: AnthropicMessageLike, provider: string): RawResponse {
  const text = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  const stop = msg.stop_reason ?? undefined;
  if (stop === 'refusal') {
    throw new ProviderError(`${provider}: the model declined the request (stop_reason refusal)`, 'CONTENT_FILTER', { provider, retryable: false, raw_text: text });
  }
  const cached = msg.usage.cache_read_input_tokens ?? 0;
  const usage: Usage = {
    input_tokens: msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0),
    output_tokens: msg.usage.output_tokens,
    ...(cached > 0 ? { cached_input_tokens: cached } : {}),
  };
  return { text, usage, ...(stop ? { stop_reason: stop } : {}), truncated: stop === 'max_tokens' || stop === 'model_context_window_exceeded' };
}

export function mapAnthropicError(e: unknown, provider: string): ProviderError {
  return mapSdkError(e, provider, { APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError });
}

class AnthropicProvider extends BaseProvider {
  protected override readonly kind = 'anthropic' as const;
  protected override readonly schemaDialect = 'anthropic' as const;
  private readonly client: AnthropicClientLike;
  private readonly effort: AnthropicEffort | undefined;

  constructor(args: ProviderFactoryArgs<AnthropicClientFactory>) {
    const ep = usableEndpoint(args);
    super(args, [ep.apiKey]);
    this.effort = reasoningEffort(args.name, args.config, args.modelKey, EFFORTS);
    const init: ClientInit = { apiKey: ep.apiKey ?? '', timeoutMs: args.config.timeout_ms, ...(ep.baseUrl ? { baseUrl: ep.baseUrl } : {}) };
    this.client = (args.clientFactory ?? defaultAnthropicClient)(init);
  }

  protected override unsupportedByApi(): readonly SamplingParam[] {
    return ['seed'];
  }

  protected override conflictingParams(params: StageParams): readonly SamplingParam[] {
    return params.temperature !== undefined && params.top_p !== undefined ? ['top_p'] : [];
  }

  protected override async rawComplete(req: RawRequest): Promise<RawResponse> {
    let msg: AnthropicMessageLike;
    try {
      msg = await this.client.messages.create(buildAnthropicRequest(req, this.model.id, this.effort), req.signal ? { signal: req.signal } : {});
    } catch (e) {
      throw mapAnthropicError(e, this.name);
    }
    return parseAnthropicMessage(msg, this.name);
  }
}

export function createProvider(args: ProviderFactoryArgs<AnthropicClientFactory>): LLMProvider {
  return new AnthropicProvider(args);
}
