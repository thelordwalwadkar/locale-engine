/**
 * MockProvider — replays fixture JSON so the whole pipeline (including the golden-standard nl-NL → de-CH exemplar) runs offline
 * (spec Phase 2). It is built for tests, demos (`--provider mock`) and the comparison harness.
 *
 * Resolution order for every call: `script.fail` → `script.rawResponse` → `script.handlers[stage]` → `script.fixtures` → built-in default.
 * The defaults are deliberately simple but consistent with the prompts: translation applies the glossary table found in the system
 * prompt, localization executes market-claim decisions, the judge reports one omission per neutralised claim, back-translation mirrors.
 */
import type { ZodType } from 'zod';
import type { ProviderConfig } from '../schemas/config.js';
import type { Stage } from '../schemas/common.js';
import { ProviderError } from '../schemas/provider.js';
import type {
  LLMProvider,
  Message,
  ProviderInfo,
  ProviderResult,
  ProviderWarning,
  StageParams,
} from '../schemas/provider.js';
import { parseModelJson } from '../util/json.js';
import { escapeRegExp } from '../util/text.js';

// ---------------------------------------------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------------------------------------------

export interface MockCall {
  stage: Stage;
  /** 1-based count of calls of this provider instance for this stage. */
  n: number;
  provider: string;
  model: string;
  system: string;
  /** The parsed user-message payload (see src/pipeline/payloads.ts). */
  payload: Record<string, unknown>;
  params: StageParams;
  structured_output: ProviderInfo['structured_output'];
}

type ByLocaleAndSegment<T> = Record<string, Record<string, T>>;

export interface MockFixtures {
  translation?: ByLocaleAndSegment<{ translation: string; entities_preserved?: string[]; terminology_applied?: Array<{ source: string; target: string; rule: string }> }>;
  localization?: ByLocaleAndSegment<{
    localized_text: string;
    changes?: Array<{ from: string; to: string; rule: string; reason: string }>;
    requires_human_review?: boolean;
  }>;
  validation?: ByLocaleAndSegment<{
    scores?: { accuracy: number; fluency: number; terminology: number; locale_conventions: number; style_brand: number };
    mqm_errors?: Array<{ category: string; severity: 'minor' | 'major' | 'critical'; source_span: string; target_span: string; explanation: string; suggested_fix: string }>;
    confidence?: number;
    localization_recommendations?: string[];
  }>;
  backtranslation?: ByLocaleAndSegment<string>;
  /** Span repairs matched by the flagged text. */
  repair?: ByLocaleAndSegment<Array<{ match: string; replacement: string; rule?: string; reason?: string }>>;
  language_detection?: Record<string, { lang: string; confidence: number }>;
}

export interface MockScript {
  fixtures?: MockFixtures;
  /** Return the complete wire object (`{ results: [...] }`) for a stage, or undefined to fall through. */
  handlers?: Partial<Record<Stage, (call: MockCall) => unknown>>;
  /** Return raw model text (e.g. prose around JSON, broken JSON) to bypass object building. */
  rawResponse?: (call: MockCall) => string | undefined;
  /** Return an error to make the call fail. */
  fail?: (call: MockCall) => Error | undefined;
  latency_ms?: number;
  /** Every call is appended here (assertions). */
  calls?: MockCall[];
}

// ---------------------------------------------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Parse the glossary table the prompts render: `| GLOSS-0012 | centrifugaalpomp | Kreiselpumpe | … |`. */
function glossaryFromSystem(system: string): Array<{ id: string; source: string; target: string }> {
  const out: Array<{ id: string; source: string; target: string }> = [];
  for (const m of system.matchAll(/^\|\s*(GLOSS-\d{4})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm)) {
    out.push({ id: m[1] as string, source: m[2] as string, target: m[3] as string });
  }
  return out.sort((a, b) => b.source.length - a.source.length);
}

