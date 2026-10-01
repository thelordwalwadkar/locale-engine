/**
 * Shapes of the files in `config/`: market_facts.yaml, glossary.csv (row model), stages.yaml, providers.yaml.
 * (Locale profiles live in `locale.ts`.)
 */
import { z } from 'zod';
import { LocaleCodeSchema, StageSchema } from './common.js';

// ---------------------------------------------------------------------------------------------------------------
// market_facts.yaml — per-market business facts. Empty by default; the engine NEVER invents these.
// ---------------------------------------------------------------------------------------------------------------

export const MarketFactsSchema = z.strictObject({
  /** Target-language phrase that replaces a geographic scope claim, e.g. `in die ganze Schweiz`. Presence = the fact is confirmed. */
  delivery: z.string().optional(),
  /** Target-language lead-time phrase, e.g. `innert 5 Arbeitstagen`. */
  lead_time: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  /** ISO currency code the business actually prices in for this market (EUR, GBP, CHF). Absent = unknown -> flagged, amounts retained. */
  currency: z.string().length(3).optional(),
  /** Certifications the business genuinely holds (e.g. `SVGW`). Only these may be mentioned as trust signals. */
  certifications: z.array(z.string()).optional(),
  notes: z.string().optional(),
});
export type MarketFacts = z.infer<typeof MarketFactsSchema>;

/** Top-level keys are locale codes; any subset. An empty file is valid. */
export const MarketFactsFileSchema = z.partialRecord(LocaleCodeSchema, MarketFactsSchema);
export type MarketFactsFile = z.infer<typeof MarketFactsFileSchema>;

// ---------------------------------------------------------------------------------------------------------------
// glossary.csv
// ---------------------------------------------------------------------------------------------------------------

/**
 * CSV columns: `term_id,category,do_not_translate,nl-NL,en-NL,en-GB,de-DE,de-AT,de-CH,it-IT,notes`.
 * A cell may hold several variants separated by `|`; the FIRST is preferred. Matching is case-insensitive substring/stem based
 * (see `src/config/glossary.ts`), so German/English plurals need no extra variants; Italian nouns list singular|plural.
 */
const RegexSourceSchema = z.string().refine(
  (s) => {
    try {
      new RegExp(s, 'iu');
      return true;
    } catch {
      return false;
    }
  },
  { error: 'not a valid regular expression' },
);

export const GlossaryEntrySchema = z.object({
  term_id: z.string().regex(/^GLOSS-\d{4}$/),
  category: z.string(),
  /** true: brand / abbreviation kept byte-identical in every locale (the forms are identical across columns). */
  do_not_translate: z.boolean(),
  forms: z.partialRecord(LocaleCodeSchema, z.array(z.string().min(1))),
  notes: z.string().optional(),
  /**
   * Sense disambiguation for source terms that are also an ordinary word in another sense (Dutch `lager` = bearing, but also
   * "lower"). A hit is ignored when the text right AFTER it matches this regex (anchored at the end of the hit)…
   */
  skip_after: RegexSourceSchema.optional(),
  /** …or when the text right BEFORE it matches this regex (anchored at the start of the hit). Case-insensitive, Unicode. */
  skip_before: RegexSourceSchema.optional(),
});
export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>;

export const GlossarySchema = z.array(GlossaryEntrySchema);
export type Glossary = z.infer<typeof GlossarySchema>;

// ---------------------------------------------------------------------------------------------------------------
// stages.yaml — run-time defaults
// ---------------------------------------------------------------------------------------------------------------

export const StageParamConfigSchema = z.strictObject({
  temperature: z.number().min(0).max(2),
  top_p: z.number().min(0).max(1),
  max_tokens: z.number().int().positive(),
  /** Why these values (spec §0.2). Also written as a comment next to the values in the YAML. */
  justification: z.string().min(1),
});
export type StageParamConfig = z.infer<typeof StageParamConfigSchema>;

