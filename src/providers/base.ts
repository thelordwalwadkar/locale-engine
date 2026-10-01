/**
 * BaseProvider: the single implementation of `LLMProvider.complete()` (spec §6.2, §5.2 `edge_broken_json`, ARCHITECTURE P6).
 * Adapters implement one HTTP call (`rawComplete`) and name their JSON-Schema dialect; everything else lives here:
 *  - sampling parameters the model/API cannot take are dropped with PARAM_UNSUPPORTED (only when the caller set them); a
 *    4xx rejecting one that `unsupported_params` missed is handled the same way and remembered for the instance;
 *  - structured output per `structured_output`: native (sanitized schema sent to the vendor) or json_mode / prompted (schema
 *    appended to the system prompt), then `parseModelJson` + Zod validation + ONE repair retry;
 *  - a vendor rejecting native / JSON mode with a 4xx downgrades the instance to prompted (NATIVE_JSON_UNAVAILABLE);
 *  - transport retries with backoff and Retry-After for RATE_LIMIT / SERVER / NETWORK / TIMEOUT (SDK retries are off);
 *  - usage, cost and latency are summed over every attempt; credentials are redacted from error messages.
 */
import { z, type ZodType } from 'zod';
import {
  ProviderError,
  type LLMProvider,
  type Message,
  type ModelConfig,
  type Pricing,
  type ProviderConfig,
  type ProviderErrorCode,
  type ProviderInfo,
  type ProviderKind,
  type ProviderResult,
  type ProviderWarning,
  type StageParams,
  type StructuredOutputMode,
  type Usage,
} from '../schemas/index.js';
import { EngineError, errorMessage } from '../util/errors.js';
import { parseModelJson } from '../util/json.js';
import { parseRetryAfter, retry, sleep as realSleep } from '../util/retry.js';
import { sanitizeJsonSchema, UnsupportedSchemaError, type JsonSchema, type SchemaDialect } from './json-schema.js';

export type SamplingParam = 'temperature' | 'top_p' | 'seed';
const SAMPLING_PARAMS: readonly SamplingParam[] = ['temperature', 'top_p', 'seed'];

const TRANSIENT: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>(['RATE_LIMIT', 'SERVER', 'NETWORK', 'TIMEOUT']);
/** A Retry-After hint longer than this ends the retry loop instead of stalling the run. */
const MAX_RETRY_AFTER_MS = 60_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const MAX_REPORTED_ISSUES = 20;
/** 4xx messages that mean "this structured-output mode is not available" (spec: fall back to prompted). */
const STRUCTURED_OUTPUT_HINT = /schema|response_format|json_schema|json_object|structured|output_config|responseMimeType/i;
const NOT_SUPPORTED = /unsupported|not supported|does not support|only .*supported|not allowed|not permitted|cannot both|cannot be (?:used|specified|combined)/i;
/** Checked in this order: when a message names two parameters (e.g. "temperature and top_p cannot both be specified"), top_p goes first. */
const PARAM_PATTERNS: ReadonlyArray<[SamplingParam, RegExp]> = [
  ['top_p', /\btop_?p\b/i],
  ['seed', /\bseed\b/i],
  ['temperature', /\btemperature\b/i],
];

/** Name sent with native JSON schemas (OpenAI requires one: ^[a-zA-Z0-9_-]{1,64}$). */
export const RESPONSE_SCHEMA_NAME = 'response';

export interface ProviderFactoryArgs<ClientFactory = unknown> {
  /** Key in providers.yaml. */
  name: string;
  config: ProviderConfig;
  /** Key into `config.models`. */
  modelKey: string;
  /** Source of `api_key_env` / `base_url_env` values (never logged). */
  env: NodeJS.ProcessEnv;
  /** Builds the vendor client; tests pass a fake. The shape is adapter-specific. */
  clientFactory?: ClientFactory;
  /** Backoff sleeper (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface RawRequest {
  system: string;
  messages: Message[];
  /** Sampling parameters after filtering. */
  params: StageParams;
  /** Strategy of THIS attempt; `prompted` also covers plain-text calls without a schema. */
  mode: StructuredOutputMode;
  /** Sanitized JSON Schema, present only when `mode` is `native`. */
  jsonSchema?: JsonSchema;
  /** Aborts when `timeout_ms` elapses. */
  signal?: AbortSignal;
}

