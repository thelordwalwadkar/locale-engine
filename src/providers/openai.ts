/**
 * OpenAI adapter on the Responses API. Targets openai 7.25.0 (its .d.ts and developers.openai.com, 2026-09-30).
 * Why Responses rather than Chat Completions: OpenAI's GPT-6 guide recommends it and it serves every OpenAI model
 * (the -pro models exist only there); strict structured output is `text.format: { type: 'json_schema', strict: true }`;
 * truncation and filtering arrive as explicit `status: 'incomplete'` + `incomplete_details.reason`, refusals as typed
 * `refusal` parts. OpenAI-compatible third-party servers implement Chat Completions, so openai_compatible.ts uses that.
 *  - json_mode -> `text.format: { type: 'json_object' }` (schema in the prompt). `store: false`: no server-side retention.
 *  - GPT-6 models reject temperature / top_p unless reasoning effort is `none` -> `unsupported_params` in providers.yaml;
 *    the Responses API has no seed. `extra.reasoning_effort` -> `reasoning.effort`.
 *  - Usage: `input_tokens` includes cached tokens; they are split out into cached_input_tokens.
 *  - Assistant messages labelled `phase: 'commentary'` are ignored when a `final_answer` message exists.
 *  - The key is passed explicitly; organization / project / admin key and OPENAI_BASE_URL are never read from the
 *    environment implicitly; `maxRetries: 0` because base.ts owns retries.
 */
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { ProviderError, type LLMProvider, type Usage } from '../schemas/index.js';
import {
  BaseProvider,
  mapSdkError,
  reasoningEffort,
  RESPONSE_SCHEMA_NAME,
  usableEndpoint,
  type ClientInit,
  type ProviderFactoryArgs,
  type RawRequest,
  type RawResponse,
  type SamplingParam,
} from './base.js';

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type OpenAIEffort = (typeof EFFORTS)[number];

type ResponseParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;

/** The part of a Responses API response the adapter reads (the SDK's `Response` satisfies it). */
export interface OpenAIResponseLike {
  status?: string | null;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output: readonly unknown[];
  usage?: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } | null } | null;
}

export interface OpenAIClientLike {
  responses: { create(body: ResponseParams, options?: { signal?: AbortSignal }): PromiseLike<OpenAIResponseLike> };
}

export type OpenAIClientFactory = (init: ClientInit) => OpenAIClientLike;

/** Also used by openai_compatible.ts: nothing but the explicit options configures the client. */
export function newOpenAIClient(init: ClientInit): OpenAI {
  return new OpenAI({
    apiKey: init.apiKey,
    baseURL: init.baseUrl ?? null,
    organization: null,
    project: null,
    adminAPIKey: null,
    timeout: init.timeoutMs,
    maxRetries: 0,
  });
}

export const defaultOpenAIClient: OpenAIClientFactory = newOpenAIClient;

export function buildOpenAIRequest(req: RawRequest, modelId: string, effort?: OpenAIEffort): ResponseParams {
  const body: ResponseParams = {
    model: modelId,
    input: req.messages.map((m) => ({ role: m.role, content: m.content })),
    max_output_tokens: req.params.max_tokens,
    store: false,
  };
  if (req.system !== '') body.instructions = req.system;
  if (req.params.temperature !== undefined) body.temperature = req.params.temperature;
  if (req.params.top_p !== undefined) body.top_p = req.params.top_p;
  if (req.mode === 'native' && req.jsonSchema) {
    body.text = { format: { type: 'json_schema', name: RESPONSE_SCHEMA_NAME, schema: req.jsonSchema, strict: true } };
  } else if (req.mode === 'json_mode') {
    body.text = { format: { type: 'json_object' } };
  }
  if (effort) body.reasoning = { effort };
  return body;
}

interface OutputPart {
  type: string;
  text?: string;
  refusal?: string;
}
interface OutputMessage {
  type: 'message';
  phase?: string | null;
  content: OutputPart[];
}

function isOutputMessage(item: unknown): item is OutputMessage {
  return typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'message' && Array.isArray((item as { content?: unknown }).content);
}

export function parseOpenAIResponse(res: OpenAIResponseLike, provider: string): RawResponse {
  const messages = res.output.filter(isOutputMessage);
  const finals = messages.filter((m) => m.phase === 'final_answer');
  const parts = (finals.length > 0 ? finals : messages).flatMap((m) => m.content);
  const text = parts
    .filter((p) => p.type === 'output_text')
    .map((p) => p.text ?? '')
    .join('');
  const refusal = parts.find((p) => p.type === 'refusal');
  if (refusal) {
    throw new ProviderError(`${provider}: the model refused: ${refusal.refusal ?? ''}`.trim(), 'CONTENT_FILTER', { provider, retryable: false, raw_text: text });
  }
  if (res.status === 'failed') {
    throw new ProviderError(`${provider}: response failed: ${res.error?.message ?? 'no error detail'}`, 'SERVER', { provider });
  }
  const reason = res.incomplete_details?.reason;
  if (res.status === 'incomplete' && reason === 'content_filter') {
    throw new ProviderError(`${provider}: output stopped by the content filter`, 'CONTENT_FILTER', { provider, retryable: false, raw_text: text });
  }
  const cached = res.usage?.input_tokens_details?.cached_tokens ?? 0;
  const usage: Usage = {
    input_tokens: Math.max(0, (res.usage?.input_tokens ?? 0) - cached),
    output_tokens: res.usage?.output_tokens ?? 0,
    ...(cached > 0 ? { cached_input_tokens: cached } : {}),
  };
  const stop = res.status === 'incomplete' ? `incomplete:${reason ?? 'unknown'}` : (res.status ?? undefined);
  return { text, usage, ...(stop ? { stop_reason: stop } : {}), truncated: res.status === 'incomplete' && reason === 'max_output_tokens' };
}

export function mapOpenAIError(e: unknown, provider: string): ProviderError {
  return mapSdkError(e, provider, { APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError });
}

class OpenAIProvider extends BaseProvider {
  protected override readonly kind = 'openai' as const;
  protected override readonly schemaDialect = 'openai' as const;
  private readonly client: OpenAIClientLike;
  private readonly effort: OpenAIEffort | undefined;

  constructor(args: ProviderFactoryArgs<OpenAIClientFactory>) {
    const ep = usableEndpoint(args);
    super(args, [ep.apiKey]);
    this.effort = reasoningEffort(args.name, args.config, args.modelKey, EFFORTS);
    const init: ClientInit = { apiKey: ep.apiKey ?? '', timeoutMs: args.config.timeout_ms, ...(ep.baseUrl ? { baseUrl: ep.baseUrl } : {}) };
    this.client = (args.clientFactory ?? defaultOpenAIClient)(init);
  }

  protected override unsupportedByApi(): readonly SamplingParam[] {
    return ['seed'];
  }

  protected override async rawComplete(req: RawRequest): Promise<RawResponse> {
    let res: OpenAIResponseLike;
    try {
      res = await this.client.responses.create(buildOpenAIRequest(req, this.model.id, this.effort), req.signal ? { signal: req.signal } : {});
    } catch (e) {
      throw mapOpenAIError(e, this.name);
    }
    return parseOpenAIResponse(res, this.name);
  }
}

export function createProvider(args: ProviderFactoryArgs<OpenAIClientFactory>): LLMProvider {
  return new OpenAIProvider(args);
}
