/**
 * The deterministic rule runner (ARCHITECTURE P5, P9): executes the locale profile's `effective_rules` against one segment
 * (`lintSegment`) or a whole document (`lintDocument`, for the document-level rule types) and assembles findings, checks and
 * human-review reasons.
 */
import type { DeterministicCheck, Rule, RuleType } from '../schemas/index.js';
import { ruleTag, type RuleOutcome } from './draft.js';
import { evaluateBackTranslation } from './rules/backtranslation.js';
import { evaluateConditional } from './rules/conditional.js';
import { evaluateCurrencyPolicy } from './rules/currency-policy.js';
import { evaluateEmptyOutput } from './rules/empty-output.js';
import { evaluateEntities } from './rules/entity.js';
import { evaluateFirstMention } from './rules/first-mention.js';
import { evaluateFormat } from './rules/format.js';
import { evaluateInlineTags } from './rules/inline-tags.js';
import { evaluateLength } from './rules/length.js';
import { evaluateLexicon } from './rules/lexicon.js';
import { evaluateMarketClaim } from './rules/market-claim.js';
import { evaluateSlug } from './rules/slug.js';
import { evaluateTerminology } from './rules/terminology.js';
import { evaluateUntranslated } from './rules/untranslated.js';
import { SegmentView } from './segment.js';
import type { LintContext, LintResult, LintSegmentInput } from './types.js';

/**
 * A segment copied because it is already in the target locale gets the locale-convention checks only: comparing it with its own
 * source (untranslated, entities, claims, terminology, …) is meaningless.
 */
const SKIP_IDENTICAL_TYPES: ReadonlySet<RuleType> = new Set(['lexicon', 'format', 'length', 'slug', 'first_mention']);
const DOCUMENT_TYPES: ReadonlySet<RuleType> = new Set(['first_mention', 'currency_policy']);

/** Scope: `applies_to` (default: every block type) and, for meta segments, `meta_kinds` (default: every kind except `slug`). */
export function ruleApplies(rule: Rule, input: Pick<LintSegmentInput, 'block_type' | 'meta_kind' | 'operation'>): boolean {
  if (rule.applies_to && !rule.applies_to.includes(input.block_type)) return false;
  if (input.block_type === 'meta') {
    if (rule.meta_kinds ? !input.meta_kind || !rule.meta_kinds.includes(input.meta_kind) : input.meta_kind === 'slug') return false;
  }
  return input.operation !== 'SKIP_IDENTICAL' || SKIP_IDENTICAL_TYPES.has(rule.type);
}

function evaluateSegmentRule(rule: Rule, seg: SegmentView): RuleOutcome {
  switch (rule.type) {
    case 'lexicon':
      return evaluateLexicon(rule, seg);
    case 'conditional':
      return evaluateConditional(rule, seg);
    case 'length':
      return evaluateLength(rule, seg);
    case 'slug':
      return evaluateSlug(rule, seg);
    case 'format':
      return evaluateFormat(rule, seg);
    case 'entity_preservation':
      return evaluateEntities(rule, seg);
    case 'inline_tags':
      return evaluateInlineTags(rule, seg);
    case 'market_claim':
      return evaluateMarketClaim(rule, seg);
    case 'untranslated':
      return evaluateUntranslated(rule, seg);
    case 'terminology':
      return evaluateTerminology(rule, seg);
    case 'backtranslation_similarity':
      return evaluateBackTranslation(rule, seg);
    case 'empty_output':
      return evaluateEmptyOutput(rule, seg);
    case 'first_mention':
    case 'currency_policy':
      return { violations: [] };
  }
}

/**
 * FAIL/WARN for a rule with findings; PASS only for a critical rule that had something to verify.
 */
function checkOf(rule: Rule, outcome: RuleOutcome): DeterministicCheck | null {
  const n = outcome.violations.length;
  if (n > 0) {
    const details = outcome.violations.slice(0, 3).map((v) => v.detail);
    const summary = n === 1 ? details[0] : `${n} findings: ${details.join(' ')}${n > 3 ? ' …' : ''}`;
    const result = rule.hypothesis || rule.severity === 'minor' ? 'WARN' : 'FAIL';
    return { rule: rule.id, result, note: `${ruleTag(rule)} ${summary}`, severity: rule.severity };
  }
  if (rule.severity === 'critical' && outcome.passNote !== undefined) return { rule: rule.id, result: 'PASS', note: outcome.passNote, severity: rule.severity };
  return null;
}

function assemble(ctx: LintContext, results: Array<{ rule: Rule; outcome: RuleOutcome }>): LintResult {
  // checks list the locale's own rules first, then the shared ones (golden order: DECH-SZ-01, then INTEGRITY-ENTITY)
  const own = new Set(ctx.profile.rules.map((r) => r.id));
  const ordered = [...results.filter((r) => own.has(r.rule.id)), ...results.filter((r) => !own.has(r.rule.id))];
  const checks = ordered.map(({ rule, outcome }) => checkOf(rule, outcome)).filter((c): c is DeterministicCheck => c !== null);
  return {
    checks,
    findings: results.flatMap((r) => r.outcome.violations.map((v) => v.finding)),
    review_reasons: [...new Set(results.flatMap((r) => r.outcome.reviewReasons ?? []))],
  };
}

/** Segment-level rules of the target profile, in `effective_rules` order. Never throws on odd input. */
export function lintSegment(input: LintSegmentInput, ctx: LintContext): LintResult {
  const seg = new SegmentView(input, ctx);
  const results: Array<{ rule: Rule; outcome: RuleOutcome }> = [];
  for (const rule of ctx.profile.effective_rules) {
    if (DOCUMENT_TYPES.has(rule.type) || !ruleApplies(rule, input)) continue;
    results.push({ rule, outcome: evaluateSegmentRule(rule, seg) });
  }
  return assemble(ctx, results);
}

/** Document-level rules (first_mention, currency_policy) over all segments in document order. */
export function lintDocument(inputs: LintSegmentInput[], ctx: LintContext): LintResult {
  const results: Array<{ rule: Rule; outcome: RuleOutcome }> = [];
  for (const rule of ctx.profile.effective_rules) {
    if (rule.type === 'first_mention') results.push({ rule, outcome: evaluateFirstMention(rule, inputs.filter((i) => ruleApplies(rule, i))) });
    else if (rule.type === 'currency_policy') results.push({ rule, outcome: evaluateCurrencyPolicy(rule, inputs.filter((i) => ruleApplies(rule, i)), ctx) });
  }
  return assemble(ctx, results);
}