export interface RawResponse {
  text: string;
  usage: Usage;
  /** The vendor's own stop / finish reason. */
  stop_reason?: string;
  /** The stop reason means the output-token limit was hit. */
  truncated?: boolean;
}

/** NO_CREDENTIALS, listing what has to be set (environment variable names, never values). */
export class MissingCredentialsError extends ProviderError {
  readonly missing: readonly string[];

  constructor(message: string, provider: string, missing: readonly string[]) {
    super(message, 'NO_CREDENTIALS', { provider, retryable: false });
    this.missing = missing;
  }
}

/** A ProviderError carrying the server's Retry-After hint (read by `util/retry.ts`). */
export class TransportError extends ProviderError {
  readonly retryAfterMs?: number;

  constructor(message: string, code: ProviderErrorCode, details: { provider: string; status?: number; retryAfterMs?: number; cause?: unknown }) {
    super(message, code, details);
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
  }
}

export function codeForStatus(status: number | undefined): ProviderErrorCode {
  if (status === undefined) return 'UNKNOWN';
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 408) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'SERVER';
  if (status >= 400) return 'BAD_REQUEST';
  return 'UNKNOWN';
}

export function httpError(provider: string, status: number | undefined, message: string, opts: { retryAfterMs?: number; cause?: unknown } = {}): TransportError {
  return new TransportError(`${provider}: HTTP ${status ?? '?'}: ${message}`, codeForStatus(status), {
    provider,
    ...(status !== undefined ? { status } : {}),
    ...opts,
  });
}

/** `retry-after-ms` (OpenAI) or `retry-after` (seconds / HTTP date) in milliseconds. */
export function retryAfterFromHeaders(headers: { get(name: string): string | null } | null | undefined): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get('retry-after-ms');
  if (ms !== null && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  return parseRetryAfter(headers.get('retry-after'));
}

export function toProviderError(e: unknown, provider: string): ProviderError {
  if (e instanceof ProviderError) return e;
  return new ProviderError(`${provider}: ${errorMessage(e)}`, 'UNKNOWN', { provider, retryable: false, cause: e });
}

type ErrorClass<T> = abstract new (...args: never[]) => T;

/** Error classes of a Stainless-generated SDK (@anthropic-ai/sdk and openai share this hierarchy). */
export interface SdkErrorClasses {
  APIError: ErrorClass<Error & { status?: number | undefined; headers?: { get(name: string): string | null } | undefined }>;
  APIConnectionError: ErrorClass<Error>;
  APIConnectionTimeoutError: ErrorClass<Error>;
  APIUserAbortError: ErrorClass<Error>;
}

