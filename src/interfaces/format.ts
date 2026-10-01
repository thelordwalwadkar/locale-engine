/** Human-readable renderings of engine results: CLI output and the text block of MCP results. Pure functions, no I/O. */
import path from 'node:path';
import type { CompareReport, ListLocalesResponse, LocaleResult, ProviderTestResult, RunReport, Severity } from '../schemas/index.js';

/** Shown instead of a score when a run skipped validation (translate-only / localize-only). */
export const NOT_VALIDATED_LABEL = 'n/a (not validated)';

type Align = 'l' | 'r';

export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[], align: readonly Align[] = []): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => (align[i] === 'r' ? cell.padStart(widths[i] ?? 0) : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

export const usd = (n: number): string => `$${n.toFixed(4)}`;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function openFindings(locale: LocaleResult): Record<Severity, number> {
  const counts: Record<Severity, number> = { minor: 0, major: 0, critical: 0 };
  const findings = [...locale.segments.flatMap((s) => s.validation?.findings ?? []), ...locale.document_findings];
  for (const finding of findings) if (finding.status === 'open') counts[finding.severity]++;
  return counts;
}

/** Translate-only and localize-only runs skip validation; their locales carry a verdict reason starting `NOT_VALIDATED`. */
export function isUnvalidated(report: RunReport, locale: LocaleResult): boolean {
  return !report.options.stages.validate || locale.verdict_reasons.some((reason) => reason.startsWith('NOT_VALIDATED'));
}

function localeRow(report: RunReport, locale: LocaleResult): string[] {
  const open = openFindings(locale);
  return [
    locale.target_locale,
    locale.verdict,
    isUnvalidated(report, locale) ? NOT_VALIDATED_LABEL : locale.quality_score.toFixed(1),
    `${open.minor}/${open.major}/${open.critical}`,
    String(locale.counts.human_review_segments),
    usd(locale.usage.cost_usd) + (locale.usage.unpriced_calls > 0 ? '*' : ''),
  ];
}

/** Warnings and errors of the run log, grouped by code: `PROVIDER_FALLBACK (warn) x2`. */
function logNotes(report: RunReport): string | undefined {
  const counts = new Map<string, number>();
  for (const { code, level } of report.run_log) {
    if (level !== 'warn' && level !== 'error') continue;
    const label = `${code} (${level})`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  return [...counts].map(([label, n]) => (n > 1 ? `${label} x${n}` : label)).join(', ');
}

function outputLines(report: RunReport): string[] {
  if (report.output_dir === null) return ['Output: not written (write_outputs is off)'];
  const top = report.artifacts.filter((a) => !/[\\/]/.test(a));
  const nested = report.artifacts.length - top.length;
  const files = [...top, ...(nested > 0 ? [`+ ${plural(nested, 'per-locale file')}`] : [])].join(', ');
  return [`Output: ${report.output_dir}`, ...(files ? [`        ${files}`] : [])];
}

/** The compact summary of a pipeline-family run: identity, source, one row per locale, notes, output folder. */
export function formatRunSummary(report: RunReport): string {
  const { source } = report;
  const pageType = source.page_type === 'LEGAL' ? `LEGAL (${source.page_type_evidence})` : source.page_type;
  const table = renderTable(
    ['Locale', 'Verdict', 'Score', 'Open min/maj/crit', 'Review', 'Cost'],
    report.locales.map((l) => localeRow(report, l)),
    ['l', 'l', 'r', 'r', 'r', 'r'],
  );
  const unpriced = report.locales.reduce((n, l) => n + l.usage.unpriced_calls, 0);
  const notes = logNotes(report);
  return [
    `Run ${report.run_id} | ${report.status} | ${seconds(report.duration_ms)} | ${usd(report.totals.cost_usd)}`,
    `Source: ${source.source_locale} (${source.source_language}) | page type ${pageType} | ${plural(source.segments, 'segment')}, ${plural(source.words, 'word')} | ${source.origin_ref}`,
    '',
    table,
    ...(unpriced > 0 ? ['', `* cost excludes ${plural(unpriced, 'call')} with unknown pricing`] : []),
    ...(report.locales.some((l) => isUnvalidated(report, l))
      ? ['', 'Validation did not run for this step; validate the <locale>/page.json files to get scores and verdicts.']
      : []),
    ...(notes ? ['', `Run log: ${notes} (details in run.json)`] : []),
    '',
    ...outputLines(report),
  ].join('\n');
}

function providerTotals(report: CompareReport, provider: string): { calls: number; input: number; output: number; cost: number; latency: number } {
  const rows = report.cost_latency.filter((r) => r.provider === provider);
  const all = rows.find((r) => r.stage === 'all');
  const use = all ? [all] : rows;
  return use.reduce(
    (t, r) => ({ calls: t.calls + r.calls, input: t.input + r.input_tokens, output: t.output + r.output_tokens, cost: t.cost + r.cost_usd, latency: t.latency + r.latency_ms }),
    { calls: 0, input: 0, output: 0, cost: 0, latency: 0 },
  );
}

/** Per provider and locale: verdict, score, findings; then cost and latency per provider; then the workbook path. */
export function formatCompareSummary(report: CompareReport): string {
  const scores = renderTable(
    ['Provider', 'Locale', 'Verdict', 'Score', 'Findings min/maj/crit'],
    report.scores.map((s) => [s.provider, s.locale, s.verdict, s.quality_score.toFixed(1), `${s.findings_minor}/${s.findings_major}/${s.findings_critical}`]),
    ['l', 'l', 'l', 'r', 'r'],
  );
  const costs = renderTable(
    ['Provider', 'Calls', 'Tokens in/out', 'Cost', 'Latency'],
    report.providers.map((p) => {
      const t = providerTotals(report, p);
      return [p, String(t.calls), `${t.input}/${t.output}`, usd(t.cost), seconds(t.latency)];
    }),
    ['l', 'r', 'r', 'r', 'r'],
  );
  const workbook = report.artifacts.find((a) => a.endsWith('model_comparison.xlsx'));
  const workbookLine =
    report.output_dir !== null && workbook !== undefined ? `Workbook: ${path.join(report.output_dir, workbook)}` : 'Workbook: not written (write_outputs is off)';
  return [
    `Comparison ${report.compare_id} | judge ${report.judge.provider}/${report.judge.model} | providers: ${report.providers.join(', ')}`,
    `Source: ${report.source.source_locale} (${report.source.source_language}) | ${plural(report.source.segments, 'segment')} | ${report.source.origin_ref}`,
    '',
    scores,
    '',
    costs,
    ...(report.notes.length > 0 ? ['', ...report.notes.map((n) => `Note: ${n}`)] : []),
    '',
    workbookLine,
  ].join('\n');
}

export function formatLocalesTable(response: ListLocalesResponse): string {
  return renderTable(
    ['Locale', 'Language', 'Region', 'Rules', 'Name'],
    response.locales.map((l) => [l.locale, l.language, l.region, String(l.rule_count), l.display_name]),
    ['l', 'l', 'l', 'r', 'l'],
  );
}

const firstLine = (text: string, max = 70): string => {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export function formatProvidersTable(results: readonly ProviderTestResult[]): string {
  return renderTable(
    ['Provider', 'Model', 'Configured', 'OK', 'Latency', 'Cost', 'Error'],
    results.map((r) => [
      r.provider,
      r.model,
      r.configured ? 'yes' : 'no',
      r.ok ? 'yes' : 'no',
      r.latency_ms === null ? '-' : `${Math.round(r.latency_ms)} ms`,
      r.cost_usd === null ? '-' : usd(r.cost_usd),
      r.error === null ? '' : firstLine(r.error),
    ]),
    ['l', 'l', 'l', 'l', 'r', 'r', 'l'],
  );
}
