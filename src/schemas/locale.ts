/**
 * Locale profiles and the rule language (ARCHITECTURE P5: locale rules are data).
 *
 * A rule lives ONCE in `config/locales/<locale>.yaml` (or `_common.yaml` for rules shared by all locales).
 * The deterministic linter executes it; the runtime prompts render the same rule (id, severity, message, examples).
 * Every rule carries executable test strings (`tests`), so the YAML is self-verifying.
 *
 * ----------------------------------------------------------------------------------------------------------
 * REGEX CONVENTIONS (binding for every pattern string in the YAML and for the linter that compiles them)
 *  - Patterns are JavaScript regex *sources* (YAML single-quoted strings avoid double escaping).
 *  - Compiled with flags `u` + `g` + (`i` unless a rule's `flags` says otherwise — `flags` REPLACES the default
 *    set, `g` and `u` are always added).
 *  - JavaScript's `\b` is ASCII-only even under `u` (it sees "ä" as a non-word char). The engine therefore
 *    rewrites every `\b` outside a character class to a Unicode-aware boundary:
 *    `(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))`.
 *    Authors can keep writing `\b`.
 *  - Patterns are tested against PLAIN text: inline placeholders (`<a1>…</a1>`) are removed first (see util/inline.ts)
 *    and spans are mapped back to offsets in the placeholder-bearing text.
 *
 * SCOPE. When `applies_to` is omitted a rule applies to every block type EXCEPT `meta` segments of kind `slug`
 * (slugs have their own rule). List `meta_kinds` explicitly to include `slug`.
 *
 * TEST SEMANTICS (`tests[]`). `expect: fail` means the linter emits >= 1 finding whose rule id is this rule's id;
 * `expect: pass` means it emits none. `fixed` (only with `autofix: true` and `expect: fail`) is the exact text the
 * deterministic autofix must produce. `source*` fields default to a Dutch paragraph (`nl`, `nl-NL`, `paragraph`).
 * ----------------------------------------------------------------------------------------------------------
 */
import { z } from 'zod';
import { BlockTypeSchema, LanguageSchema, LocaleCodeSchema, MetaKindSchema, SeveritySchema } from './common.js';
import { MarketFactsSchema } from './config.js';

export const RuleIdSchema = z
  .string()
  .regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/, 'rule id must look like DECH-SZ-01 or INTEGRITY-ENTITY');

export const RuleTestSchema = z.strictObject({
  /** Text under test (the candidate target). May contain inline placeholders. */
  target: z.string(),
  /** Target locale the test runs under. Default: the locale whose file declares the rule; `de-DE` for rules in `_common.yaml`. */
  target_locale: LocaleCodeSchema.optional(),
  source: z.string().optional(),
  source_lang: z.string().optional(),
  source_locale: z.string().optional(),
  block_type: BlockTypeSchema.optional(),
  meta_kind: MetaKindSchema.optional(),
  /** Operation of the segment under test; default `TRANSLATE_LOCALIZE`. */
  operation: z.enum(['TRANSLATE_LOCALIZE', 'TRANSLATE_ONLY', 'ADAPT_ONLY', 'SKIP_IDENTICAL']).optional(),
  /** Market facts in force for the target locale during this test (market_claim / currency_policy). */
  market_facts: MarketFactsSchema.optional(),
  /** Back-translation text + language (backtranslation_similarity tests). */
  back_translation: z.strictObject({ text: z.string(), lang: z.string() }).optional(),
  expect: z.enum(['pass', 'fail']),
  fixed: z.string().optional(),
  note: z.string().optional(),
});
export type RuleTest = z.infer<typeof RuleTestSchema>;