/** SDK error -> ProviderError. Subclasses are tested first: timeout/abort extend connection error, which extends APIError. */
export function mapSdkError(e: unknown, provider: string, sdk: SdkErrorClasses): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof sdk.APIConnectionTimeoutError || e instanceof sdk.APIUserAbortError) {
    return new ProviderError(`${provider}: request timed out or was aborted`, 'TIMEOUT', { provider, cause: e });
  }
  if (e instanceof sdk.APIConnectionError) return new ProviderError(`${provider}: network error: ${e.message}`, 'NETWORK', { provider, cause: e });
  if (e instanceof sdk.APIError) {
    const retryAfterMs = retryAfterFromHeaders(e.headers);
    return httpError(provider, e.status, e.message, { cause: e, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  }
  return toProviderError(e, provider);
}

// -- configuration helpers (shared with the registry) ------------------------------------------------------------

export function envValue(env: NodeJS.ProcessEnv, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const v = env[name]?.trim();
  return v ? v : undefined;
}

export interface ResolvedEndpoint {
  apiKey?: string;
  baseUrl?: string;
  /** What must be set before the provider is usable (e.g. `OPENAI_API_KEY`); empty = usable. */
  missing: string[];
}

/**
 * Credentials and base URL for a provider. anthropic/openai/google always need a key; openai_compatible and custom need one
 * only when `api_key_env` is configured (keyless local servers); ollama and mock never do. `base_url_env` overrides `base_url`.
 */
export function resolveEndpoint(config: ProviderConfig, env: NodeJS.ProcessEnv): ResolvedEndpoint {
  const apiKey = envValue(env, config.api_key_env);
  const baseUrl = envValue(env, config.base_url_env) ?? config.base_url;
  const missing: string[] = [];
  if (config.kind === 'anthropic' || config.kind === 'openai' || config.kind === 'google') {
    if (!apiKey) missing.push(config.api_key_env ?? 'api_key_env (not set in providers.yaml)');
  } else if ((config.kind === 'openai_compatible' || config.kind === 'custom') && config.api_key_env && !apiKey) {
    missing.push(config.api_key_env);
  }
  if (config.kind === 'openai_compatible' && !baseUrl) missing.push(config.base_url_env ? `${config.base_url_env} (or base_url)` : 'base_url');
  return { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}), missing };
}

/** The endpoint of a provider about to be constructed; throws MissingCredentialsError naming what to set. */
export function usableEndpoint(args: Pick<ProviderFactoryArgs, 'name' | 'config' | 'env'>): ResolvedEndpoint {
  const ep = resolveEndpoint(args.config, args.env);
  if (ep.missing.length > 0) {
    throw new MissingCredentialsError(`${args.name}: not configured, set ${ep.missing.join(', ')} in .env`, args.name, ep.missing);
  }
  return ep;
}

/** What an adapter's client factory receives. */
export interface ClientInit {
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
}

