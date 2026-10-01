/**
 * `executive_summary.md`: one page for stakeholders, plain and factual, derived from the run report only. Every list is capped so the
 * page stays at roughly 40-60 lines whatever the size of the run; the workbook holds the full detail.
 */
import type { Finding, LocaleResult, RunReport } from '../schemas/index.js';
import { EVIDENCE_TAG_RE, HYPOTHESIS_COUNSEL_TAG, HYPOTHESIS_TAG, KEYWORD_STATUS, evidenceTag } from '../schemas/index.js';
import { round } from '../util/text.js';
import { codeSpan, escapeMarkdownText } from './markdown.js';
import {
  NOT_VALIDATED_LABEL,
  SEVERITIES_WORST_FIRST,
  bySourceOrder,
  describeProviders,
  isUnvalidated,
  localeFindings,
  openFindingCounts,
  parseTimestamp,
} from './model.js';

const MAX_TOP_FINDINGS = 8;
const MAX_WARNING_LINES = 3;
const EXPLANATION_CHARS = 160;
const PHRASE_CHARS = 60;

/** Where the business records a confirmed fact; `<locale>` is literal, the fact names follow the market_facts.yaml template. */
const LOCALE_FACT = 'market_facts.<locale>';
const MARKET_CLAIM_RULE = 'INTEGRITY-MARKET-CLAIM';
const CURRENCY_POLICY_RULE = 'CURRENCY-POLICY';
/** Market checks that ask for local contact data are worded "…a Swiss contact number…" / "…Dutch phone numbers…". */
const CONTACT_HINT = /\b(?:contact (?:number|details|data)|phone|telephone)\b/i;
/** Run-log codes that change how far the results can be trusted; they are copied into the summary. */
const WARNING_CODES = new Set(['JUDGE_NOT_INDEPENDENT', 'PROVIDER_FALLBACK']);

const GLOBAL_TAG_RE = new RegExp(EVIDENCE_TAG_RE.source, 'g');

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const sentence = (...parts: string[]): string => parts.join(' ');

function formatUtc(ts: string): string {
  const date = parseTimestamp(ts);
  return date ? `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ts;
}

/** `de-CH 9, en-NL 5` for the locales whose count is not zero. */
function perLocale(locales: readonly LocaleResult[], pick: (l: LocaleResult) => number): string {
  return locales
    .map((l) => ({ code: l.target_locale, n: pick(l) }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.code} ${x.n}`)
    .join(', ');
}

function banners(report: RunReport): string[] {
  const lines: string[] = [];
  if (report.status === 'HALTED_COST_CEILING') {
    lines.push(
      sentence(
        '> **Run halted at the cost ceiling (HALTED_COST_CEILING).**',
        'Segments after the ceiling were not processed, so every result below is partial.',
      ),
    );
  } else if (report.status === 'PARTIAL') {
    lines.push(
      sentence('> **Partial run (PARTIAL).**', 'Some locales or segments are missing or failed, so every result below covers only what was produced.'),
    );
  } else if (report.status === 'FAILED') {
    lines.push(sentence('> **Run failed (FAILED).**', 'The run did not finish; treat every result below as incomplete.'));
  }
  if (!report.options.stages.validate) {
    lines.push(
      sentence(
        '> **Validation did not run** (translate-only or localize-only run).',
        'Scores are not available and every locale needs human review.',
      ),
    );
  }
  return lines.flatMap((line) => [line, '']);
}

function verdictTable(report: RunReport): string[] {
  if (report.locales.length === 0) return ['_No locale result was produced._'];
  const rows = report.locales.map((l) => {
    const open = openFindingCounts(l);
    const score = isUnvalidated(l, report.options.stages.validate) ? NOT_VALIDATED_LABEL : String(round(l.quality_score, 1));
    const findings = `${open.critical} / ${open.major} / ${open.minor}`;
    const cells = [l.target_locale, l.verdict, score, findings, String(l.counts.human_review_segments), l.usage.cost_usd.toFixed(4)];
    return `| ${cells.join(' | ')} |`;
  });
  return [
    '| Locale | Verdict | Score | Open findings (critical / major / minor) | Human review | Cost (USD) |',
    '| --- | --- | ---: | --- | ---: | ---: |',
    ...rows,
  ];
}