const RuleBaseShape = {
  id: RuleIdSchema,
  severity: SeveritySchema,
  /** What is wrong and why. Rendered into prompts and into findings. */
  message: z.string().min(1),
  /** How to fix it. Rendered into repair prompts and `suggested_fix`. */
  fix: z.string().optional(),
  applies_to: z.array(BlockTypeSchema).optional(),
  meta_kinds: z.array(MetaKindSchema).optional(),
  /** true: the linter may rewrite the text itself (only for unambiguous, safe rewrites). */
  autofix: z.boolean().default(false),
  /** Trigger a repair loop even for this rule's findings. Default: `severity !== 'minor'`. */
  repair_trigger: z.boolean().optional(),
  /** true: findings from this rule are tagged `[HYPOTHESIS]` instead of `[EVIDENCE: <id>]`. */
  hypothesis: z.boolean().default(false),
  tests: z.array(RuleTestSchema).min(1, 'every rule needs at least one test string'),
};

// -- lexicon ------------------------------------------------------------------------------------------------

export const LexiconTermSchema = z.strictObject({
  /** Regex source that matches the FORBIDDEN / non-preferred form. */
  pattern: z.string().min(1),
  /** Replacement template (`$1` groups allowed). Required when the rule has `autofix: true`. */
  prefer: z.string().optional(),
  /** Re-apply the capitalisation of the matched text to `prefer` (Jänner/jänner, ss/SS). Default true. */
  preserve_case: z.boolean().default(true),
  note: z.string().optional(),
});
export type LexiconTerm = z.infer<typeof LexiconTermSchema>;

/**
 * `lexicon`: every match of a term pattern is a finding (span = the match). Covers forbidden characters (`ß` in de-CH),
 * spelling variants, Helvetisms/Austriacisms, quotation-mark styles, formality, tone. `terms` may be replaced or
 * extended by `lexicon_ref` (a key of `_common.yaml` -> `lexicons`), resolved at load time.
 */
export const LexiconRuleSchema = z.strictObject({
  type: z.literal('lexicon'),
  ...RuleBaseShape,
  terms: z.array(LexiconTermSchema).default([]),
  lexicon_ref: z.string().optional(),
  flags: z.string().regex(/^[imsy]*$/).optional(),
});

// -- conditional ----------------------------------------------------------------------------------------------

/**
 * `conditional`: source-aware check (false friends, required forms). Applies only when the SOURCE text matches
 * `when_source` (and not `unless_source`). Then: every match of a `target_forbid` pattern is a finding; and if
 * `target_require` is non-empty, at least ONE of its patterns must match the target, else one finding (no span).
 * `prefer` is an optional replacement template for `target_forbid` matches (used for autofix and suggestions).
 */
export const ConditionalRuleSchema = z.strictObject({
  type: z.literal('conditional'),
  ...RuleBaseShape,
  when_source: z.string().min(1),
  unless_source: z.string().optional(),
  target_forbid: z.array(z.string()).default([]),
  target_require: z.array(z.string()).default([]),
  prefer: z.string().optional(),
  flags: z.string().regex(/^[imsy]*$/).optional(),
});

// -- first_mention (document level) ---------------------------------------------------------------------------

/**
 * `first_mention` (document level): if any source segment matches `when_source`, the FIRST occurrence of `term` across
 * the target segments (document order) must be matched by `required_form` starting at the same position.
 * Example: BTW -> `VAT (BTW)` on first mention in en-NL.
 */
export const FirstMentionRuleSchema = z.strictObject({
  type: z.literal('first_mention'),
  ...RuleBaseShape,
  when_source: z.string().min(1),
  term: z.string().min(1),
  required_form: z.string().min(1),
  /** Literal text that replaces the first `term` occurrence when `autofix: true` (e.g. `VAT (BTW)`). */
  prefer: z.string().optional(),
  flags: z.string().regex(/^[imsy]*$/).optional(),
});

// -- length ---------------------------------------------------------------------------------------------------

/** `length`: plain-text length in Unicode code points must be <= `max_chars`. Scope via applies_to / meta_kinds. */
export const LengthRuleSchema = z.strictObject({
  type: z.literal('length'),
  ...RuleBaseShape,
  max_chars: z.number().int().positive(),
});

