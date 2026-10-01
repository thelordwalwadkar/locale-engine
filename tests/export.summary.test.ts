import { describe, expect, it } from 'vitest';
import { executiveSummary } from '../src/export/index.js';
import type { RunReport } from '../src/schemas/index.js';
import { legalReport, localeOf, sampleReport, segmentOf } from './fixtures/export/sample-report.js';

const lineCount = (md: string): number => md.replace(/\n$/, '').split('\n').length;

/** The lines of one `## heading` section (without the heading and the blank line after it). */
function section(md: string, heading: string): string[] {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${heading}`));
  if (start < 0) throw new Error(`no section ${heading}`);
  const rest = lines.slice(start + 2);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l !== '');
}

/** Seven locales, every decision, many findings, many warnings, a halted run: the longest page the summary can become. */
function worstCase(): RunReport {
  const report = sampleReport();
  for (const code of ['de-DE', 'de-AT', 'en-GB', 'it-IT', 'nl-NL'] as const) {
    const copy = structuredClone(localeOf(report, 'de-CH'));
    copy.target_locale = code;
    copy.hreflang = code;
    report.locales.push(copy);
  }
  const de = localeOf(report, 'de-CH');
  const template = de.document_findings[0];
  if (!template) throw new Error('fixture: de-CH has a document finding');
  for (let i = 0; i < 14; i++) {
    de.document_findings.push({
      ...template,
      finding_id: `x-${i}`,
      severity: i % 2 === 0 ? 'major' : 'critical',
      rule_or_category: `RULE-${i}`,
      evidence: `[EVIDENCE: RULE-${i}]`,
      explanation: `${'A long explanation that has to be clipped. '.repeat(12)}[EVIDENCE: RULE-${i}]`,
    });
  }
  for (let i = 0; i < 10; i++) {
    report.run_log.push({ ts: '2026-09-30T10:00:30.000Z', level: 'warn', code: i % 2 === 0 ? 'PROVIDER_FALLBACK' : 'JUDGE_NOT_INDEPENDENT', message: `warning number ${i}` });
  }
  report.status = 'HALTED_COST_CEILING';
  report.source.page_type = 'LEGAL';
  return report;
}

describe('executive summary structure', () => {
  it('has the title, run line and the sections of the brief, in order', () => {
    const md = executiveSummary(sampleReport());
    const headings = md.split('\n').filter((l) => l.startsWith('#'));
    expect(headings).toEqual([
      '# Localization summary',
      '## Verdict per locale',
      '## Decisions needed from the business',
      '## What was changed',
      '## Top findings (open, critical first)',
      '## SEO note',
      '## Provider and cost',
      '## Next steps',
    ]);
    const run = md.split('\n')[2] as string;
    expect(run).toContain('`run-20260930-a1b2c3`');
    expect(run).toContain('started 2026-09-30 10:00 UTC');
    expect(run).toContain('status COMPLETE');
    expect(run).toContain('locale-engine 0.1.0');
    expect(run).toContain('`https://www.example.nl/producten/centrifugaalpompen` (nl-NL, CONTENT)');
    expect(run).toContain('2 target locales');
    expect(run).toContain('23 segments, 90 words');
  });

  it('fits on one page: about 40 to 60 lines', () => {
    const n = lineCount(executiveSummary(sampleReport()));
    expect(n).toBeGreaterThanOrEqual(40);
    expect(n).toBeLessThanOrEqual(60);
  });

  it('stays within about 65 lines in the worst case', () => {
    const md = executiveSummary(worstCase());
    expect(lineCount(md)).toBeLessThanOrEqual(65);
    expect(section(md, 'Top findings')).toHaveLength(9); // 8 findings and the "…and N more" line
    expect(section(md, 'Decisions needed')).toHaveLength(4);
  });

  it('is deterministic, LF only and ends with one newline', () => {
    const report = sampleReport();
    const md = executiveSummary(report);
    expect(executiveSummary(report)).toBe(md);
    expect(md).not.toContain('\r');
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('is plain and factual: no hype words', () => {
    for (const report of [sampleReport(), legalReport(), worstCase()]) {
      expect(executiveSummary(report)).not.toMatch(/world-class|leading|AI-powered|cutting-edge|best-in-class|state-of-the-art|revolutionary|seamless|powerful|game-changing/i);
    }
  });
});