/** Regular plural of the target term, good enough for a mock: German -e → -en, English → -s, otherwise unchanged. */
function pluralOf(target: string, targetLang: string): string {
  if (targetLang === 'de') return target.endsWith('e') ? `${target}n` : target;
  if (targetLang === 'en') return `${target}s`;
  return target;
}

function applyGlossary(text: string, terms: Array<{ source: string; target: string }>, targetLang: string): string {
  let out = text;
  for (const t of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(t.source)}((?:en|s|es)?)(?![\\p{L}\\p{N}])`, 'giu');
    out = out.replace(re, (_m, suffix: string) => (suffix ? pluralOf(t.target, targetLang) : t.target));
  }
  return out;
}

function defaultTranslation(call: MockCall): unknown {
  const locale = str(call.payload['target_locale']);
  const terms = glossaryFromSystem(call.system);
  return {
    results: arr(call.payload['segments']).map((s) => {
      const text = str(s['text']);
      const sameLang = str(s['source_language']) === locale.split('-')[0];
      return {
        segment_id: str(s['segment_id']),
        target_locale: locale,
        translation: sameLang ? text : `[mock ${locale}] ${applyGlossary(text, terms, locale.split('-')[0] ?? '')}`,
        entities_preserved: [],
        terminology_applied: terms
          .filter((t) => Array.isArray(s['glossary_term_ids']) && (s['glossary_term_ids'] as string[]).includes(t.id))
          .map((t) => ({ source: t.source, target: t.target, rule: t.id })),
      };
    }),
  };
}

function defaultLocalization(call: MockCall): unknown {
  const locale = str(call.payload['target_locale']);
  return {
    results: arr(call.payload['segments']).map((s) => {
      let text = str(s['input_text']);
      const changes: Array<{ from: string; to: string; rule: string; reason: string }> = [];
      let review = false;
      for (const c of arr(s['market_claims'])) {
        const phrase = str(c['source_phrase']);
        const action = str(c['action']);
        if ((action === 'NEUTRALIZE' || action === 'REPLACE_WITH_FACT') && phrase && text.includes(phrase)) {
          const to = action === 'REPLACE_WITH_FACT' ? str(c['replacement_phrase']) : '';
          text = text.replace(new RegExp(`\\s*${escapeRegExp(phrase)}`), to ? ` ${to}` : '');
          changes.push({
            from: phrase,
            to,
            rule: 'INTEGRITY-MARKET-CLAIM',
            reason: `[EVIDENCE: market_facts.yaml] Geographic claim ${action === 'NEUTRALIZE' ? 'neutralized' : 'replaced by the supplied fact'}.`,
          });
          review = true;
        }
      }
      return { segment_id: str(s['segment_id']), target_locale: locale, localized_text: text, changes, requires_human_review: review };
    }),
  };
}

function defaultValidation(call: MockCall): unknown {
  const locale = str(call.payload['target_locale']);
  return {
    results: arr(call.payload['segments']).map((s) => {
      const errors = arr(s['market_claims'])
        .filter((c) => str(c['action']) === 'NEUTRALIZE' || str(c['action']) === 'REPLACE_WITH_FACT')
        .map((c) => ({
          category: 'accuracy/omission',
          severity: 'major',
          source_span: str(c['source_phrase']),
          target_span: '',
          explanation: `[EVIDENCE: INTEGRITY-MARKET-CLAIM] Deliberate handling of a geographic claim; the business must confirm the ${locale} scope.`,
          suggested_fix: `Add ${locale}.delivery to market_facts.yaml.`,
        }));
      return {
        segment_id: str(s['segment_id']),
        target_locale: locale,
        scores: { accuracy: 92, fluency: 92, terminology: 92, locale_conventions: 92, style_brand: 92 },
        mqm_errors: errors,
        confidence: 0.9,
        localization_recommendations: [],
      };
    }),
  };
}

function defaultBackTranslation(call: MockCall): unknown {
  const locale = str(call.payload['target_locale']);
  const lang = str(call.payload['back_translation_language']);
  return {
    results: arr(call.payload['segments']).map((s) => ({
      segment_id: str(s['segment_id']),
      target_locale: locale,
      back_translation: `[mock ${lang}] ${str(s['text'])}`,
    })),
  };
}

function defaultRepair(call: MockCall): unknown {
  return {
    results: arr(call.payload['segments']).map((s) => ({
      segment_id: str(s['segment_id']),
      repairs: arr(s['spans']).map((sp) => ({
        span_id: str(sp['span_id']),
        replacement: str(sp['text']),
        rule: str(arr(sp['findings'])[0]?.['rule']) || 'UNKNOWN',
        reason: '[HYPOTHESIS] The mock provider cannot repair this span.',
      })),
    })),
  };
}

function defaultDetection(call: MockCall): unknown {
  return {
    results: arr(call.payload['segments']).map((s) => ({ segment_id: str(s['segment_id']), lang: 'und', confidence: 0.5 })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture lookups
// ---------------------------------------------------------------------------------------------------------------

function fixtureResponse(call: MockCall, fx: MockFixtures): unknown {
  const locale = str(call.payload['target_locale']);
  const segs = arr(call.payload['segments']);
  const pick = <T>(table: ByLocaleAndSegment<T> | undefined, id: string): T | undefined => table?.[locale]?.[id];
  const fallback = defaultFor(call.stage, call) as { results: Json[] };
  const merged = (make: (id: string, def: Json) => Json | undefined): unknown => ({
    results: fallback.results.map((def, i) => {
      const id = str(segs[i]?.['segment_id']);
      return make(id, def) ?? def;
    }),
  });
  switch (call.stage) {
    case 'translation':
      return merged((id, def) => {
        const f = pick(fx.translation, id);
        return f ? { ...def, ...f, segment_id: id, target_locale: locale } : undefined;
      });
    case 'localization':
      return merged((id, def) => {
        const f = pick(fx.localization, id);
        return f ? { ...def, changes: [], requires_human_review: false, ...f, segment_id: id, target_locale: locale } : undefined;
      });
    case 'validation':
      return merged((id, def) => {
        const f = pick(fx.validation, id);
        return f ? { ...def, mqm_errors: [], localization_recommendations: [], ...f, segment_id: id, target_locale: locale } : undefined;
      });
    case 'backtranslation':
      return merged((id, def) => {
        const f = pick(fx.backtranslation, id);
        return f !== undefined ? { ...def, back_translation: f } : undefined;
      });
    case 'repair':
      return merged((id, def) => {
        const rules = pick(fx.repair, id);
        if (!rules) return undefined;
        const seg = segs.find((s) => str(s['segment_id']) === id);
        return {
          segment_id: id,
          repairs: arr(seg?.['spans']).map((sp) => {
            const text = str(sp['text']);
            const hit = rules.find((r) => text.includes(r.match));
            return {
              span_id: str(sp['span_id']),
              replacement: hit ? text.replace(hit.match, hit.replacement) : text,
              rule: hit?.rule ?? (str(arr(sp['findings'])[0]?.['rule']) || 'UNKNOWN'),
              reason: hit?.reason ?? '[EVIDENCE: mock fixture] Fixture repair.',
            };
          }),
        } satisfies Json & typeof def;
      });
    case 'language_detection':
      return merged((id, def) => {
        const f = fx.language_detection?.[id];
        return f ? { ...def, ...f } : undefined;
      });
  }
}

function defaultFor(stage: Stage, call: MockCall): unknown {
  switch (stage) {
    case 'translation':
      return defaultTranslation(call);
    case 'localization':
      return defaultLocalization(call);
    case 'validation':
      return defaultValidation(call);
    case 'backtranslation':
      return defaultBackTranslation(call);
    case 'repair':
      return defaultRepair(call);
    case 'language_detection':
      return defaultDetection(call);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------------------------

const STAGE_NAMES: Stage[] = ['language_detection', 'translation', 'localization', 'validation', 'backtranslation', 'repair'];
/** The instruction of the connectivity check in `src/providers/test.ts`. */
const PING_PROMPT = /"echo" set to the string "locale"/;

export function createMockProvider(name: string, config: ProviderConfig, script: MockScript = {}, modelKey?: string): LLMProvider {
  const key = modelKey ?? config.default_model;
  const model = config.models[key];
  if (!model) throw new Error(`mock provider ${name}: unknown model key ${key}`);
  const info: ProviderInfo = { name, kind: 'mock', model_key: key, model_id: model.id, structured_output: model.structured_output };
  const counters = new Map<Stage, number>();

  const wrap = (obj: unknown): string => {
    const json = JSON.stringify(obj);
    return info.structured_output === 'prompted' ? `<thinking>mock</thinking>\n<final_answer>\n${json}\n</final_answer>` : json;
  };

  return {
    name,
    info,
    async complete<T>(system: string, messages: Message[], params: StageParams, responseSchema?: ZodType<T>): Promise<ProviderResult<T>> {
      const last = messages[messages.length - 1]?.content ?? '';

      /** Schema check, token/cost bookkeeping and the result envelope — shared by pipeline calls and the connectivity check. */
      const respond = (text: string): ProviderResult<T> => {
        let parsed: T | null = null;
        if (responseSchema) {
          const p = parseModelJson(text);
          const v = p.ok ? responseSchema.safeParse(p.value) : null;
          if (!v || !v.success) {
            const why = !p.ok ? p.error : v && !v.success ? v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : 'invalid';
            throw new ProviderError(`mock provider: response does not match the schema (${why})`, 'SCHEMA_INVALID', { provider: name, raw_text: text });
          }
          parsed = v.data;
        }

        const warnings: ProviderWarning[] = [];
        for (const p of model.unsupported_params) {
          if (params[p] !== undefined) warnings.push({ code: 'PARAM_UNSUPPORTED', message: `${name}/${model.id} ignores ${p}` });
        }
        const inputTokens = Math.ceil((system.length + last.length) / 4);
        const outputTokens = Math.ceil(text.length / 4);
        const pricing = model.pricing;
        const cost = pricing ? (inputTokens * pricing.input_per_mtok + outputTokens * pricing.output_per_mtok) / 1e6 : null;
        if (!pricing) warnings.push({ code: 'PRICING_UNKNOWN', message: `no pricing configured for ${name}/${model.id}` });
        return {
          parsed,
          raw_text: text,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          latency_ms: script.latency_ms ?? 1,
          cost_usd: cost,
          provider: name,
          model: model.id,
          attempts: 1,
          warnings,
          stop_reason: 'end_turn',
        };
      };

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(last) as Record<string, unknown>;
      } catch {
        // `locale providers test` sends a plain-text instruction (src/providers/test.ts); every other caller sends a JSON payload
        if (PING_PROMPT.test(last)) return respond(wrap({ ok: true, echo: 'locale' }));
        throw new ProviderError('mock provider: the user message is not a JSON payload', 'BAD_REQUEST', { provider: name });
      }
      const stage = payload['stage'] as Stage;
      if (!STAGE_NAMES.includes(stage)) throw new ProviderError(`mock provider: unknown stage "${String(stage)}"`, 'BAD_REQUEST', { provider: name });
      const n = (counters.get(stage) ?? 0) + 1;
      counters.set(stage, n);
      const call: MockCall = { stage, n, provider: name, model: model.id, system, payload, params, structured_output: model.structured_output };
      script.calls?.push(call);

      const failure = script.fail?.(call);
      if (failure) throw failure;

      const scripted = script.rawResponse?.(call);
      return respond(scripted ?? wrap(script.handlers?.[stage]?.(call) ?? (script.fixtures ? fixtureResponse(call, script.fixtures) : defaultFor(stage, call))));
    },
  };
}