// -- built-in rule types --------------------------------------------------------------------------------------

/** `slug`: slug segments must be lowercase `a-z0-9` words joined by single hyphens; autofix = slugify() with the locale's transliteration. */
export const SlugRuleSchema = z.strictObject({ type: z.literal('slug'), ...RuleBaseShape });

/**
 * `format`: built-in number / currency / date convention check driven by the profile's `formatting` block. The same
 * rule id is stamped on every FORMAT_CHANGE the normaliser logs for that aspect. Each locale must declare exactly one
 * `format` rule per aspect (number, currency, date).
 */
export const FormatRuleSchema = z.strictObject({
  type: z.literal('format'),
  ...RuleBaseShape,
  aspect: z.enum(['number', 'currency', 'date']),
});

/**
 * `entity_preservation`: built-in. Extracts entities of the listed kinds from source and target and requires each source
 * entity to survive byte-identical, except for separator / currency-position / numeric-date reformatting that is an
 * exact application of the target locale's `formatting` (those are logged as FORMAT_CHANGE, not reported as failures).
 * kinds: number, unit, product_code, brand, phone, url, email.
 */
export const EntityPreservationRuleSchema = z.strictObject({
  type: z.literal('entity_preservation'),
  ...RuleBaseShape,
  kinds: z.array(z.enum(['number', 'unit', 'product_code', 'brand', 'phone', 'url', 'email'])).min(1),
});

/** `inline_tags`: built-in. The multiset of inline placeholders must survive and be properly nested (order may change). */
export const InlineTagsRuleSchema = z.strictObject({ type: z.literal('inline_tags'), ...RuleBaseShape });

/**
 * `market_claim`: built-in (data in `_common.yaml` -> `market_claims`). A source phrase that names a country as a scope
 * of service ("levering in heel Nederland") is a market claim. Unless the claim's country region equals the target
 * locale's region, or `market_facts.<target>.delivery` supplies the fact, the target must NOT restate it: if it does ->
 * finding; in every case the segment is flagged `requires_human_review`.
 */
export const MarketClaimRuleSchema = z.strictObject({ type: z.literal('market_claim'), ...RuleBaseShape });

/**
 * `currency_policy` (document level): built-in. If the source contains currency amounts: when `market_facts.<target>.currency`
 * is absent -> a `[HYPOTHESIS]` finding/recommendation "confirm currency policy" (amounts are retained, never converted);
 * when it is present and differs from the amount currency -> a finding that converted prices must be supplied by the business.
 */
export const CurrencyPolicyRuleSchema = z.strictObject({ type: z.literal('currency_policy'), ...RuleBaseShape });

/** `untranslated`: built-in. Target identical to source although languages differ (translatable, >= `min_words` words). */
export const UntranslatedRuleSchema = z.strictObject({
  type: z.literal('untranslated'),
  ...RuleBaseShape,
  min_words: z.number().int().min(1).default(3),
});

/** `terminology`: built-in soft glossary check. For each glossary term found in the source, one of the locale's forms must appear in the target. */
export const TerminologyRuleSchema = z.strictObject({ type: z.literal('terminology'), ...RuleBaseShape });

/** `backtranslation_similarity`: built-in. Token-F1 between source and back-translation (only when both are the same language) must reach `thresholds.back_translation_similarity_min`. */
export const BackTranslationSimilarityRuleSchema = z.strictObject({ type: z.literal('backtranslation_similarity'), ...RuleBaseShape });

/** `empty_output`: built-in. Non-empty source text but empty target (unless a market-claim neutralisation removed the whole segment). */
export const EmptyOutputRuleSchema = z.strictObject({ type: z.literal('empty_output'), ...RuleBaseShape });

