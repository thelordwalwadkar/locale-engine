/**
 * Google Gemini API adapter. Targets @google/genai 2.24.0 (its .d.ts and ai.google.dev, 2026-09-30).
 *  - native -> `responseMimeType: 'application/json'` + `responseJsonSchema` (JSON Schema; the OpenAPI-style
 *    `responseSchema` is not used); json_mode -> `responseMimeType: 'application/json'` only.
 *  - Gemini 3: Google strongly recommends temperature 1.0 (lower values may loop or degrade), so providers.yaml lists
 *    temperature in `unsupported_params`; topP and seed are passed. `extra.reasoning_effort` -> `thinkingConfig.thinkingLevel`.
 *  - Text = the first candidate's non-thought text parts (the SDK's `.text` getter warns on mixed parts).
 *  - Usage: promptTokenCount includes cachedContentTokenCount; thoughtsTokenCount is billed as output.
 *  - finishReason MAX_TOKENS = truncated; SAFETY / RECITATION / BLOCKLIST / PROHIBITED_CONTENT / SPII / IMAGE_SAFETY or a
 *    blocked prompt -> CONTENT_FILTER. `ApiError` carries only the status, so a 429's RetryInfo.retryDelay is read from
 *    the JSON error body it wraps.
 *  - The key is passed explicitly (GOOGLE_API_KEY / GEMINI_API_KEY are not read implicitly), `vertexai: false`, and the
 *    SDK's own retries are off (`retryOptions.attempts: 1`) because base.ts owns retries.
 */
import { ApiError, GoogleGenAI, ThinkingLevel, type GenerateContentConfig, type GenerateContentParameters } from '@google/genai';
import { z } from 'zod';
import { ProviderError, type LLMProvider, type Usage } from '../schemas/index.js';
import {
  BaseProvider,
  httpError,
  reasoningEffort,
  toProviderError,
  usableEndpoint,
  type ClientInit,
  type ProviderFactoryArgs,
  type RawRequest,
  type RawResponse,
} from './base.js';

const LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
export type GeminiThinkingLevel = (typeof LEVELS)[number];
const THINKING: Record<GeminiThinkingLevel, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};
const FILTERED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

