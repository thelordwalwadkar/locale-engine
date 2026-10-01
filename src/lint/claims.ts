/**
 * Market-claim detection (A-011, rule INTEGRITY-MARKET-CLAIM). A claim is a phrase that names a country as a scope of service
 * ("levering in heel Nederland"); the phrases are data in `_common.yaml -> market_claims`. A country name alone is never a claim.
 */
import type { CommonConfig } from '../schemas/index.js';
import { matchAll } from '../util/regex.js';
import { escapeRegExp } from '../util/text.js';
import { rulePattern } from './patterns.js';
import type { MarketClaim } from './types.js';

interface ClaimPattern {
  re: RegExp;
  country: string | null;
  regions: string[];
}

const cache = new WeakMap<CommonConfig, ClaimPattern[]>();

function claimPatterns(common: CommonConfig): ClaimPattern[] {
  let patterns = cache.get(common);
  if (!patterns) {
    const mc = common.market_claims;
    patterns = [];
    for (const [country, def] of Object.entries(mc.countries)) {
      const names = [...def.names].sort((a, b) => b.length - a.length).map((n) => escapeRegExp(n).replace(/\s+/gu, '\\s+'));
      // the name must end at a word boundary: "in heel Nederland" is a claim, "Nederlandse" is not a country name
      const alternation = `(?:${names.join('|')})(?![\\p{L}\\p{N}_])`;
      for (const sp of mc.scope_patterns) patterns.push({ re: rulePattern(sp.replaceAll('{COUNTRY}', alternation)), country, regions: [...def.regions] });
    }
    for (const gp of mc.generic_scope_patterns) patterns.push({ re: rulePattern(gp), country: null, regions: [] });
    cache.set(common, patterns);
  }
  return patterns;
}

/** Market-claim phrases in plain text (overlaps resolved longest first), in text order. */
export function findMarketClaims(plainText: string, common: CommonConfig): MarketClaim[] {
  const found: MarketClaim[] = [];
  for (const p of claimPatterns(common)) {
    for (const m of matchAll(p.re, plainText)) {
      if (m.end > m.start) found.push({ phrase: m.text, country: p.country, regions: [...p.regions], span: { start: m.start, end: m.end } });
    }
  }
  found.sort((a, b) => b.span.end - b.span.start - (a.span.end - a.span.start) || a.span.start - b.span.start);
  const kept: MarketClaim[] = [];
  for (const c of found) {
    if (!kept.some((k) => c.span.start < k.span.end && k.span.start < c.span.end)) kept.push(c);
  }
  return kept.sort((a, b) => a.span.start - b.span.start);
}