/** `config.extra[key]` validated with `schema`; undefined when absent. */
export function extraOption<T>(name: string, config: ProviderConfig, key: string, schema: ZodType<T>): T | undefined {
  const raw = config.extra?.[key];
  if (raw === undefined) return undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new EngineError('CONFIG_INVALID', `providers.${name}.extra.${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return parsed.data;
}

/** `extra.reasoning_effort: { <model key>: <level> }` — thinking / reasoning depth per model, in the adapter's vocabulary. */
export function reasoningEffort<T extends string>(name: string, config: ProviderConfig, modelKey: string, levels: readonly [T, ...T[]]): T | undefined {
  return extraOption(name, config, 'reasoning_effort', z.record(z.string(), z.enum(levels)))?.[modelKey];
}

// -- cost & usage -----------------------------------------------------------------------------------------------

/**
 * USD for `usage`: input × input price + cached input × cached price (the input price when none is configured, so a cost
 * ceiling never under-counts) + output × output price, all per 1M tokens. `input_tokens` EXCLUDES cache reads.
 */
export function costUsd(usage: Usage, pricing: Pricing | undefined): number | null {
  if (!pricing) return null;
  const cached = usage.cached_input_tokens ?? 0;
  return (
    (usage.input_tokens * pricing.input_per_mtok +
      cached * (pricing.cached_input_per_mtok ?? pricing.input_per_mtok) +
      usage.output_tokens * pricing.output_per_mtok) /
    1_000_000
  );
}

export function addUsage(a: Usage, b: Usage): Usage {
  const cached = (a.cached_input_tokens ?? 0) + (b.cached_input_tokens ?? 0);
  return { input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens, ...(cached ? { cached_input_tokens: cached } : {}) };
}

/** JSON Schema of what the model must RETURN (the Zod input side: defaults make fields optional). */
export function toJsonSchema(schema: ZodType): JsonSchema {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
}

// -- the provider ----------------------------------------------------------------------------------------------

interface CallState {
  attempts: number;
  usage: Usage;
  warnings: ProviderWarning[];
}

type Validation<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export abstract class BaseProvider implements LLMProvider {
  readonly name: string;
  protected readonly config: ProviderConfig;
  protected readonly modelKey: string;
  protected readonly model: ModelConfig;
  protected abstract readonly kind: ProviderKind;
  /** JSON-Schema subset the vendor accepts in native mode (json-schema.ts). */
  protected abstract readonly schemaDialect: SchemaDialect;
  private mode: StructuredOutputMode;
  /** Parameters the vendor rejected at run time although `unsupported_params` did not list them. */
  private readonly learnedUnsupported = new Set<SamplingParam>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly secrets: string[];

  protected constructor(args: ProviderFactoryArgs, secrets: ReadonlyArray<string | undefined> = []) {
    const model = args.config.models[args.modelKey];
    if (!model) {
      throw new EngineError('CONFIG_INVALID', `providers.${args.name}: unknown model key "${args.modelKey}" (known: ${Object.keys(args.config.models).join(', ')})`);
    }
    this.name = args.name;
    this.config = args.config;
    this.modelKey = args.modelKey;
    this.model = model;
    this.mode = model.structured_output;
    this.sleep = args.sleep ?? realSleep;
    this.secrets = secrets.filter((s): s is string => typeof s === 'string' && s.length >= 4);
  }

  /** `structured_output` reflects a downgrade to prompted once the vendor rejected native / JSON mode. */
  get info(): ProviderInfo {
    return { name: this.name, kind: this.kind, model_key: this.modelKey, model_id: this.model.id, structured_output: this.mode };
  }

  /** Exactly one HTTP call. Throw ProviderError with the right code / status / retryable; never retry here. */
  protected abstract rawComplete(req: RawRequest): Promise<RawResponse>;

  /** Sampling parameters the vendor API has no field for (merged with the model's `unsupported_params`). */
  protected unsupportedByApi(): readonly SamplingParam[] {
    return [];
  }

  /** Parameters that cannot be combined with the others the caller set (dropped with PARAM_UNSUPPORTED). */
  protected conflictingParams(_params: StageParams): readonly SamplingParam[] {
    return [];
  }

  async complete<T = unknown>(system: string, messages: Message[], params: StageParams, responseSchema?: ZodType<T>): Promise<ProviderResult<T>> {
    const started = performance.now();
    const call: CallState = { attempts: 0, usage: { input_tokens: 0, output_tokens: 0 }, warnings: [] };
    try {
      return await this.run(system, messages, params, responseSchema, call, started);
    } catch (e) {
      // Tokens spent by a call that then failed (invalid JSON twice, truncation, exhausted retries) still count toward the cost ceiling.
      if (e instanceof ProviderError && call.usage.input_tokens + call.usage.output_tokens > 0) {
        e.usage = call.usage;
        e.cost_usd = costUsd(call.usage, this.model.pricing);
        e.attempts = call.attempts;
      }
      throw e;
    }
  }

  private async run<T>(
    system: string,
    messages: Message[],
    params: StageParams,
    responseSchema: ZodType<T> | undefined,
    call: CallState,
    started: number,
  ): Promise<ProviderResult<T>> {
    const kept = this.filterParams(params, call.warnings);
    const full = responseSchema ? toJsonSchema(responseSchema) : undefined;
    let mode: StructuredOutputMode = full ? this.mode : 'prompted';
    let native: JsonSchema | undefined;
    if (full && mode === 'native') {
      try {
        native = sanitizeJsonSchema(full, this.schemaDialect);
      } catch (e) {
        if (!(e instanceof UnsupportedSchemaError)) throw e;
        call.warnings.push({ code: 'NATIVE_JSON_UNAVAILABLE', message: `${this.model.id}: ${e.message}; prompted mode for this call` });
        mode = 'prompted';
      }
    }
    const promptSchema = full ? JSON.stringify(sanitizeJsonSchema(full, 'prompt')) : undefined;

    const request = (m: StructuredOutputMode, msgs: Message[]): RawRequest => ({
      system: promptSchema !== undefined && m !== 'native' ? system + jsonInstruction(promptSchema, m) : system,
      messages: msgs,
      params: kept,
      mode: m,
      ...(m === 'native' && native ? { jsonSchema: native } : {}),
    });
    // Each pass either returns, throws, drops one sampling parameter or leaves native mode, so the loop terminates.
    const send = async (msgs: Message[]): Promise<RawResponse> => {
      for (;;) {
        try {
          return await this.attempt(request(mode, msgs), call);
        } catch (e) {
          const param = rejectedParam(e, kept);
          if (param) {
            call.warnings.push({
              code: 'PARAM_UNSUPPORTED',
              message: `${param}=${kept[param]} dropped: ${this.model.id} rejected it (${errorMessage(e)}); list it in unsupported_params`,
            });
            this.learnedUnsupported.add(param);
            delete kept[param];
            continue;
          }
          if (!full || mode === 'prompted' || !isStructuredOutputRejection(e)) throw e;
          call.warnings.push({
            code: 'NATIVE_JSON_UNAVAILABLE',
            message: `${this.model.id} rejected ${mode} structured output (${errorMessage(e)}); prompted mode from now on for this provider instance`,
          });
          mode = 'prompted';
          this.mode = 'prompted';
        }
      }
    };

    let res = await send(messages);
    if (!responseSchema) return this.finish<T>(res, null, call, started);
    let check = validate(res.text, responseSchema);
    if (!check.ok) {
      const extra = check.issues.length > 1 ? `, +${check.issues.length - 1} more` : '';
      call.warnings.push({ code: 'SCHEMA_RETRY', message: `response failed validation (${check.issues[0]}${extra}); retried once with a repair instruction` });
      const repair: Message[] = [
        ...messages,
        // An empty assistant turn is a 400 on some APIs, so a refusal-free empty answer is replaced by a marker.
        { role: 'assistant', content: res.text.trim() === '' ? '(empty response)' : res.text },
        { role: 'user', content: repairInstruction(check.issues, res.truncated === true) },
      ];
      res = await send(repair);
      check = validate(res.text, responseSchema);
      if (!check.ok) {
        const truncated = res.truncated === true;
        throw new ProviderError(
          `${this.name}: ${this.model.id} ${truncated ? 'output was truncated at max_tokens' : 'returned invalid JSON'} again after the repair retry: ` +
            `${check.issues.slice(0, 3).join('; ')}${truncated ? ' (lower batching.max_segments or raise max_tokens)' : ''}`,
          truncated ? 'TRUNCATED' : 'SCHEMA_INVALID',
          { provider: this.name, raw_text: res.text, retryable: false },
        );
      }
    }
    return this.finish(res, check.value, call, started);
  }

  private filterParams(params: StageParams, warnings: ProviderWarning[]): StageParams {
    const unsupported = new Set<SamplingParam>([...this.model.unsupported_params, ...this.unsupportedByApi(), ...this.learnedUnsupported]);
    const kept: StageParams = { ...params };
    for (const p of SAMPLING_PARAMS) {
      if (kept[p] === undefined || !unsupported.has(p)) continue;
      warnings.push({ code: 'PARAM_UNSUPPORTED', message: `${p}=${kept[p]} dropped: ${this.model.id} does not support it` });
      delete kept[p];
    }
    for (const p of this.conflictingParams(kept)) {
      if (kept[p] === undefined) continue;
      warnings.push({ code: 'PARAM_UNSUPPORTED', message: `${p}=${kept[p]} dropped: ${this.model.id} does not accept it together with the other sampling parameters` });
      delete kept[p];
    }
    return kept;
  }

  /** One logical request with transport retries; every HTTP attempt is counted, every response's usage summed. */
  private async attempt(req: RawRequest, call: CallState): Promise<RawResponse> {
    const res = await retry(
      async () => {
        call.attempts++;
        return this.oneHttpCall(req);
      },
      { retries: this.config.max_retries, baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS, sleep: this.sleep, shouldRetry: isTransient },
    );
    call.usage = addUsage(call.usage, res.usage);
    if (res.truncated) {
      call.warnings.push({ code: 'TRUNCATED_OUTPUT', message: `${this.model.id} stopped at max_tokens=${req.params.max_tokens} (stop reason ${res.stop_reason ?? 'unknown'})` });
    }
    return res;
  }

  private async oneHttpCall(req: RawRequest): Promise<RawResponse> {
    const signal = AbortSignal.timeout(this.config.timeout_ms);
    try {
      return await this.rawComplete({ ...req, signal });
    } catch (e) {
      const err =
        signal.aborted && !(e instanceof ProviderError && e.code === 'TIMEOUT')
          ? new ProviderError(`${this.name}: no response within timeout_ms=${this.config.timeout_ms}`, 'TIMEOUT', { provider: this.name, cause: e })
          : toProviderError(e, this.name);
      for (const s of this.secrets) if (err.message.includes(s)) err.message = err.message.split(s).join('[REDACTED]');
      throw err;
    }
  }

  private finish<T>(res: RawResponse, parsed: T | null, call: CallState, started: number): ProviderResult<T> {
    const pricing = this.model.pricing;
    const ref = `${this.name}:${this.modelKey}`;
    if (!pricing) call.warnings.push({ code: 'PRICING_UNKNOWN', message: `no pricing configured for ${ref} (${this.model.id}); cost_usd is null` });
    else if (!this.model.pricing_verified) call.warnings.push({ code: 'PRICING_UNVERIFIED', message: `pricing of ${ref} is not verified against the vendor's price page` });
    return {
      parsed,
      raw_text: res.text,
      usage: call.usage,
      latency_ms: Math.round(performance.now() - started),
      cost_usd: costUsd(call.usage, pricing),
      provider: this.name,
      model: this.model.id,
      attempts: call.attempts,
      warnings: call.warnings,
      ...(res.stop_reason !== undefined ? { stop_reason: res.stop_reason } : {}),
    };
  }
}