describe('verdict table', () => {
  it('shows score, verdict, open findings by severity, human-review count and cost per locale', () => {
    const rows = section(executiveSummary(sampleReport()), 'Verdict per locale');
    expect(rows[0]).toBe('| Locale | Verdict | Score | Open findings (critical / major / minor) | Human review | Cost (USD) |');
    expect(rows[2]).toBe('| de-CH | HUMAN_REVIEW | 94 | 0 / 1 / 1 | 1 | 0.0250 |');
    expect(rows[3]).toBe('| en-NL | FAIL | 74 | 1 / 0 / 1 | 2 | 0.0171 |');
  });

  it('counts findings that are no longer open out of the table', () => {
    const report = sampleReport();
    for (const f of localeOf(report, 'en-NL').segments.flatMap((s) => s.validation?.findings ?? [])) f.status = 'fixed';
    expect(section(executiveSummary(report), 'Verdict per locale')[3]).toContain('| 0 / 0 / 0 |');
  });

  it('says so when there is no locale result', () => {
    const report = sampleReport();
    report.locales = [];
    expect(section(executiveSummary(report), 'Verdict per locale')).toEqual(['_No locale result was produced._']);
  });
});

describe('status banners', () => {
  const banner = (status: RunReport['status']): string[] => {
    const report = sampleReport();
    report.status = status;
    const lines = executiveSummary(report).split('\n');
    return lines.slice(3, lines.indexOf('## Verdict per locale')).filter((l) => l !== '');
  };

  it('says so at the top when the run was halted at the cost ceiling', () => {
    const top = banner('HALTED_COST_CEILING');
    expect(top).toHaveLength(1);
    expect(top[0]).toMatch(/^> \*\*Run halted at the cost ceiling \(HALTED_COST_CEILING\)\.\*\*/);
    expect(top[0]).toContain('partial');
  });

  it('says so at the top when the run is partial or failed', () => {
    expect(banner('PARTIAL')[0]).toMatch(/^> \*\*Partial run \(PARTIAL\)\.\*\*/);
    expect(banner('FAILED')[0]).toMatch(/^> \*\*Run failed \(FAILED\)\.\*\*/);
  });

  it('has no banner for a complete run', () => {
    expect(banner('COMPLETE')).toEqual([]);
  });

  it('reports a reached cost ceiling in the cost line', () => {
    const report = sampleReport();
    report.status = 'HALTED_COST_CEILING';
    expect(section(executiveSummary(report), 'Provider and cost').join('\n')).toContain('ceiling reached');
  });
});