const mentions = (finding: Finding, needle: string): boolean =>
  [finding.rule_or_category, finding.evidence, finding.explanation].some((text) => text.includes(needle));

/** Locales in which a business market claim was neutralised, with the segments and the first removed phrase. */
function marketClaims(report: RunReport): Array<{ locale: string; text: string }> {
  const out: Array<{ locale: string; text: string }> = [];
  for (const locale of report.locales) {
    const segments = new Set<string>();
    const phrases: string[] = [];
    for (const seg of bySourceOrder(locale.segments)) {
      const changed = seg.changes.filter((c) => c.rule === MARKET_CLAIM_RULE);
      const reasoned = seg.review_reasons.some((r) => r.includes(MARKET_CLAIM_RULE));
      const judged = (seg.validation?.findings ?? []).some((f) => mentions(f, MARKET_CLAIM_RULE));
      if (changed.length === 0 && !reasoned && !judged) continue;
      segments.add(seg.segment_id);
      for (const c of changed) if (c.from !== '') phrases.push(c.from);
    }
    if (segments.size === 0) continue;
    const phrase = phrases[0];
    const clipped = phrase !== undefined && phrase.length > PHRASE_CHARS ? `${phrase.slice(0, PHRASE_CHARS - 1)}…` : phrase;
    const shown = clipped === undefined ? '' : ` ("${escapeMarkdownText(clipped)}")`;
    out.push({ locale: locale.target_locale, text: `${locale.target_locale} ${[...segments].join(', ')}${shown}` });
  }
  return out;
}

/** Business decisions derived from the data; empty when none is open. */
function decisions(report: RunReport): string[] {
  const out: string[] = [];
  const codesOf = (pick: (l: LocaleResult) => boolean): string => report.locales.filter(pick).map((l) => l.target_locale).join(', ');

  const claims = marketClaims(report);
  if (claims.length > 0) {
    out.push(
      sentence(
        `- **Delivery scope**: a market claim was neutralised in ${claims.map((c) => c.text).join('; ')}.`,
        `Confirm the claim for each market and add ${codeSpan(`${LOCALE_FACT}.delivery`)} for ${claims.map((c) => c.locale).join(', ')}.`,
        evidenceTag(MARKET_CLAIM_RULE),
      ),
    );
  }
  const currency = codesOf((l) => localeFindings(l).some((f) => f.status === 'open' && mentions(f, CURRENCY_POLICY_RULE)));
  if (currency !== '') {
    out.push(
      sentence(
        `- **Currency**: amounts were kept in their source currency (never converted) and flagged for ${currency}.`,
        `Confirm the pricing currency per market and add ${codeSpan(`${LOCALE_FACT}.currency`)}.`,
        HYPOTHESIS_TAG,
      ),
    );
  }
  const contact = codesOf((l) => l.recommendations.some((r) => CONTACT_HINT.test(r.text)));
  if (contact !== '') {
    out.push(
      sentence(
        `- **Contact data**: the market checks ask for a local contact number in ${contact}.`,
        `Supply ${codeSpan(`${LOCALE_FACT}.phone`)} (and email) where the business serves that market directly.`,
        HYPOTHESIS_TAG,
      ),
    );
  }
  if (report.source.page_type === 'LEGAL') {
    out.push(
      sentence(
        `- **Legal page**: the source was classified LEGAL (${escapeMarkdownText(report.source.page_type_evidence)}).`,
        'It was translated, not localised, and every segment is flagged for review; counsel must review each locale before publication.',
        HYPOTHESIS_COUNSEL_TAG,
      ),
    );
  }
  return out;
}