function isTransient(e: unknown): boolean {
  if (!(e instanceof ProviderError) || !e.retryable || !TRANSIENT.has(e.code)) return false;
  return !(e instanceof TransportError && e.retryAfterMs !== undefined && e.retryAfterMs > MAX_RETRY_AFTER_MS);
}

/** A 4xx rejecting a sampling parameter the caller sent: which one to drop (P6: never fail a call over a parameter). */
function rejectedParam(e: unknown, sent: StageParams): SamplingParam | undefined {
  if (!(e instanceof ProviderError) || e.code !== 'BAD_REQUEST' || !NOT_SUPPORTED.test(e.message)) return undefined;
  return PARAM_PATTERNS.find(([p, re]) => sent[p] !== undefined && re.test(e.message))?.[0];
}

function isStructuredOutputRejection(e: unknown): boolean {
  if (!(e instanceof ProviderError) || e.code !== 'BAD_REQUEST') return false;
  const aboutSampling = PARAM_PATTERNS.some(([, re]) => re.test(e.message));
  return STRUCTURED_OUTPUT_HINT.test(e.message) || (NOT_SUPPORTED.test(e.message) && !aboutSampling);
}

function jsonInstruction(schemaJson: string, mode: StructuredOutputMode): string {
  const where = mode === 'prompted' ? ' (when the instructions above ask for <thinking> and <final_answer>, put the JSON inside <final_answer>)' : '';
  return `\n\nRespond with JSON only${where}, matching this JSON Schema:\n${schemaJson}`;
}

function repairInstruction(issues: readonly string[], truncated: boolean): string {
  const why = truncated
    ? 'Your previous answer was cut off at the output token limit, so its JSON is incomplete.'
    : 'Your previous answer does not match the required JSON Schema.';
  const ask = `Return ONLY valid JSON matching the schema${truncated ? ', complete and as concise as the task allows' : ''}.`;
  return [why, 'Problems:', ...issues.map((i) => `- ${i}`), ask].join('\n');
}

function validate<T>(text: string, schema: ZodType<T>): Validation<T> {
  const json = parseModelJson(text);
  if (!json.ok) return { ok: false, issues: [`the response is not valid JSON (${json.error})`] };
  const r = schema.safeParse(json.value);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    issues: r.error.issues.slice(0, MAX_REPORTED_ISSUES).map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`),
  };
}