describe('decisions needed from the business', () => {
  it('derives the delivery-scope decision from the neutralised market claim, per locale', () => {
    const decisions = section(executiveSummary(sampleReport()), 'Decisions needed');
    const delivery = decisions.find((l) => l.startsWith('- **Delivery scope**')) as string;
    expect(delivery).toContain('de-CH p-003 ("in den gesamten Niederlanden")');
    expect(delivery).toContain('`market_facts.<locale>.delivery` for de-CH');
    expect(delivery).not.toContain('en-NL'); // the claim is retained there: the claim country is the market itself
    expect(delivery).toContain('[EVIDENCE: INTEGRITY-MARKET-CLAIM]');
  });

  it('names every locale that needs a delivery fact', () => {
    const report = sampleReport();
    const copy = structuredClone(localeOf(report, 'de-CH'));
    copy.target_locale = 'de-AT';
    copy.hreflang = 'de-AT';
    report.locales.push(copy);
    const delivery = section(executiveSummary(report), 'Decisions needed').find((l) => l.startsWith('- **Delivery scope**')) as string;
    expect(delivery).toContain('de-CH p-003');
    expect(delivery).toContain('de-AT p-003');
    expect(delivery).toContain('for de-CH, de-AT');
  });

  it('derives the claim from a review reason or a judge finding even when no change recorded it', () => {
    const report = sampleReport();
    const de = localeOf(report, 'de-CH');
    segmentOf(de, 'p-003').changes = [];
    const delivery = section(executiveSummary(report), 'Decisions needed').find((l) => l.startsWith('- **Delivery scope**')) as string;
    expect(delivery).toContain('de-CH p-003');
    expect(delivery).not.toContain('("');
  });

  it('derives the currency decision from open currency-policy findings only', () => {
    const currency = (md: string): string | undefined => section(md, 'Decisions needed').find((l) => l.startsWith('- **Currency**'));
    const report = sampleReport();
    expect(currency(executiveSummary(report))).toContain('flagged for de-CH');
    expect(currency(executiveSummary(report))).toContain('`market_facts.<locale>.currency`');
    expect(currency(executiveSummary(report))).toContain('[HYPOTHESIS]');
    localeOf(report, 'de-CH').document_findings[0]!.status = 'accepted';
    expect(currency(executiveSummary(report))).toBeUndefined();
  });

  it('derives the contact-data decision from the market checks', () => {
    const contact = section(executiveSummary(sampleReport()), 'Decisions needed').find((l) => l.startsWith('- **Contact data**')) as string;
    expect(contact).toContain('de-CH, en-NL');
    expect(contact).toContain('`market_facts.<locale>.phone`');
    expect(contact).toContain('[HYPOTHESIS]');
  });

  it('routes legal pages to counsel review with the hypothesis tag', () => {
    const legal = section(executiveSummary(legalReport()), 'Decisions needed').find((l) => l.startsWith('- **Legal page**')) as string;
    expect(legal).toContain('url path contains "privacyverklaring"');
    expect(legal).toContain('counsel');
    expect(legal).toContain('[HYPOTHESIS] — verify with counsel');
    expect(section(executiveSummary(sampleReport()), 'Decisions needed').some((l) => l.includes('Legal page'))).toBe(false);
  });

  it('says that no decision is open when the data holds none', () => {
    const report = sampleReport();
    for (const l of report.locales) {
      for (const s of l.segments) {
        s.changes = s.changes.filter((c) => c.rule !== 'INTEGRITY-MARKET-CLAIM');
        s.review_reasons = s.review_reasons.filter((r) => !r.includes('INTEGRITY-MARKET-CLAIM'));
        if (s.validation) s.validation.findings = s.validation.findings.filter((f) => !f.explanation.includes('INTEGRITY-MARKET-CLAIM'));
      }
      l.document_findings = [];
      l.recommendations = l.recommendations.filter((r) => !/contact|phone/i.test(r.text));
    }
    const md = executiveSummary(report);
    expect(section(md, 'Decisions needed')).toEqual(['- No business decision is open.']);
    expect(section(md, 'Next steps').join('\n')).not.toContain('business decisions');
  });
});

describe('what was changed', () => {
  it('counts localization changes, format changes and repairs, in total and per locale', () => {
    expect(section(executiveSummary(sampleReport()), 'What was changed')).toEqual([
      '- Localization changes (vocabulary, phrasing, market claims): 8 (de-CH 6, en-NL 2)',
      '- Format changes (numbers, currency, dates): 4 (de-CH 2, en-NL 2)',
      '- Repairs: 2 (de-CH 2)',
    ]);
  });

  it('shows a plain zero when nothing was changed', () => {
    const report = sampleReport();
    for (const l of report.locales) l.counts.repairs = 0;
    expect(section(executiveSummary(report), 'What was changed')[2]).toBe('- Repairs: 0');
  });
});

describe('top findings', () => {
  it('lists open critical findings before open major ones, each with locale, segment, rule and evidence tag', () => {
    const findings = section(executiveSummary(sampleReport()), 'Top findings');
    expect(findings).toEqual([
      '1. **critical** · en-NL · p-007 · `INTEGRITY-ENTITY`: The phone number was altered: +31 20 123 4567 became +31 20 123 4576. [EVIDENCE: INTEGRITY-ENTITY]',
      '2. **major** · de-CH · p-003 · `accuracy/omission`: Deliberate neutralization; business must confirm Swiss delivery scope and lead time. [EVIDENCE: INTEGRITY-MARKET-CLAIM]',
    ]);
  });

  it('leaves out minor findings and findings that are fixed or accepted', () => {
    const findings = section(executiveSummary(sampleReport()), 'Top findings').join('\n');
    expect(findings).not.toContain('SEO-TITLE-LEN');
    expect(findings).not.toContain('DECH-SZ-01'); // critical, but fixed
    const report = sampleReport();
    for (const l of report.locales) for (const s of l.segments) for (const f of s.validation?.findings ?? []) f.status = 'accepted';
    expect(section(executiveSummary(report), 'Top findings')).toEqual(['No open critical or major finding.']);
  });

  it('shows at most eight, worst first, and says how many more there are', () => {
    const findings = section(executiveSummary(worstCase()), 'Top findings');
    expect(findings).toHaveLength(9);
    expect(findings.slice(0, 8).every((l, i) => l.startsWith(`${i + 1}. `))).toBe(true);
    const severities = findings.slice(0, 8).map((l) => /\*\*(critical|major)\*\*/.exec(l)?.[1]);
    expect(severities).toEqual([...severities].sort((a, b) => (a === b ? 0 : a === 'critical' ? -1 : 1)));
    expect(severities.filter((s) => s === 'critical').length).toBeGreaterThan(0);
    // 21 open critical or major findings (15 in de-CH, the golden major in five clones, 1 in en-NL); 8 are shown
    expect(findings[8]).toBe('_…and 13 more open critical or major findings; see the Validation_Findings tab._');
  });

  it('clips a long explanation without cutting the evidence tag, and escapes markup', () => {
    const report = worstCase();
    const f = localeOf(report, 'de-CH').document_findings.find((x) => x.finding_id === 'x-1');
    if (!f) throw new Error('fixture finding');
    f.explanation = `<script>alert(1)</script> | ${'word '.repeat(100)}[EVIDENCE: RULE-1]`;
    const line = section(executiveSummary(report), 'Top findings').find((l) => l.includes('RULE-1`')) as string;
    expect(line).not.toMatch(/(?<!\\)<script>/);
    expect(line).toContain('\\<script>alert(1)\\</script> | word');
    expect(line.endsWith('… [EVIDENCE: RULE-1]')).toBe(true);
    expect(line.length).toBeLessThan(330);
  });
});