export const RuleSchema = z.discriminatedUnion('type', [
  LexiconRuleSchema,
  ConditionalRuleSchema,
  FirstMentionRuleSchema,
  LengthRuleSchema,
  SlugRuleSchema,
  FormatRuleSchema,
  EntityPreservationRuleSchema,
  InlineTagsRuleSchema,
  MarketClaimRuleSchema,
  CurrencyPolicyRuleSchema,
  UntranslatedRuleSchema,
  TerminologyRuleSchema,
  BackTranslationSimilarityRuleSchema,
  EmptyOutputRuleSchema,
]);
export type Rule = z.infer<typeof RuleSchema>;
export type RuleType = Rule['type'];

// ---------------------------------------------------------------------------------------------------------------
// Formatting conventions (drives `format` rules, the normaliser and the prompts)
// ---------------------------------------------------------------------------------------------------------------

export const NumberFormatSchema = z.strictObject({
  /** Decimal separator of the locale, e.g. `,` (de-DE) or `.` (en-GB, de-CH). */
  decimal: z.string().length(1),
  /** Canonical thousands separator WRITTEN by the normaliser. */
  thousands: z.string().length(1),
  /** Every thousands separator the linter accepts (must include `thousands`). */
  accepted_thousands: z.array(z.string().length(1)).min(1),
  /** Notation `1.250,-` / `1.250,–`: `keep` (nl, de) or `drop` (en, it) when converting INTO this locale. */
  dash_decimal: z.enum(['keep', 'drop']),
  /** Example used in prompts, e.g. `1.234,56`. */
  example: z.string(),
});

export const CurrencyFormatSchema = z.strictObject({
  /** Currency used when the business prices for this market (EUR, GBP, CHF). Policy check only; amounts are never converted. */
  local_code: z.string().length(3),
  /** Symbol (`€`, `£`) or alphabetic code (`CHF`) for `local_code`. */
  local_symbol: z.string(),
  position: z.enum(['before', 'after']),
  /** Space between a SYMBOL (`€`) and the number; alphabetic codes (`CHF`, `EUR`) always take a space. */
  space: z.enum(['none', 'space', 'nbsp']),
  /** Linter also accepts the other position. */
  accept_alternate_position: z.boolean().default(false),
  example: z.string(),
});

export const DateFormatSchema = z.strictObject({
  /** Numeric date shape written by the normaliser; day-first in every supported locale. */
  numeric: z.enum(['DD.MM.YYYY', 'DD/MM/YYYY', 'DD-MM-YYYY']),
  zero_pad: z.boolean(),
  /** Example of the textual form used in prompts, e.g. `30. September 2026`. */
  textual_example: z.string(),
});

export const QuotesSchema = z.strictObject({
  open: z.string(),
  close: z.string(),
  open_inner: z.string(),
  close_inner: z.string(),
});

export const FormattingSchema = z.strictObject({
  number: NumberFormatSchema,
  currency: CurrencyFormatSchema,
  date: DateFormatSchema,
  quotes: QuotesSchema,
});
export type Formatting = z.infer<typeof FormattingSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Market checks (recommendations, always `[HYPOTHESIS]`)
// ---------------------------------------------------------------------------------------------------------------

export const MarketCheckSchema = z.strictObject({
  id: RuleIdSchema,
  /** Recommendation text WITHOUT the tag; the tag is prepended when emitted. */
  text: z.string().min(1),
  /** `legal_page`: only emitted for pages classified LEGAL. */
  applies: z.enum(['always', 'legal_page']).default('always'),
  /** true -> emitted as `[HYPOTHESIS] — verify with counsel`. All legal/regulatory checks must set this. */
  verify_with_counsel: z.boolean().default(false),
});
export type MarketCheck = z.infer<typeof MarketCheckSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Locale profile (`config/locales/<locale>.yaml`)
// ---------------------------------------------------------------------------------------------------------------