export const StagesConfigSchema = z.strictObject({
  version: z.number().int(),
  stages: z.strictObject({
    language_detection: StageParamConfigSchema,
    translation: StageParamConfigSchema,
    localization: StageParamConfigSchema,
    validation: StageParamConfigSchema,
    backtranslation: StageParamConfigSchema,
    repair: StageParamConfigSchema,
  }),
  batching: z.strictObject({
    /** Max segments per LLM call. Lower it when a provider truncates or breaks JSON (spec §8.2). */
    max_segments: z.number().int().positive(),
    /** Max characters of source text per LLM call. */
    max_input_chars: z.number().int().positive(),
  }),
  concurrency: z.strictObject({
    /** Locales processed in parallel. */
    locales: z.number().int().positive(),
    /** Concurrent LLM calls inside one locale. */
    calls_per_locale: z.number().int().positive(),
  }),
  thresholds: z.strictObject({
    /** {{PASS_THRESHOLD}} */
    pass: z.number().min(0).max(100),
    /** {{MAX_REPAIR_LOOPS}} */
    max_repair_loops: z.number().int().min(0),
    /** Judge confidence below this forces HUMAN_REVIEW (spec §6.6). */
    judge_confidence_min: z.number().min(0).max(1),
    /** Language detection below this falls back to the LLM (spec Phase 4). */
    detection_confidence_min: z.number().min(0).max(1),
    /** Minimum token-F1 between source and back-translation when both are in the same language. */
    back_translation_similarity_min: z.number().min(0).max(1),
    /** Segments with fewer natural-language words than this are not language-detected individually (they inherit). */
    detection_min_words: z.number().int().min(1),
  }),
  scoring: z.strictObject({
    weights: z.strictObject({ minor: z.number(), major: z.number(), critical: z.number() }),
    /** Penalty is normalised per 100 words with the word count floored at this value (A-0xx: reproduces the golden 95). */
    words_floor: z.number().int().positive(),
  }),
  cost: z.strictObject({
    /** {{COST_CEILING_USD}} per run. */
    ceiling_usd: z.number().positive(),
  }),
  ingest: z.strictObject({
    user_agent: z.string(),
    timeout_ms: z.number().int().positive(),
    max_retries: z.number().int().min(0),
    backoff_ms: z.number().int().positive(),
    max_bytes: z.number().int().positive(),
    respect_robots: z.boolean(),
    /** Refuse loopback / private / link-local targets (SSRF guard). See PROPOSED_ADDITIONS (deliberately on by default). */
    block_private_networks: z.boolean(),
  }),
  page_classification: z.strictObject({
    /** Case-insensitive regex sources tested against the URL path / file name. A match classifies the page LEGAL. */
    legal_url_patterns: z.array(z.string()),
    /** Case-insensitive regex sources tested against the page title / first heading. */
    legal_title_patterns: z.array(z.string()),
  }),
  locale_matrix: z.strictObject({
    /** `--targets all` expansion per source language (spec §4.1). */
    default_targets: z.strictObject({ nl: z.array(LocaleCodeSchema), en: z.array(LocaleCodeSchema) }),
    /** en-* -> nl-NL is supported but off by default. */
    enable_en_to_nl: z.boolean(),
    /** Pivot rule (spec §4.1): every German variant is produced directly from source, never by converting another variant. */
    pivot: z.literal('direct'),
  }),
  /** Proposed additions (PROPOSED_ADDITIONS.md). Every flag is false until approved. */
  features: z.strictObject({}).default({}),
});
export type StagesConfig = z.infer<typeof StagesConfigSchema>;

// ---------------------------------------------------------------------------------------------------------------
// providers.yaml
// ---------------------------------------------------------------------------------------------------------------

export const PROVIDER_KINDS = ['anthropic', 'openai', 'google', 'openai_compatible', 'ollama', 'mock', 'custom'] as const;
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const PricingSchema = z.strictObject({
  input_per_mtok: z.number().min(0),
  output_per_mtok: z.number().min(0),
  cached_input_per_mtok: z.number().min(0).optional(),
});
export type Pricing = z.infer<typeof PricingSchema>;