describe('SEO note', () => {
  it('states that every translated keyword is unverified and lists them', () => {
    const [note] = section(executiveSummary(sampleReport()), 'SEO note');
    expect(note).toContain('`TRANSLATED_UNVERIFIED`');
    expect(note).toContain('[HYPOTHESIS]');
    expect(note).toContain('keyword research');
    expect(note).toContain('de-CH `Kreiselpumpe`; en-NL `centrifugal pump`');
  });

  it('still carries the note when no keyword exists', () => {
    const report = sampleReport();
    for (const l of report.locales) l.seo_meta.primary_keyword = null;
    const [note] = section(executiveSummary(report), 'SEO note');
    expect(note).toContain('keyword research');
    expect(note).not.toContain('Translated keywords');
  });
});

describe('provider and cost', () => {
  it('reports the provider per stage, the cost against the ceiling and the token counts', () => {
    const lines = section(executiveSummary(sampleReport()), 'Provider and cost');
    expect(lines[0]).toBe(
      '- Providers: translation: anthropic:fixture-model-a · localization: anthropic:fixture-model-a · validation: openai:fixture-model-b · backtranslation: openai:fixture-model-b · repair: anthropic:fixture-model-a',
    );
    expect(lines[1]).toBe('- Cost: USD 0.0421 of the USD 5.00 ceiling (0.8%); ceiling not reached. 9 calls, 12,840 input / 4,310 output tokens; 1 call without known pricing not included.');
  });

  it('copies JUDGE_NOT_INDEPENDENT and PROVIDER_FALLBACK warnings from the run log, and nothing else', () => {
    const lines = section(executiveSummary(sampleReport()), 'Provider and cost');
    expect(lines.slice(2)).toEqual([
      '- Warning `PROVIDER_FALLBACK`: google has no credentials; stage backtranslation falls back to openai',
      '- Warning `JUDGE_NOT_INDEPENDENT`: de-CH validation runs on the translation provider (anthropic); the judge is not independent',
    ]);
  });

  it('says so when the run log has no such warning, collapses duplicates and caps the list', () => {
    const quiet = sampleReport();
    quiet.run_log = quiet.run_log.filter((e) => e.code !== 'PROVIDER_FALLBACK' && e.code !== 'JUDGE_NOT_INDEPENDENT');
    expect(section(executiveSummary(quiet), 'Provider and cost')[2]).toBe('- Warnings: none of JUDGE_NOT_INDEPENDENT / PROVIDER_FALLBACK in the run log.');

    const noisy = sampleReport();
    const dup = noisy.run_log.find((e) => e.code === 'PROVIDER_FALLBACK');
    if (!dup) throw new Error('fixture log');
    noisy.run_log.push({ ...dup }, { ...dup });
    expect(section(executiveSummary(noisy), 'Provider and cost').filter((l) => l.includes('PROVIDER_FALLBACK'))).toHaveLength(1);

    const lines = section(executiveSummary(worstCase()), 'Provider and cost');
    expect(lines.filter((l) => l.startsWith('- Warning '))).toHaveLength(3);
    expect(lines[lines.length - 1]).toMatch(/^- …and \d+ more in the Run_Log tab\.$/);
  });
});