export const LocaleProfileSchema = z.strictObject({
  locale: LocaleCodeSchema,
  language: LanguageSchema,
  /** ISO 3166-1 alpha-2, upper case. */
  region: z.string().regex(/^[A-Z]{2}$/),
  display_name: z.string(),
  /** Adjective/label for the audience used in generated sentences: "UK", "Swiss", "German", … ("UK buyers expect GBP pricing"). */
  audience_label: z.string(),
  /** One or two sentences: who this text is written for. Rendered into prompts. */
  description: z.string(),
  hreflang: z.string(),
  formatting: FormattingSchema,
  slug: z.strictObject({
    /** Applied before diacritic stripping, e.g. `ä: ae`. */
    transliterate: z.record(z.string(), z.string()).default({}),
    strip_diacritics: z.boolean().default(true),
  }),
  seo: z.strictObject({
    title_max: z.number().int().positive(),
    meta_description_max: z.number().int().positive(),
  }),
  /** Non-executable style guidance lines rendered into the prompts (executable guidance belongs in `rules`). */
  prompt_notes: z.array(z.string()).default([]),
  rules: z.array(RuleSchema),
  market_checks: z.array(MarketCheckSchema).default([]),
  /** Ids of `prompts/exemplars/edge.*.md` files relevant to this locale. */
  edge_exemplars: z.array(z.string()).default([]),
});
export type LocaleProfile = z.infer<typeof LocaleProfileSchema>;

// ---------------------------------------------------------------------------------------------------------------
// `config/locales/_common.yaml`
// ---------------------------------------------------------------------------------------------------------------

export const EntityConfigSchema = z.strictObject({
  /** Regex sources (flags `u`,`g`; case-SENSITIVE) for product codes / model names, e.g. `N-3085`, `JESX-50`. */
  product_code_patterns: z.array(z.string()),
  /** Units written as symbols (kept byte-identical and treated as part of the number entity). Longest first is not required. */
  symbol_units: z.array(z.string()),
  /** Regex sources for phone numbers (treated as opaque entities). */
  phone_patterns: z.array(z.string()),
  /**
   * Regex sources (case-sensitive) for the NUMBER part of names and standard designations that must never be reformatted and are compared
   * verbatim: "Industrie 4.0" (keep `4.0`, never `4,0`), "EN 12845:2019". Use a lookbehind for the word so only the number is matched.
   */
  protected_patterns: z.array(z.string()).default([]),
  url_pattern: z.string(),
  email_pattern: z.string(),
});

export const MarketClaimConfigSchema = z.strictObject({
  countries: z.record(
    z.string(),
    z.strictObject({
      /** ISO regions that count as "the same market" (Benelux -> NL, BE, LU). */
      regions: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
      /** Names in any supported language, inflected forms included. */
      names: z.array(z.string()).min(1),
    }),
  ),
  /** Regex sources containing the token `{COUNTRY}`, replaced by an alternation of all names of one country. */
  scope_patterns: z.array(z.string()).min(1),
  /** Regex sources that express scope without naming a country ("landelijk", "bundesweit"); region = unspecified source market. */
  generic_scope_patterns: z.array(z.string()).default([]),
});

export const CurrencyConfigSchema = z.strictObject({
  /** ISO code -> symbol written in text, e.g. EUR -> `€`. Codes without a symbol map to themselves. */
  symbols: z.record(z.string(), z.string()),
});

export const CommonConfigSchema = z.strictObject({
  version: z.number().int(),
  rules: z.array(RuleSchema),
  lexicons: z.record(z.string(), z.array(LexiconTermSchema)).default({}),
  entities: EntityConfigSchema,
  market_claims: MarketClaimConfigSchema,
  currency: CurrencyConfigSchema,
  /** 12 month names per language key (`nl`, `en`, `de`, `de-AT`, `it`), lower-case not required. */
  month_names: z.record(z.string(), z.array(z.string()).length(12)),
});
export type CommonConfig = z.infer<typeof CommonConfigSchema>;

/** A locale profile after `_common.yaml` rules are merged in and `lexicon_ref`s are resolved. */
export type ResolvedLocaleProfile = LocaleProfile & {
  /** common rules first, then locale rules; refs resolved. The linter and prompt renderer use this list. */
  effective_rules: Rule[];
};