export const STRUCTURED_OUTPUT_MODES = ['native', 'json_mode', 'prompted'] as const;
export const StructuredOutputModeSchema = z.enum(STRUCTURED_OUTPUT_MODES);
export type StructuredOutputMode = z.infer<typeof StructuredOutputModeSchema>;

export const ModelConfigSchema = z.strictObject({
  /** The provider-side model id. Model ids live ONLY here (spec §4.5). */
  id: z.string().min(1),
  pricing: PricingSchema.optional(),
  /** false until someone compared `pricing` with the provider's price page; reported in the run log. */
  pricing_verified: z.boolean().default(false),
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  /**
   * native     = provider-enforced JSON schema;
   * json_mode  = provider guarantees syntactically valid JSON, schema is in the prompt;
   * prompted   = instruct + parse + validate + single retry.
   */
  structured_output: StructuredOutputModeSchema.default('prompted'),
  /** Parameters the model ignores or rejects. The adapter drops them and logs PARAM_UNSUPPORTED. */
  unsupported_params: z.array(z.enum(['temperature', 'top_p', 'seed'])).default([]),
  notes: z.string().optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ProviderConfigSchema = z.strictObject({
  kind: ProviderKindSchema,
  /** kind=custom only: path (relative to the project root or absolute) of an ESM module exporting `createProvider(config)`. */
  module: z.string().optional(),
  description: z.string().optional(),
  /** Environment variable holding the API key (never the key itself). Omit for ollama / mock. */
  api_key_env: z.string().optional(),
  base_url: z.string().optional(),
  /** Environment variable that overrides `base_url` when set. */
  base_url_env: z.string().optional(),
  /** Key into `models`. */
  default_model: z.string(),
  models: z.record(z.string(), ModelConfigSchema),
  timeout_ms: z.number().int().positive().default(120_000),
  max_retries: z.number().int().min(0).default(2),
  /** Adapter-specific knobs. */
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const RoutingSchema = z.strictObject({
  /** {{DEFAULT_PROVIDER}}: used for every stage not listed below and as the fallback when a routed provider has no credentials. */
  default_provider: z.string(),
  /** stage -> `provider` or `provider:model-key`. `validation` and `backtranslation` should point at a provider other than `translation` ({{JUDGE_PROVIDER}}). */
  stages: z.partialRecord(StageSchema, z.string()),
});
export type Routing = z.infer<typeof RoutingSchema>;

export const ProvidersConfigSchema = z
  .strictObject({
    version: z.number().int(),
    providers: z.record(z.string(), ProviderConfigSchema),
    routing: RoutingSchema,
  })
  .superRefine((cfg, ctx) => {
    const names = Object.keys(cfg.providers);
    const check = (ref: string, where: string) => {
      const [p, m] = ref.split(':');
      if (!p || !cfg.providers[p]) {
        ctx.addIssue({ code: 'custom', message: `${where}: unknown provider "${p}" (known: ${names.join(', ')})` });
      } else if (m && !cfg.providers[p].models[m]) {
        ctx.addIssue({ code: 'custom', message: `${where}: provider "${p}" has no model key "${m}"` });
      }
    };
    check(cfg.routing.default_provider, 'routing.default_provider');
    for (const [stage, ref] of Object.entries(cfg.routing.stages)) check(ref, `routing.stages.${stage}`);
    for (const [name, p] of Object.entries(cfg.providers)) {
      if (!p.models[p.default_model]) {
        ctx.addIssue({ code: 'custom', message: `providers.${name}.default_model "${p.default_model}" is not a key of models` });
      }
      if (p.kind === 'custom' && !p.module) {
        ctx.addIssue({ code: 'custom', message: `providers.${name}: kind "custom" requires "module"` });
      }
    }
  });
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;
