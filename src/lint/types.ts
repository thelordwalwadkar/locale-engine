/**
 * CONTRACT of the deterministic lint engine (ARCHITECTURE P2, P5, P9). The pipeline depends ONLY on the names exported from
 * `src/lint/index.ts` with the signatures below. Rule semantics are defined by `src/schemas/locale.ts` (rule types) and proven by
 * the `tests` blocks in `config/locales/*.yaml`.
 */
import type {
  BlockType,
  Change,
  CommonConfig,
  DeterministicCheck,
  FindingDraft,
  FormatChange,
  Glossary,
  LocaleCode,
  MarketFacts,
  MetaKind,
  Operation,
  ResolvedLocaleProfile,
  Span,
} from '../schemas/index.js';

/** Everything a rule needs to know about the TARGET market. Built once per target locale by the pipeline. */
export interface LintContext {
  target: LocaleCode;
  /** Profile with `effective_rules` (common + locale rules, lexicon refs resolved). */
  profile: ResolvedLocaleProfile;
  common: CommonConfig;
  glossary: Glossary;
  /** Market facts of the TARGET locale from market_facts.yaml; undefined when none were supplied. */
  marketFacts?: MarketFacts;
  thresholds: { back_translation_similarity_min: number };
}

/** One segment under evaluation. Texts contain inline placeholders (`<a1>…</a1>`); rules run on plain text and report spans mapped back. */
export interface LintSegmentInput {
  segment_id: string;
  block_type: BlockType;
  meta_kind?: MetaKind;
  operation: Operation;
  source_text: string;
  /** ISO 639-1 language of the source text (`nl`, `en`, …): selects number/date conventions and glossary columns. */
  source_lang: string;
  /** `nl-NL`, `en-GB`, `en-*`: the region is used by the market-claim rule. */
  source_locale: string;
  /** The text to judge: final candidate target text. */
  target_text: string;
  /** false for entity-only segments (numbers, codes, URLs). */
  translatable: boolean;
  /** Back-translation of `target_text` (and its language), when one was produced. */
  back_translation?: { text: string; lang: string } | null;
  /** Localization changes already made (lets `empty_output` accept a market-claim removal). */
  changes?: Change[];
}

export interface LintResult {
  /**
   * The notable checks of this segment, golden-exemplar style:
   *  - a FAIL/WARN entry for every rule that produced a finding;
   *  - a PASS entry for every CRITICAL rule that had something to verify
   *    (lexicon: always; entity_preservation: the source has >= 1 entity of the rule's kinds; inline_tags: the source has placeholders;
   *     empty_output: never listed on PASS).
   * `note` always carries an evidence tag. Golden: `{"rule":"DECH-SZ-01","result":"PASS","note":"[EVIDENCE: DECH-SZ-01] No ß present."}`
   * and `{"rule":"INTEGRITY-ENTITY","result":"PASS","note":"[EVIDENCE: p-003] 450 m³/h and 80 preserved."}`.
   */
  checks: DeterministicCheck[];
  /** One draft per violation (per match for lexicon/conditional rules). `explanation` contains `[EVIDENCE: <rule id>]` (or `[HYPOTHESIS]` when `rule.hypothesis`). */
  findings: FindingDraft[];
  /** Reasons a human must look at the segment whatever its score, e.g. `INTEGRITY-MARKET-CLAIM: source claims "in heel Nederland" and no de-CH delivery fact is supplied`. */
  review_reasons: string[];
}

export interface NormalizeFormatsInput {
  source_text: string;
  source_lang: string;
  source_locale: string;
  /** Candidate target text (placeholders allowed). */
  target_text: string;
  target: LocaleCode;
}

export type FormatChangeDraft = Omit<FormatChange, 'segment_id' | 'locale'>;

export interface FormatNormalization {
  text: string;
  /** One entry per source number / currency amount / numeric date whose written form differs in the output (spec §4.4). */
  changes: FormatChangeDraft[];
}

export interface AutofixApplied {
  rule: string;
  span: Span;
  before: string;
  after: string;
}

export interface AutofixResult {
  text: string;
  applied: AutofixApplied[];
}

export interface RuleTestOutcome {
  rule_id: string;
  /** The locale profile the test ran under. */
  locale: LocaleCode;
  /** Index into the rule's `tests`. */
  index: number;
  expect: 'pass' | 'fail';
  actual: 'pass' | 'fail';
  /** expect === actual */
  ok: boolean;
  /** null unless the test declares `fixed`; then whether autofix reproduced it exactly. */
  fixed_ok: boolean | null;
  detail: string;
}

export interface MarketClaim {
  /** The matched phrase, e.g. `in heel Nederland`. */
  phrase: string;
  /** Key of `market_claims.countries`, or null for a generic scope claim (landelijk / nationwide). */
  country: string | null;
  /** Regions the claim covers (from `countries[country].regions`); empty for generic claims. */
  regions: string[];
  /** Plain-text offsets. */
  span: Span;
}