describe('next steps', () => {
  it('derives the steps from the data, numbered', () => {
    expect(section(executiveSummary(sampleReport()), 'Next steps')).toEqual([
      '1. Have a native speaker review the 3 segments flagged for human review (de-CH 1, en-NL 2); the Segments and Validation_Findings tabs list them.',
      '2. Do not publish en-NL (verdict FAIL): fix the open critical findings and re-run.',
      '3. Get the business decisions above answered, record the facts in `config/market_facts.yaml` and re-run the affected locales.',
      '4. Re-run the segments without output (PROVIDER_ERROR or NOT_PROCESSED): en-NL 1.',
      '5. Run keyword research for the translated primary keywords before publishing.',
    ]);
  });

  it('asks for counsel on a legal page and for a higher ceiling after a halt', () => {
    const steps = section(executiveSummary(legalReport()), 'Next steps').join('\n');
    expect(steps).toContain('Send the translated legal pages to counsel for review.');
    const halted = sampleReport();
    halted.status = 'HALTED_COST_CEILING';
    expect(section(executiveSummary(halted), 'Next steps').join('\n')).toContain('Raise the cost ceiling first.');
  });

  it('always ends with the keyword research step', () => {
    const report = sampleReport();
    report.locales = [];
    const steps = section(executiveSummary(report), 'Next steps');
    expect(steps).toEqual(['1. Run keyword research for the translated primary keywords before publishing.']);
  });
});

describe('runs without validation', () => {
  function unvalidated(): RunReport {
    const report = sampleReport();
    report.options.stages.validate = false;
    for (const l of report.locales) {
      l.verdict = 'HUMAN_REVIEW';
      l.verdict_reasons = ['NOT_VALIDATED: translate-only run [EVIDENCE: options.stages.validate=false]'];
      l.quality_score = 100;
      l.counts.human_review_segments = 0;
      for (const s of l.segments) s.validation = null;
      l.document_findings = [];
    }
    return report;
  }

  it('shows "n/a (not validated)" instead of a score, keeps the verdict, and says so at the top', () => {
    const md = executiveSummary(unvalidated());
    const rows = section(md, 'Verdict per locale');
    expect(rows[2]).toBe('| de-CH | HUMAN_REVIEW | n/a (not validated) | 0 / 0 / 0 | 0 | 0.0250 |');
    expect(rows[3]).toContain('| en-NL | HUMAN_REVIEW | n/a (not validated) |');
    expect(md).not.toContain('| 100 |');
    const top = md.split('\n').slice(3, md.split('\n').indexOf('## Verdict per locale')).filter((l) => l !== '');
    expect(top).toEqual(['> **Validation did not run** (translate-only or localize-only run). Scores are not available and every locale needs human review.']);
  });

  it('points to validation as the first next step and does not claim FAIL locales', () => {
    const steps = section(executiveSummary(unvalidated()), 'Next steps');
    expect(steps[0]).toBe('1. Run validation (`locale validate`) before publishing: this run produced no scores or findings.');
    expect(steps.join('\n')).not.toContain('verdict FAIL');
  });

  it('also recognises a single unvalidated locale by its NOT_VALIDATED verdict reason', () => {
    const report = sampleReport();
    localeOf(report, 'en-NL').verdict_reasons = ['NOT_VALIDATED: provider failed'];
    const rows = section(executiveSummary(report), 'Verdict per locale');
    expect(rows[2]).toContain('| 94 |');
    expect(rows[3]).toContain('| n/a (not validated) |');
  });
});

describe('markdown safety', () => {
  it('keeps references with backticks and messages with pipes or markup harmless', () => {
    const report = sampleReport();
    report.source.origin_ref = 'https://example.nl/a`b';
    report.run_log.push({ ts: '2026-09-30T10:00:40.000Z', level: 'warn', code: 'JUDGE_NOT_INDEPENDENT', message: 'a | b <script>alert(1)</script>' });
    const md = executiveSummary(report);
    expect(md).toContain('source ``https://example.nl/a`b``');
    expect(md).toContain('a | b \\<script>alert(1)\\</script>');
    expect(md).not.toMatch(/(?<!\\)<\/?script>/);
  });
});
