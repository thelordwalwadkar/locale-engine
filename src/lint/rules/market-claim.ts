/**
 * `market_claim` (A-011): a source phrase that names a market as a scope of service is a business fact. It is the target's own
 * market when the claim's regions include the target region (generic "landelijk" claims belong to the SOURCE region). Otherwise the
 * segment needs a human unless `market_facts.<target>.delivery` confirms the fact, and a target that still restates the claim is a
 * finding. The supplied fact phrase itself may appear in the target.
 */
import { regionOf, type Span } from '../../schemas/index.js';
import { matchAll } from '../../util/regex.js';
import { escapeRegExp } from '../../util/text.js';
import { NO_OUTCOME, quote, ruleTag, violation, type RuleOutcome, type Violation } from '../draft.js';
import type { RuleOf, SegmentView } from '../segment.js';
import type { MarketClaim } from '../types.js';

function restates(t: MarketClaim, claim: MarketClaim, sourceRegion: string | undefined): boolean {
  if (claim.country !== null) return t.country === claim.country;
  return t.country === null || (sourceRegion !== undefined && t.regions.includes(sourceRegion));
}

function occurrences(text: string, phrase: string): Span[] {
  if (phrase.trim() === '') return [];
  const re = new RegExp(escapeRegExp(phrase.trim()).replace(/\s+/gu, '\\s+'), 'giu');
  return matchAll(re, text).map((m) => ({ start: m.start, end: m.end }));
}

const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

export function evaluateMarketClaim(rule: RuleOf<'market_claim'>, seg: SegmentView): RuleOutcome {
  const claims = seg.sourceClaims();
  if (claims.length === 0) return NO_OUTCOME;
  const { ctx, input } = seg;
  const sourceRegion = regionOf(input.source_locale);
  const fact = ctx.marketFacts?.delivery;
  const factSpans = fact !== undefined ? occurrences(seg.tgt.plain, fact) : [];
  const reasons: string[] = [];
  const violations: Violation[] = [];
  const flagged = new Set<string>();
  for (const claim of claims) {
    const ownMarket = claim.country !== null ? claim.regions.includes(ctx.profile.region) : sourceRegion === ctx.profile.region;
    if (ownMarket) continue;
    if (fact === undefined) reasons.push(`${rule.id}: source claims "${claim.phrase}" and no ${ctx.target} delivery fact is supplied`);
    for (const t of seg.targetClaims()) {
      const key = `${t.span.start}:${t.span.end}`;
      if (flagged.has(key) || !restates(t, claim, sourceRegion) || factSpans.some((f) => overlaps(f, t.span))) continue;
      flagged.add(key);
      const why = fact !== undefined ? `instead of the supplied ${ctx.target} fact ${quote(fact)}` : `although no ${ctx.target} delivery fact is supplied`;
      violations.push(
        violation(rule, {
          detail: `The source claims ${quote(claim.phrase)}; the target restates it as ${quote(t.phrase)} ${why}.`,
          segmentId: input.segment_id,
          span: seg.span(t.span.start, t.span.end),
          targetSpan: t.phrase,
          sourceSpan: claim.phrase,
          fix: fact !== undefined ? `Use ${quote(fact)}.` : undefined,
          humanReview: true,
        }),
      );
    }
  }
  return { violations, reviewReasons: [...new Set(reasons)], passNote: `${ruleTag(rule)} Market claims of the source are not restated for ${ctx.target}.` };
}
