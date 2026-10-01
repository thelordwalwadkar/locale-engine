/**
 * Generic OpenAI-compatible adapter (DeepSeek, Mistral, Groq, OpenRouter, Together, vLLM, …): Chat Completions through the
 * openai SDK 7.25.0 with `baseURL` from providers.yaml. Each vendor is its own provider name with `kind: openai_compatible`.
 *  - native -> `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }` (the shape Groq,
 *    Together, OpenRouter, Mistral and vLLM accept); json_mode -> `{ type: 'json_object' }`. A vendor rejecting either
 *    triggers base.ts's prompted fallback.
 *  - `max_tokens` rather than `max_completion_tokens`: it is the field every compatible server accepts. temperature, top_p
 *    and seed are passed as given (drop them per model with `unsupported_params`). `extra.reasoning_effort` ->
 *    `reasoning_effort`; `extra.extra_body` holds vendor-specific request fields merged into every request.
 *  - Usage: cached prompt tokens from `prompt_tokens_details.cached_tokens` or DeepSeek's `prompt_cache_hit_tokens`.
 *  - `api_key_env` may be omitted for keyless local servers; the SDK then gets a placeholder key.
 */
import type OpenAI from 'openai';
import { z } from 'zod';
import { ProviderError, type LLMProvider, type Usage } from '../schemas/index.js';
import {
  BaseProvider,
  extraOption,
  reasoningEffort,
  RESPONSE_SCHEMA_NAME,
  usableEndpoint,
  type ClientInit,
  type ProviderFactoryArgs,
  type RawRequest,
  type RawResponse,
} from './base.js';
import { mapOpenAIError, newOpenAIClient } from './openai.js';

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type CompatEffort = (typeof EFFORTS)[number];
/** Sent when a keyless local server (vLLM, llama.cpp) is configured without `api_key_env`. */
const PLACEHOLDER_KEY = 'not-needed';

type ChatParams = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

/** The part of a Chat Completions response the adapter reads (the SDK's `ChatCompletion` satisfies it). */
export interface ChatCompletionLike {
  choices: ReadonlyArray<{ finish_reason: string | null; message: { content: string | null; refusal?: string | null } }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    prompt_cache_hit_tokens?: number;
  } | null;
}

export interface ChatClientLike {
  chat: { completions: { create(body: ChatParams, options?: { signal?: AbortSignal }): PromiseLike<ChatCompletionLike> } };
}

export type ChatClientFactory = (init: ClientInit) => ChatClientLike;

export const defaultChatClient: ChatClientFactory = newOpenAIClient;

export interface ChatRequestOptions {
  effort?: CompatEffort;
  extraBody?: Record<string, unknown>;
}

export function buildChatRequest(req: RawRequest, modelId: string, opts: ChatRequestOptions = {}): ChatParams {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (req.system !== '') messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) messages.push({ role: m.role, content: m.content });
  const body: ChatParams = { model: modelId, messages, max_tokens: req.params.max_tokens };
  if (req.params.temperature !== undefined) body.temperature = req.params.temperature;
  if (req.params.top_p !== undefined) body.top_p = req.params.top_p;
  if (req.params.seed !== undefined) body.seed = req.params.seed;
  if (req.mode === 'native' && req.jsonSchema) {
    body.response_format = { type: 'json_schema', json_schema: { name: RESPONSE_SCHEMA_NAME, schema: req.jsonSchema, strict: true } };
  } else if (req.mode === 'json_mode') {
    body.response_format = { type: 'json_object' };
  }
  if (opts.effort) body.reasoning_effort = opts.effort;
  // Vendor fields first, so they can never override the fields above.
  return opts.extraBody ? ({ ...opts.extraBody, ...body } as ChatParams) : body;
}

export function parseChatCompletion(res: ChatCompletionLike, provider: string): RawResponse {
  const choice = res.choices[0];
  if (!choice) throw new ProviderError(`${provider}: the response has no choices`, 'SERVER', { provider });
  const text = choice.message.content ?? '';
  if (choice.message.refusal) {
    throw new ProviderError(`${provider}: the model refused: ${choice.message.refusal}`, 'CONTENT_FILTER', { provider, retryable: false, raw_text: text });
  }
  if (choice.finish_reason === 'content_filter') {
    throw new ProviderError(`${provider}: output stopped by the content filter`, 'CONTENT_FILTER', { provider, retryable: false, raw_text: text });
  }
  const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? res.usage?.prompt_cache_hit_tokens ?? 0;
  const usage: Usage = {
    input_tokens: Math.max(0, (res.usage?.prompt_tokens ?? 0) - cached),
    output_tokens: res.usage?.completion_tokens ?? 0,
    ...(cached > 0 ? { cached_input_tokens: cached } : {}),
  };
  const stop = choice.finish_reason ?? undefined;
  return { text, usage, ...(stop ? { stop_reason: stop } : {}), truncated: stop === 'length' };
}

class OpenAICompatibleProvider extends BaseProvider {
  protected override readonly kind = 'openai_compatible' as const;
  protected override readonly schemaDialect = 'openai' as const;
  private readonly client: ChatClientLike;
  private readonly options: ChatRequestOptions;

  constructor(args: ProviderFactoryArgs<ChatClientFactory>) {
    const ep = usableEndpoint(args);
    super(args, [ep.apiKey]);
    const effort = reasoningEffort(args.name, args.config, args.modelKey, EFFORTS);
    const extraBody = extraOption(args.name, args.config, 'extra_body', z.record(z.string(), z.unknown()));
    this.options = { ...(effort ? { effort } : {}), ...(extraBody ? { extraBody } : {}) };
    const init: ClientInit = { apiKey: ep.apiKey ?? PLACEHOLDER_KEY, timeoutMs: args.config.timeout_ms, ...(ep.baseUrl ? { baseUrl: ep.baseUrl } : {}) };
    this.client = (args.clientFactory ?? defaultChatClient)(init);
  }

  protected override async rawComplete(req: RawRequest): Promise<RawResponse> {
    let res: ChatCompletionLike;
    try {
      res = await this.client.chat.completions.create(buildChatRequest(req, this.model.id, this.options), req.signal ? { signal: req.signal } : {});
    } catch (e) {
      throw mapOpenAIError(e, this.name);
    }
    return parseChatCompletion(res, this.name);
  }
}

export function createProvider(args: ProviderFactoryArgs<ChatClientFactory>): LLMProvider {
  return new OpenAICompatibleProvider(args);
}
