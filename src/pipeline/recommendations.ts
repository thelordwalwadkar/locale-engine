/** Per-locale market recommendations: profile market checks, judge suggestions and pipeline-derived hints — every one tagged (spec §4.2, §6.5). */
import type { Recommendation } from '../schemas/report.js';
import { ensureTagged, hypothesisRecommendation } from './evidence.js';
import type { LocaleContext, SegState } from './state.js';

export function buildRecommendations(lc: LocaleContext, states: SegState[]): Recommendation[] {
  const out: Recommendation[] = [];
  const seen = new Set<string>();
  const add = (r: Recommendation): void => {
    const key = r.text.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };

  // 1. Market checks of the locale profile. Legal pages get the legal checks, content pages the general ones.
  const wanted = lc.pageType === 'LEGAL' ? 'legal_page' : 'always';
  for (const c of lc.profile.market_checks.filter((m) => m.applies === wanted)) {
    add({ id: c.id, locale: lc.target, text: hypothesisRecommendation(c.text, c.verify_with_counsel), source: 'market_check', segment_id: null });
  }

  // 2. Judge recommendations (already tagged; untagged ones become hypotheses).
  let j = 0;
  for (const s of states) {
    for (const text of s.validation?.recommendations ?? []) {
      add({ id: `REC-${lc.target}-J${++j}`, locale: lc.target, text: ensureTagged(text).text, source: 'judge', segment_id: s.seg.segment_id });
    }
  }

  // 3. Pipeline hints.
  const neutralised = states.filter((s) => s.claimActions.some((a) => a.action === 'NEUTRALIZE'));
  if (neutralised.length) {
    add({
      id: `PIPE-CLAIM-${lc.target}`,
      locale: lc.target,
      text: `[HYPOTHESIS] ${neutralised.length} segment(s) contained a geographic claim that was neutralised because config/market_facts.yaml has no ${lc.target}.delivery entry. Confirm the delivery area and lead time for this market and add them so the claim can be published.`,
      source: 'pipeline',
      segment_id: null,
    });
  }
  for (const f of lc.docFindings.filter((x) => x.evidence.startsWith('[HYPOTHESIS]'))) {
    // The finding reads "<rule message> <specific sentence> [HYPOTHESIS]"; the recommendation is the specific sentence.
    const rule = lc.profile.effective_rules.find((r) => r.id === f.rule_or_category);
    let detail = f.explanation.replace(f.evidence, '').trim();
    if (rule && detail.startsWith(rule.message)) detail = detail.slice(rule.message.length).trim();
    add({ id: `PIPE-${f.rule_or_category}-${lc.target}`, locale: lc.target, text: hypothesisRecommendation(detail || f.explanation), source: 'pipeline', segment_id: f.segment_id });
  }
  const kw = lc.doc.seo.primary_keyword;
  if (kw) {
    add({
      id: `PIPE-KEYWORD-${lc.target}`,
      locale: lc.target,
      text: `[HYPOTHESIS] The translated primary keyword is not market-validated; run keyword research for ${lc.target} (source keyword: "${kw.text}") before it is used as a target term.`,
      source: 'pipeline',
      segment_id: null,
    });
  }
  return out;
}
