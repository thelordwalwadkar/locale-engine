/**
 * `localization_report.xlsx`: the eight tabs of spec §6.5, in that order, driven purely by the run report. Every finding, change,
 * format change, recommendation and log entry of the report appears in its tab; nothing is sampled or summarised away.
 */
import ExcelJS from 'exceljs';
import type { Finding, FormatChange, LocaleResult, RunReport, SegmentResult, Severity, Verdict } from '../schemas/index.js';
import {
  NOT_VALIDATED_LABEL,
  bySourceOrder,
  describeProviders,
  isUnvalidated,
  localeFindings,
  openFindingCounts,
  parseTimestamp,
  topReviewReasons,
  unresolvedMarker,
} from './model.js';
import { putValue, writeTable, type CellInput, type CellStyle, type Column } from './xlsx-kit.js';

// Excel's own "Good / Neutral / Bad" palette, plus a lighter green so PASS and PASS_WITH_NOTES can be told apart at a glance.
const VERDICT_STYLE: Record<Verdict, CellStyle> = {
  PASS: { fill: 'FFA9D08E', font: 'FF1E4620' },
  PASS_WITH_NOTES: { fill: 'FFE2EFDA', font: 'FF375623' },
  HUMAN_REVIEW: { fill: 'FFFFEB9C', font: 'FF9C5700' },
  FAIL: { fill: 'FFFFC7CE', font: 'FF9C0006' },
};
const SEVERITY_STYLE: Record<Severity, CellStyle> = {
  critical: { fill: 'FFFFC7CE', font: 'FF9C0006' },
  major: { fill: 'FFF8CBAD', font: 'FF833C0B' },
  minor: { fill: 'FFFFF2CC', font: 'FF7F6000' },
};
const PROBLEM_STYLE: CellStyle = { fill: 'FFFDE8E8', font: 'FF9C1C1C' };
const LOG_LEVEL_STYLE: Record<string, CellStyle> = {
  warn: { fill: 'FFFFEB9C', font: 'FF9C5700' },
  error: { fill: 'FFFFC7CE', font: 'FF9C0006' },
};

/** Shown in the `segment_id` column of a finding that belongs to the page rather than to one segment. */
const DOCUMENT_LEVEL = '(document)';
const TOP_REVIEW_REASONS = 3;

// ---------------------------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------------------------

/** Run header block (label | value) above the per-locale table. Returns the number of rows written. */
function writeRunBlock(ws: ExcelJS.Worksheet, report: RunReport): number {
  const { source, totals } = report;
  const unpriced = totals.unpriced_calls > 0 ? `, excl. ${totals.unpriced_calls} unpriced call${totals.unpriced_calls === 1 ? '' : 's'}` : '';
  const entries: Array<[label: string, value: CellInput, numFmt?: string]> = [
    ['Run ID', report.run_id],
    ['Date (UTC)', parseTimestamp(report.started_at) ?? report.started_at],
    ['Status', report.status],
    [`Source ref (${source.origin_kind})`, source.origin_ref],
    ['Source locale / language', `${source.source_locale} / ${source.source_language}`],
    ['Page type', `${source.page_type} — ${source.page_type_evidence}`],
    ['Tool version', report.tool_version],
    [`Total cost (USD${unpriced})`, totals.cost_usd, '0.0000'],
    ['Calls', totals.calls, '#,##0'],
    ['Input tokens', totals.input_tokens, '#,##0'],
    ['Output tokens', totals.output_tokens, '#,##0'],
  ];
  entries.forEach(([label, value, numFmt], i) => {
    const labelCell = ws.getCell(i + 1, 1);
    labelCell.value = label;
    labelCell.font = { name: 'Calibri', size: 11, bold: true };
    const valueCell = ws.getCell(i + 1, 2);
    putValue(valueCell, value, numFmt);
    valueCell.alignment = { horizontal: 'left', vertical: 'top' };
  });
  return entries.length;
}

