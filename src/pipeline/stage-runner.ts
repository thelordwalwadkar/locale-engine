/**
 * The single place where the pipeline talks to providers: resolves the provider of a stage, enforces the cost ceiling BEFORE the call,
 * renders the system prompt for the provider's output mode, records tokens / cost / latency, and copies warnings into the run log.
 */
import type { ZodType } from 'zod';
import type { CallRecord, LocaleCode, ProviderRegistry, Stage, StageBinding, StagesConfig } from '../schemas/index.js';
import { ProviderError } from '../schemas/provider.js';
import type { LLMProvider, StageParams } from '../schemas/provider.js';
import type { CostTracker } from '../telemetry/cost.js';
import type { RunLog } from '../telemetry/run-log.js';
import { EngineError, errorMessage } from '../util/errors.js';
import { outputModeFor } from './prompt.js';
import type { OutputMode } from './prompt.js';

export interface StageCall<T> {
  stage: Stage;
  locale: LocaleCode | null;
  /** Number of segments in the payload (reporting only). */
  segments: number;
  segmentIds?: string[];
  /** Renders the system prompt for the provider's output mode. */
  system: (mode: OutputMode) => string;
  payload: object;
  schema: ZodType<T>;
}

export class StageRunner {
  private seq = 0;

  constructor(
    private readonly deps: {
      registry: ProviderRegistry;
      stages: StagesConfig;
      costs: CostTracker;
      log: RunLog;
      now: () => Date;
    },
  ) {}

  providerFor(stage: Stage): LLMProvider {
    return this.deps.registry.forStage(stage);
  }

  binding(stage: Stage): StageBinding {
    const info = this.providerFor(stage).info;
    return { provider: info.name, model: info.model_id };
  }

  async call<T>(c: StageCall<T>): Promise<T> {
    const { costs, log, stages } = this.deps;
    costs.assertBudget();
    const provider = this.providerFor(c.stage);
    const cfg = stages.stages[c.stage];
    const params: StageParams = { temperature: cfg.temperature, top_p: cfg.top_p, max_tokens: cfg.max_tokens };
    const system = c.system(outputModeFor(provider.info.structured_output));
    const callId = `call_${String(++this.seq).padStart(4, '0')}`;
    const base = { stage: c.stage, ...(c.locale ? { locale: c.locale } : {}), provider: provider.info.name };

    try {
      const res = await provider.complete(system, [{ role: 'user', content: JSON.stringify(c.payload) }], params, c.schema);
      const record: CallRecord = {
        call_id: callId,
        ts: this.deps.now().toISOString(),
        stage: c.stage,
        locale: c.locale,
        provider: res.provider,
        model: res.model,
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
        cost_usd: res.cost_usd,
        latency_ms: res.latency_ms,
        attempts: res.attempts,
        ok: true,
        segments: c.segments,
        warnings: res.warnings.map((w) => w.code),
      };
      costs.record(record);
      for (const w of res.warnings) {
        log.warn({ ...base, code: w.code, message: w.message, ...(c.segmentIds ? { data: { segment_ids: c.segmentIds } } : {}) });
      }
      if (res.attempts > 1) log.info({ ...base, code: 'RETRY', message: `${res.attempts} attempts for one call`, data: { call_id: callId } });
      if (res.parsed === null) {
        throw new ProviderError('provider returned no parsed object for a schema-bound call', 'SCHEMA_INVALID', { provider: res.provider, raw_text: res.raw_text });
      }
      return res.parsed;
    } catch (e) {
      if (e instanceof EngineError) throw e;
      const code = e instanceof ProviderError ? e.code : 'ERROR';
      const spent = e instanceof ProviderError ? e : undefined;
      costs.record({
        call_id: callId,
        ts: this.deps.now().toISOString(),
        stage: c.stage,
        locale: c.locale,
        provider: provider.info.name,
        model: provider.info.model_id,
        input_tokens: spent?.usage?.input_tokens ?? 0,
        output_tokens: spent?.usage?.output_tokens ?? 0,
        // A failed call that burned tokens is priced; one that never reached the model has no cost to report.
        cost_usd: spent?.usage ? (spent.cost_usd ?? null) : 0,
        latency_ms: 0,
        attempts: spent?.attempts ?? 1,
        ok: false,
        segments: c.segments,
        warnings: [code],
      });
      log.error({
        ...base,
        code: 'PROVIDER_ERROR',
        message: `${code}: ${errorMessage(e)}`,
        ...(c.segmentIds?.[0] ? { segment_id: c.segmentIds[0] } : {}),
        data: { call_id: callId, segments: c.segmentIds ?? [] },
      });
      throw e;
    }
  }
}
