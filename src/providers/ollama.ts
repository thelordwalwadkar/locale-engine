/**
 * Ollama adapter over its REST API (`POST /api/chat`) with fetch. The request shape is typed with the `ollama` package
 * (0.6.4), but its client is not used: its non-streaming chat() takes no AbortSignal (per-request timeouts would need a
 * custom fetch anyway) and its error path writes to the console. Local models: no key, no per-token cost.
 *  - native -> `format: <JSON Schema>` (Ollama structured outputs); json_mode -> `format: 'json'`.
 *  - Sampling through `options`: temperature, top_p, seed, num_predict (= max_tokens). `extra.reasoning_effort` -> `think`
 *    (`off` / `on` / `low` / `medium` / `high`); `extra.keep_alive` is passed through.
 *  - Usage from prompt_eval_count / eval_count; done_reason `length` = truncated.
 *  - Base URL: `base_url_env` (OLLAMA_HOST) over `base_url`; a bare `host[:port]` gets `http://` and port 11434, and the
 *    bind-all address 0.0.0.0 is contacted as 127.0.0.1. An optional `api_key_env` is sent as a Bearer token (proxies).
 */
import type { ChatRequest } from 'ollama';
import { z } from 'zod';
import { ProviderError, type LLMProvider, type Usage } from '../schemas/index.js';
import { errorMessage } from '../util/errors.js';
import {
  BaseProvider,
  extraOption,
  httpError,
  reasoningEffort,
  retryAfterFromHeaders,
  usableEndpoint,
  type ProviderFactoryArgs,
  type RawRequest,
  type RawResponse,
} from './base.js';

const THINK_LEVELS = ['off', 'on', 'low', 'medium', 'high'] as const;
type ThinkLevel = (typeof THINK_LEVELS)[number];
const DEFAULT_HOST = 'http://127.0.0.1:11434';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OllamaRequestOptions {
  think?: ChatRequest['think'];
  keepAlive?: string | number;
}

/** OLLAMA_HOST-style value -> base URL without a trailing slash. */
export function normalizeOllamaHost(host: string): string {
  const raw = host.trim();
  const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const url = new URL(explicit ? raw : `http://${raw}`);
  if (!explicit && url.port === '') url.port = '11434';
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  return url.toString().replace(/\/+$/, '');
}

export function buildOllamaRequest(req: RawRequest, modelId: string, opts: OllamaRequestOptions = {}): ChatRequest & { stream: false } {
  const options: NonNullable<ChatRequest['options']> = { num_predict: req.params.max_tokens };
  if (req.params.temperature !== undefined) options.temperature = req.params.temperature;
  if (req.params.top_p !== undefined) options.top_p = req.params.top_p;
  if (req.params.seed !== undefined) options.seed = req.params.seed;
  const body: ChatRequest & { stream: false } = {
    model: modelId,
    stream: false,
    messages: [...(req.system !== '' ? [{ role: 'system', content: req.system }] : []), ...req.messages.map((m) => ({ role: m.role, content: m.content }))],
    options,
  };
  if (req.mode === 'native' && req.jsonSchema) body.format = req.jsonSchema;
  else if (req.mode === 'json_mode') body.format = 'json';
  if (opts.think !== undefined) body.think = opts.think;
  if (opts.keepAlive !== undefined) body.keep_alive = opts.keepAlive;
  return body;
}

const ChatResponseSchema = z.object({
  message: z.object({ content: z.string().optional() }).optional(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

export function parseOllamaResponse(json: unknown, provider: string): RawResponse {
  const parsed = ChatResponseSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError(`${provider}: unexpected /api/chat response shape`, 'SERVER', { provider });
  const r = parsed.data;
  const usage: Usage = { input_tokens: r.prompt_eval_count ?? 0, output_tokens: r.eval_count ?? 0 };
  return { text: r.message?.content ?? '', usage, ...(r.done_reason ? { stop_reason: r.done_reason } : {}), truncated: r.done_reason === 'length' };
}

function thinkValue(level: ThinkLevel | undefined): ChatRequest['think'] {
  if (level === undefined) return undefined;
  if (level === 'off') return false;
  if (level === 'on') return true;
  return level;
}

class OllamaProvider extends BaseProvider {
  protected override readonly kind = 'ollama' as const;
  protected override readonly schemaDialect = 'ollama' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: FetchLike;
  private readonly options: OllamaRequestOptions;

  constructor(args: ProviderFactoryArgs<FetchLike>) {
    const ep = usableEndpoint(args);
    super(args, [ep.apiKey]);
    this.baseUrl = normalizeOllamaHost(ep.baseUrl ?? DEFAULT_HOST);
    this.apiKey = ep.apiKey;
    this.fetchFn = args.clientFactory ?? ((url, init) => fetch(url, init));
    const think = thinkValue(reasoningEffort(args.name, args.config, args.modelKey, THINK_LEVELS));
    const keepAlive = extraOption(args.name, args.config, 'keep_alive', z.union([z.string(), z.number()]));
    this.options = { ...(think !== undefined ? { think } : {}), ...(keepAlive !== undefined ? { keepAlive } : {}) };
  }

  protected override async rawComplete(req: RawRequest): Promise<RawResponse> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
    let response: Response;
    let body: string;
    try {
      response = await this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildOllamaRequest(req, this.model.id, this.options)),
        ...(req.signal ? { signal: req.signal } : {}),
      });
      body = await response.text();
    } catch (e) {
      throw new ProviderError(`${this.name}: cannot reach Ollama at ${this.baseUrl} (${errorMessage(e)}); is "ollama serve" running?`, 'NETWORK', {
        provider: this.name,
        cause: e,
      });
    }
    if (!response.ok) {
      const retryAfterMs = retryAfterFromHeaders(response.headers);
      throw httpError(this.name, response.status, readOllamaError(body) ?? (response.statusText || 'request failed'), {
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new ProviderError(`${this.name}: Ollama returned a body that is not JSON`, 'SERVER', { provider: this.name });
    }
    return parseOllamaResponse(json, this.name);
  }
}

function readOllamaError(body: string): string | undefined {
  try {
    const parsed = z.object({ error: z.string() }).safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.error : body.trim() || undefined;
  } catch {
    return body.trim() || undefined;
  }
}

export function createProvider(args: ProviderFactoryArgs<FetchLike>): LLMProvider {
  return new OllamaProvider(args);
}