function summaryColumns(report: RunReport): Column<LocaleResult>[] {
  const validationRan = report.options.stages.validate;
  // Without validation the score means "no findings", not "verified": never show it as a number.
  const scored = (locale: LocaleResult, value: number): CellInput => (isUnvalidated(locale, validationRan) ? NOT_VALIDATED_LABEL : value);
  return [
    // Wide enough for the run-block labels that share column A.
    { header: 'Locale', value: (l) => l.target_locale, minWidth: 26 },
    { header: 'Verdict', value: (l) => l.verdict, style: (l) => VERDICT_STYLE[l.verdict] },
    { header: 'Quality score', value: (l) => scored(l, l.quality_score), numFmt: '0.0' },
    { header: 'Penalty', value: (l) => scored(l, l.penalty), numFmt: '0.00' },
    { header: 'Words', value: (l) => l.word_count, numFmt: '#,##0' },
    { header: 'Segments', value: (l) => l.counts.segments },
    { header: 'Findings minor (open)', value: (l) => openFindingCounts(l).minor },
    { header: 'Findings major (open)', value: (l) => openFindingCounts(l).major },
    { header: 'Findings critical (open)', value: (l) => openFindingCounts(l).critical },
    { header: 'Human-review segments', value: (l) => l.counts.human_review_segments },
    { header: 'Changes', value: (l) => l.counts.changes },
    { header: 'Format changes', value: (l) => l.counts.format_changes },
    { header: 'Repairs', value: (l) => l.counts.repairs },
    { header: 'Cost USD', value: (l) => l.usage.cost_usd, numFmt: '0.0000' },
    { header: 'Provider per stage', value: (l) => describeProviders(Object.keys(l.providers).length > 0 ? l.providers : report.routing), minWidth: 40 },
    { header: 'Top review reasons', value: (l) => topReviewReasons(l, TOP_REVIEW_REASONS).join('\n') },
    { header: 'Verdict reasons', value: (l) => l.verdict_reasons.join('\n') },
  ];
}

function addSummary(wb: ExcelJS.Workbook, report: RunReport): void {
  const ws = wb.addWorksheet('Summary');
  const blockRows = writeRunBlock(ws, report);
  // The table starts below the block (one blank row between). Freezing at its header keeps the column names in view.
  writeTable(ws, summaryColumns(report), report.locales, { headerRow: blockRows + 2, freezeColumns: 1 });
}

// ---------------------------------------------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------------------------------------------

interface SegmentRow {
  first: SegmentResult;
  byLocale: Map<string, SegmentResult>;
}