function changeLines(report: RunReport): string[] {
  const line = (label: string, pick: (l: LocaleResult) => number): string => {
    const total = report.locales.reduce((sum, l) => sum + pick(l), 0);
    const by = perLocale(report.locales, pick);
    return `- ${label}: ${total}${by === '' ? '' : ` (${by})`}`;
  };
  return [
    line('Localization changes (vocabulary, phrasing, market claims)', (l) => l.counts.changes),
    line('Format changes (numbers, currency, dates)', (l) => l.counts.format_changes),
    line('Repairs', (l) => l.counts.repairs),
  ];
}

function findingLine(rank: number, locale: string, f: Finding): string {
  const tag = f.evidence !== '' ? f.evidence : (f.explanation.match(EVIDENCE_TAG_RE)?.[0] ?? '');
  // The tag is moved to the end so clipping a long explanation can never cut it in half.
  const flat = f.explanation.replace(GLOBAL_TAG_RE, '').replace(/\s+/g, ' ').trim();
  const clipped = flat.length > EXPLANATION_CHARS ? `${flat.slice(0, EXPLANATION_CHARS - 1).trimEnd()}…` : flat;
  const where = f.segment_id ?? 'document';
  return `${rank}. **${f.severity}** · ${locale} · ${where} · ${codeSpan(f.rule_or_category)}: ${escapeMarkdownText(clipped)} ${tag}`.trimEnd();
}

function topFindings(report: RunReport): string[] {
  const ranked = report.locales.flatMap((l) =>
    localeFindings(l)
      .filter((f) => f.status === 'open' && f.severity !== 'minor')
      .map((f) => ({ locale: l.target_locale, finding: f })),
  );
  // Array.sort is stable, so equal severities keep locale order, then document order.
  ranked.sort((a, b) => SEVERITIES_WORST_FIRST.indexOf(a.finding.severity) - SEVERITIES_WORST_FIRST.indexOf(b.finding.severity));
  if (ranked.length === 0) return ['No open critical or major finding.'];
  const lines = ranked.slice(0, MAX_TOP_FINDINGS).map((r, i) => findingLine(i + 1, r.locale, r.finding));
  if (ranked.length > MAX_TOP_FINDINGS) {
    lines.push(`_…and ${ranked.length - MAX_TOP_FINDINGS} more open critical or major findings; see the Validation_Findings tab._`);
  }
  return lines;
}

function seoNote(report: RunReport): string[] {
  const keywords = report.locales.flatMap((l) => {
    const keyword = l.seo_meta.primary_keyword?.translated;
    return keyword ? [`${l.target_locale} ${codeSpan(keyword)}`] : [];
  });
  return [
    sentence(
      `Every translated primary keyword is ${codeSpan(KEYWORD_STATUS)} ${HYPOTHESIS_TAG}: it is a translation, not a measured search term.`,
      'Run keyword research for each market before publishing.',
      keywords.length > 0 ? `Translated keywords: ${keywords.join('; ')}.` : '',
    ).trimEnd(),
  ];
}