/** The part of a generateContent response the adapter reads (the SDK's `GenerateContentResponse` satisfies it). */
export interface GeminiResponseLike {
  candidates?: ReadonlyArray<{ content?: { parts?: ReadonlyArray<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
}

export interface GeminiClientLike {
  models: { generateContent(params: GenerateContentParameters): PromiseLike<GeminiResponseLike> };
}

export type GeminiClientFactory = (init: ClientInit) => GeminiClientLike;

export const defaultGeminiClient: GeminiClientFactory = (init) =>
  new GoogleGenAI({
    apiKey: init.apiKey,
    vertexai: false,
    httpOptions: { timeout: init.timeoutMs, retryOptions: { attempts: 1 }, ...(init.baseUrl ? { baseUrl: init.baseUrl } : {}) },
  });

export function buildGeminiRequest(req: RawRequest, modelId: string, level?: GeminiThinkingLevel): GenerateContentParameters {
  const config: GenerateContentConfig = { maxOutputTokens: req.params.max_tokens };
  if (req.system !== '') config.systemInstruction = req.system;
  if (req.params.temperature !== undefined) config.temperature = req.params.temperature;
  if (req.params.top_p !== undefined) config.topP = req.params.top_p;
  if (req.params.seed !== undefined) config.seed = req.params.seed;
  if (req.mode === 'native' && req.jsonSchema) {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = req.jsonSchema;
  } else if (req.mode === 'json_mode') {
    config.responseMimeType = 'application/json';
  }
  if (level) config.thinkingConfig = { thinkingLevel: THINKING[level] };
  if (req.signal) config.abortSignal = req.signal;
  return {
    model: modelId,
    contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    config,
  };
}

export function parseGeminiResponse(res: GeminiResponseLike, provider: string): RawResponse {
  const blocked = res.promptFeedback?.blockReason;
  if (blocked && blocked !== 'BLOCKED_REASON_UNSPECIFIED') {
    throw new ProviderError(`${provider}: the prompt was blocked (${blocked})`, 'CONTENT_FILTER', { provider, retryable: false });
  }
  const candidate = res.candidates?.[0];
  const finish = candidate?.finishReason;
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => p.thought !== true && typeof p.text === 'string')
    .map((p) => p.text ?? '')
    .join('');
  if (finish && FILTERED.has(finish)) {
    throw new ProviderError(`${provider}: output stopped by the safety filter (finishReason ${finish})`, 'CONTENT_FILTER', { provider, retryable: false, raw_text: text });
  }
  if (finish === 'LANGUAGE') {
    throw new ProviderError(`${provider}: the model stopped because it cannot handle the requested language (finishReason LANGUAGE)`, 'BAD_REQUEST', { provider, retryable: false });
  }
  const u = res.usageMetadata ?? {};
  const cached = u.cachedContentTokenCount ?? 0;
  const usage: Usage = {
    input_tokens: Math.max(0, (u.promptTokenCount ?? 0) - cached) + (u.toolUsePromptTokenCount ?? 0),
    output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    ...(cached > 0 ? { cached_input_tokens: cached } : {}),
  };
  return { text, usage, ...(finish ? { stop_reason: finish } : {}), truncated: finish === 'MAX_TOKENS' };
}

const GeminiErrorBodySchema = z.object({
  error: z.object({
    message: z.string().optional(),
    status: z.string().optional(),
    details: z.array(z.object({ retryDelay: z.string().optional() })).optional(),
  }),
});

/** `ApiError.message` is the JSON error body: `{error: {message, status, details: [{retryDelay: "30s"}]}}`. */
export function readGeminiErrorBody(raw: string): { message: string; retryAfterMs?: number } {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { message: raw };
  }
  const parsed = GeminiErrorBodySchema.safeParse(body);
  if (!parsed.success) return { message: raw };
  const { message, status, details } = parsed.data.error;
  const delay = details?.map((d) => d.retryDelay).find((d) => d !== undefined);
  const seconds = delay && /^\d+(?:\.\d+)?s$/.test(delay) ? Number.parseFloat(delay) : undefined;
  return {
    message: [status, message].filter(Boolean).join(': ') || raw,
    ...(seconds !== undefined ? { retryAfterMs: Math.round(seconds * 1000) } : {}),
  };
}

export function mapGeminiError(e: unknown, provider: string): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof ApiError) {
    const { message, retryAfterMs } = readGeminiErrorBody(e.message);
    return httpError(provider, e.status, message, { cause: e, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  }
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
    return new ProviderError(`${provider}: request timed out or was aborted`, 'TIMEOUT', { provider, cause: e });
  }
  // fetch() rejects with a TypeError ("fetch failed") when the connection cannot be made.
  if (e instanceof TypeError) return new ProviderError(`${provider}: network error: ${e.message}`, 'NETWORK', { provider, cause: e });
  return toProviderError(e, provider);
}

class GeminiProvider extends BaseProvider {
  protected override readonly kind = 'google' as const;
  protected override readonly schemaDialect = 'gemini' as const;
  private readonly client: GeminiClientLike;
  private readonly level: GeminiThinkingLevel | undefined;

  constructor(args: ProviderFactoryArgs<GeminiClientFactory>) {
    const ep = usableEndpoint(args);
    super(args, [ep.apiKey]);
    this.level = reasoningEffort(args.name, args.config, args.modelKey, LEVELS);
    const init: ClientInit = { apiKey: ep.apiKey ?? '', timeoutMs: args.config.timeout_ms, ...(ep.baseUrl ? { baseUrl: ep.baseUrl } : {}) };
    this.client = (args.clientFactory ?? defaultGeminiClient)(init);
  }

  protected override async rawComplete(req: RawRequest): Promise<RawResponse> {
    let res: GeminiResponseLike;
    try {
      res = await this.client.models.generateContent(buildGeminiRequest(req, this.model.id, this.level));
    } catch (e) {
      throw mapGeminiError(e, this.name);
    }
    return parseGeminiResponse(res, this.name);
  }
}

export function createProvider(args: ProviderFactoryArgs<GeminiClientFactory>): LLMProvider {
  return new GeminiProvider(args);
}
