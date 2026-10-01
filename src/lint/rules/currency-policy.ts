/**
 * `currency_policy` (document level): amounts are retained in their source currency, never converted. For every source currency
 * other than the target's local one: a fact that the business prices in that currency is fine; no fact is a `[HYPOTHESIS]`
 * ("UK buyers expect GBP pricing — confirm currency policy."); a fact naming another currency means the business must supply prices.
 */
import { languageOf } from '../../schemas/index.js';
import { plainText } from '../../util/inline.js';
import { joinList, quote, ruleTag, violation, type RuleOutcome, type Violation } from '../draft.js';
import { brandForms, extractEntities } from '../entities.js';
import type { RuleOf } from '../segment.js';
import type { LintContext, LintSegmentInput } from '../types.js';

/** `inputs` are the in-scope segments in document order. */
export function evaluateCurrencyPolicy(rule: RuleOf<'currency_policy'>, inputs: LintSegmentInput[], ctx: LintContext): RuleOutcome {
  const amounts = new Map<string, string[]>();
  for (const input of inputs) {
    const lang = languageOf(input.source_lang || input.source_locale);
    for (const e of extractEntities(plainText(input.source_text), { lang, common: ctx.common, brands: brandForms(ctx.glossary) })) {
      if (e.kind !== 'currency' || !e.currency) continue;
      amounts.set(e.currency, [...(amounts.get(e.currency) ?? []), e.raw]);
    }
  }
  if (amounts.size === 0) return { violations: [] };
  const local = ctx.profile.formatting.currency.local_code;
  const priced = ctx.marketFacts?.currency;
  const violations: Violation[] = [];
  for (const [code, raws] of amounts) {
    if (code === local || priced === code) continue;
    const shown = joinList([...new Set(raws)].slice(0, 3).map(quote));
    const detail =
      priced === undefined
        ? `${ctx.profile.audience_label} buyers expect ${local} pricing — confirm currency policy.`
        : `Prices in ${priced} must be supplied by the business; the amounts were retained in ${code} (${shown}).`;
    violations.push(violation(rule, { detail, segmentId: null, sourceSpan: shown }));
  }
  return { violations, passNote: `${ruleTag(rule)} Source amounts match the currency policy for ${ctx.target}.` };
}