function providerAndCost(report: RunReport): string[] {
  const { totals, options } = report;
  const routing = describeProviders(report.routing);
  const ceiling = options.cost_ceiling_usd;
  const reached = report.status === 'HALTED_COST_CEILING' || (ceiling > 0 && totals.cost_usd >= ceiling);
  const share = ceiling > 0 ? ` (${round((totals.cost_usd / ceiling) * 100, 1)}%)` : '';
  const tokens = `${totals.input_tokens.toLocaleString('en-US')} input / ${totals.output_tokens.toLocaleString('en-US')} output tokens`;
  const unpriced = totals.unpriced_calls > 0 ? `; ${plural(totals.unpriced_calls, 'call')} without known pricing not included` : '';
  const lines = [
    `- Providers: ${routing === '' ? 'none recorded' : escapeMarkdownText(routing)}`,
    sentence(
      `- Cost: USD ${totals.cost_usd.toFixed(4)} of the USD ${ceiling.toFixed(2)} ceiling${share}; ceiling ${reached ? 'reached' : 'not reached'}.`,
      `${plural(totals.calls, 'call')}, ${tokens}${unpriced}.`,
    ),
  ];
  const seen = new Set<string>();
  const warnings = report.run_log.filter((entry) => {
    const key = `${entry.code}\u0000${entry.message}`;
    if (!WARNING_CODES.has(entry.code) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (warnings.length === 0) {
    lines.push(`- Warnings: none of ${[...WARNING_CODES].join(' / ')} in the run log.`);
  } else {
    for (const w of warnings.slice(0, MAX_WARNING_LINES)) lines.push(`- Warning ${codeSpan(w.code)}: ${escapeMarkdownText(w.message)}`);
    if (warnings.length > MAX_WARNING_LINES) lines.push(`- …and ${warnings.length - MAX_WARNING_LINES} more in the Run_Log tab.`);
  }
  return lines;
}

function nextSteps(report: RunReport, hasDecisions: boolean): string[] {
  const steps: string[] = [];
  const validated = report.options.stages.validate;
  if (!validated) steps.push(`Run validation (${codeSpan('locale validate')}) before publishing: this run produced no scores or findings.`);

  const reviewTotal = report.locales.reduce((sum, l) => sum + l.counts.human_review_segments, 0);
  if (reviewTotal > 0) {
    const where = perLocale(report.locales, (l) => l.counts.human_review_segments);
    steps.push(
      sentence(
        `Have a native speaker review the ${plural(reviewTotal, 'segment')} flagged for human review (${where});`,
        'the Segments and Validation_Findings tabs list them.',
      ),
    );
  }
  const failed = report.locales.filter((l) => validated && l.verdict === 'FAIL').map((l) => l.target_locale);
  if (failed.length > 0) steps.push(`Do not publish ${failed.join(', ')} (verdict FAIL): fix the open critical findings and re-run.`);
  if (hasDecisions) {
    steps.push(`Get the business decisions above answered, record the facts in ${codeSpan('config/market_facts.yaml')} and re-run the affected locales.`);
  }
  const missing = perLocale(report.locales, (l) => l.segments.filter((s) => s.status !== 'OK').length);
  if (missing !== '') {
    const raise = report.status === 'HALTED_COST_CEILING' ? ' Raise the cost ceiling first.' : '';
    steps.push(`Re-run the segments without output (PROVIDER_ERROR or NOT_PROCESSED): ${missing}.${raise}`);
  }
  if (report.source.page_type === 'LEGAL') steps.push('Send the translated legal pages to counsel for review.');
  steps.push('Run keyword research for the translated primary keywords before publishing.');
  return steps.map((step, i) => `${i + 1}. ${step}`);
}

/** One-page stakeholder summary (Markdown). */
export function executiveSummary(report: RunReport): string {
  const { source } = report;
  const runLine = [
    `Run ${codeSpan(report.run_id)}`,
    `started ${formatUtc(report.started_at)}`,
    `status ${report.status}`,
    `locale-engine ${escapeMarkdownText(report.tool_version)}`,
    `source ${codeSpan(source.origin_ref)} (${source.source_locale}, ${source.page_type})`,
    plural(report.locales.length, 'target locale'),
    `${plural(source.segments, 'segment')}, ${plural(source.words, 'word')}`,
  ].join(' · ');
  const decisionLines = decisions(report);

  return `${[
    '# Localization summary',
    '',
    runLine,
    '',
    ...banners(report),
    '## Verdict per locale',
    '',
    ...verdictTable(report),
    '',
    '## Decisions needed from the business',
    '',
    ...(decisionLines.length > 0 ? decisionLines : ['- No business decision is open.']),
    '',
    '## What was changed',
    '',
    ...changeLines(report),
    '',
    '## Top findings (open, critical first)',
    '',
    ...topFindings(report),
    '',
    '## SEO note',
    '',
    ...seoNote(report),
    '',
    '## Provider and cost',
    '',
    ...providerAndCost(report),
    '',
    '## Next steps',
    '',
    ...nextSteps(report, decisionLines.length > 0),
  ].join('\n')}\n`;
}