/** One row per segment id across all locales, in source order. */
function segmentRows(report: RunReport): SegmentRow[] {
  const rows = new Map<string, SegmentRow>();
  for (const locale of report.locales) {
    for (const seg of bySourceOrder(locale.segments)) {
      const row = rows.get(seg.segment_id) ?? { first: seg, byLocale: new Map<string, SegmentResult>() };
      row.byLocale.set(locale.target_locale, seg);
      rows.set(seg.segment_id, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.first.order - b.first.order);
}

function addSegments(wb: ExcelJS.Workbook, report: RunReport): void {
  // A segment a locale does not have at all is shown as NOT_PROCESSED rather than as an empty (publishable-looking) cell.
  const unresolved = (row: SegmentRow, code: string): boolean => {
    const seg = row.byLocale.get(code);
    return seg === undefined || unresolvedMarker(seg) !== null;
  };
  const localeColumns = report.locales.map(
    (locale): Column<SegmentRow> => ({
      header: locale.target_locale,
      value: (row) => {
        const seg = row.byLocale.get(locale.target_locale);
        return seg === undefined ? `[NOT_PROCESSED: ${row.first.segment_id}]` : (unresolvedMarker(seg) ?? seg.final_text);
      },
      style: (row) => (unresolved(row, locale.target_locale) ? PROBLEM_STYLE : undefined),
    }),
  );
  const columns: Column<SegmentRow>[] = [
    { header: 'segment_id', value: (r) => r.first.segment_id },
    { header: 'block_type', value: (r) => r.first.block_type },
    { header: 'meta_kind', value: (r) => r.first.meta_kind },
    // Per segment, not per page: a Dutch page with an English spec table lists both (spec §5.2 edge_mixed_language).
    { header: 'detected_language', value: (r) => r.first.source_lang },
    // Texts are shown exactly as stored, inline placeholders included, so a dropped or unbalanced tag is visible here.
    { header: 'source', value: (r) => r.first.source_text },
    ...localeColumns,
  ];
  writeTable(wb.addWorksheet('Segments'), columns, segmentRows(report), { freezeColumns: 1 });
}

// ---------------------------------------------------------------------------------------------------------------
// Validation_Findings, Localization_Changes, Market_Recommendations, SEO_Meta, Format_Changes, Run_Log
// ---------------------------------------------------------------------------------------------------------------

function addFindings(wb: ExcelJS.Workbook, report: RunReport): void {
  // `validation.findings` is the authoritative list: judge MQM errors are materialised as `llm_judge` findings by the pipeline.
  const rows = report.locales.flatMap((l) => localeFindings(l).map((finding) => ({ locale: l.target_locale, finding })));
  const columns: Column<{ locale: string; finding: Finding }>[] = [
    { header: 'locale', value: (r) => r.locale },
    { header: 'segment_id', value: (r) => r.finding.segment_id ?? DOCUMENT_LEVEL },
    { header: 'rule_or_category', value: (r) => r.finding.rule_or_category },
    { header: 'severity', value: (r) => r.finding.severity, style: (r) => SEVERITY_STYLE[r.finding.severity] },
    { header: 'evidence', value: (r) => r.finding.evidence },
    { header: 'explanation', value: (r) => r.finding.explanation },
    { header: 'source_span', value: (r) => r.finding.source_span },
    { header: 'target_span', value: (r) => r.finding.target_span },
    { header: 'suggested_fix', value: (r) => r.finding.suggested_fix },
    { header: 'origin', value: (r) => r.finding.origin },
    { header: 'status', value: (r) => r.finding.status },
    { header: 'finding_id', value: (r) => r.finding.finding_id },
  ];
  writeTable(wb.addWorksheet('Validation_Findings'), columns, rows, { freezeColumns: 2 });
}

interface ChangeRow {
  locale: string;
  segmentId: string;
  from: string;
  to: string;
  rule: string;
  reason: string;
  origin: string;
  note: string;
}

/** Localization changes plus repair records (origin `repair`); a repair the pipeline already recorded as a change is not listed twice. */
function changeRows(locale: LocaleResult): ChangeRow[] {
  const rows: ChangeRow[] = [];
  for (const seg of bySourceOrder(locale.segments)) {
    const base = { locale: locale.target_locale, segmentId: seg.segment_id };
    for (const c of seg.changes) {
      const note = c.to === '' && c.from !== '' ? 'text removed' : '';
      rows.push({ ...base, from: c.from, to: c.to, rule: c.rule, reason: c.reason, origin: c.origin, note });
    }
    for (const r of seg.repairs) {
      const recorded = seg.changes.some((c) => c.origin === 'repair' && c.rule === r.rule && c.from === r.before && c.to === r.after);
      if (recorded) continue;
      const how = r.origin === 'autofix' ? 'deterministic autofix' : 'LLM repair';
      const note = `loop ${r.loop} · ${how} · span ${r.span.start}-${r.span.end}`;
      rows.push({ ...base, from: r.before, to: r.after, rule: r.rule, reason: r.reason, origin: 'repair', note });
    }
  }
  return rows;
}

function addChanges(wb: ExcelJS.Workbook, report: RunReport): void {
  const columns: Column<ChangeRow>[] = [
    { header: 'locale', value: (r) => r.locale },
    { header: 'segment_id', value: (r) => r.segmentId },
    { header: 'from', value: (r) => r.from },
    { header: 'to', value: (r) => r.to },
    { header: 'rule', value: (r) => r.rule },
    { header: 'reason', value: (r) => r.reason },
    { header: 'origin', value: (r) => r.origin },
    { header: 'note', value: (r) => r.note },
  ];
  writeTable(wb.addWorksheet('Localization_Changes'), columns, report.locales.flatMap(changeRows), { freezeColumns: 2 });
}

interface RecommendationRow {
  locale: string;
  id: string;
  text: string;
  source: string;
  segmentId: string | null;
}

/** The locale's recommendations, plus any per-segment judge recommendation the pipeline did not aggregate into them. */
function recommendationRows(locale: LocaleResult): RecommendationRow[] {
  const rows = locale.recommendations.map(
    (r): RecommendationRow => ({ locale: locale.target_locale, id: r.id, text: r.text, source: r.source, segmentId: r.segment_id }),
  );
  const listed = new Set(locale.recommendations.map((r) => r.text));
  for (const seg of bySourceOrder(locale.segments)) {
    (seg.validation?.localization_recommendations ?? []).forEach((text, i) => {
      if (listed.has(text)) return;
      listed.add(text);
      rows.push({ locale: locale.target_locale, id: `${seg.segment_id}#rec-${i + 1}`, text, source: 'judge', segmentId: seg.segment_id });
    });
  }
  return rows;
}

function addRecommendations(wb: ExcelJS.Workbook, report: RunReport): void {
  const columns: Column<RecommendationRow>[] = [
    { header: 'locale', value: (r) => r.locale },
    { header: 'id', value: (r) => r.id },
    { header: 'recommendation', value: (r) => r.text, minWidth: 40 },
    { header: 'source', value: (r) => r.source },
    { header: 'segment_id', value: (r) => r.segmentId },
  ];
  writeTable(wb.addWorksheet('Market_Recommendations'), columns, report.locales.flatMap(recommendationRows), { freezeColumns: 1 });
}

const NO_KEYWORD_NOTE = '[HYPOTHESIS] No primary keyword was provided or derived for this page; run keyword research for this market.';

function addSeoMeta(wb: ExcelJS.Workbook, report: RunReport): void {
  const notOk: Column<LocaleResult>['style'] = (_row, value) => (value === false ? PROBLEM_STYLE : undefined);
  const columns: Column<LocaleResult>[] = [
    { header: 'locale', value: (l) => l.target_locale },
    { header: 'hreflang', value: (l) => l.seo_meta.hreflang },
    { header: 'title', value: (l) => l.seo_meta.title },
    { header: 'title_length', value: (l) => l.seo_meta.title_length },
    { header: 'title_max', value: (l) => l.seo_meta.title_max },
    { header: 'title_ok', value: (l) => l.seo_meta.title_ok, style: notOk },
    { header: 'meta_description', value: (l) => l.seo_meta.meta_description },
    { header: 'meta_description_length', value: (l) => l.seo_meta.meta_description_length },
    { header: 'meta_description_max', value: (l) => l.seo_meta.meta_description_max },
    { header: 'meta_description_ok', value: (l) => l.seo_meta.meta_description_ok, style: notOk },
    { header: 'slug', value: (l) => l.seo_meta.slug },
    { header: 'h1', value: (l) => l.seo_meta.h1 },
    { header: 'source_keyword', value: (l) => l.seo_meta.primary_keyword?.source },
    { header: 'source_keyword_origin', value: (l) => l.seo_meta.primary_keyword?.source_origin },
    { header: 'translated_keyword', value: (l) => l.seo_meta.primary_keyword?.translated },
    { header: 'keyword_status', value: (l) => l.seo_meta.primary_keyword?.keyword_status },
    { header: 'note', value: (l) => l.seo_meta.primary_keyword?.note ?? NO_KEYWORD_NOTE, minWidth: 40 },
  ];
  writeTable(wb.addWorksheet('SEO_Meta'), columns, report.locales, { freezeColumns: 1 });
}

function addFormatChanges(wb: ExcelJS.Workbook, report: RunReport): void {
  const rows = report.locales.flatMap((l) =>
    bySourceOrder(l.segments).flatMap((seg) => seg.format_changes.map((change) => ({ locale: l.target_locale, segmentId: seg.segment_id, change }))),
  );
  const columns: Column<{ locale: string; segmentId: string; change: FormatChange }>[] = [
    { header: 'locale', value: (r) => r.locale },
    { header: 'segment_id', value: (r) => r.segmentId },
    { header: 'aspect', value: (r) => r.change.aspect },
    { header: 'from', value: (r) => r.change.from },
    { header: 'to', value: (r) => r.change.to },
    { header: 'rule', value: (r) => r.change.rule },
    { header: 'origin', value: (r) => r.change.origin },
    { header: 'note', value: (r) => r.change.note },
  ];
  writeTable(wb.addWorksheet('Format_Changes'), columns, rows, { freezeColumns: 2 });
}

function addRunLog(wb: ExcelJS.Workbook, report: RunReport): void {
  const columns: Column<RunReport['run_log'][number]>[] = [
    { header: 'timestamp', value: (e) => parseTimestamp(e.ts) ?? e.ts, numFmt: 'yyyy-mm-dd hh:mm:ss.000' },
    { header: 'level', value: (e) => e.level, style: (e) => LOG_LEVEL_STYLE[e.level] },
    { header: 'code', value: (e) => e.code },
    { header: 'message', value: (e) => e.message, minWidth: 40 },
    { header: 'stage', value: (e) => e.stage },
    { header: 'provider', value: (e) => e.provider },
    { header: 'locale', value: (e) => e.locale },
    { header: 'segment_id', value: (e) => e.segment_id },
    { header: 'data', value: (e) => (e.data === undefined ? undefined : JSON.stringify(e.data)) },
  ];
  writeTable(wb.addWorksheet('Run_Log'), columns, report.run_log, { freezeColumns: 1 });
}

/** `localization_report.xlsx` with the eight tabs of spec §6.5. */
export async function buildReportWorkbook(report: RunReport): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'locale-engine';
  wb.lastModifiedBy = 'locale-engine';
  wb.title = `Localization report ${report.run_id}`;
  // Timestamps come from the report, not the clock, so the same report always yields the same workbook content.
  const stamp = parseTimestamp(report.finished_at) ?? parseTimestamp(report.started_at) ?? new Date(0);
  wb.created = stamp;
  wb.modified = stamp;

  addSummary(wb, report);
  addSegments(wb, report);
  addFindings(wb, report);
  addChanges(wb, report);
  addRecommendations(wb, report);
  addSeoMeta(wb, report);
  addFormatChanges(wb, report);
  addRunLog(wb, report);
  return wb;
}
