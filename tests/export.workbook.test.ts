import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildReportWorkbook } from '../src/export/index.js';
import type { LocaleResult, RunReport } from '../src/schemas/index.js';
import { GOLDEN_LOCALIZED, localeOf, sampleReport, segmentOf } from './fixtures/export/sample-report.js';

const TABS = ['Summary', 'Segments', 'Validation_Findings', 'Localization_Changes', 'Market_Recommendations', 'SEO_Meta', 'Format_Changes', 'Run_Log'];
/** The Summary table starts below the 11-row run block and one blank row. */
const HEADER_ROW: Record<string, number> = { Summary: 13 };
const FROZEN_COLUMNS: Record<string, number> = {
  Summary: 1,
  Segments: 1,
  Validation_Findings: 2,
  Localization_Changes: 2,
  Market_Recommendations: 1,
  SEO_Meta: 1,
  Format_Changes: 2,
  Run_Log: 1,
};

/** Builds the workbook, writes it to bytes and reads it back, so the tests see what Excel would see. */
async function load(report: RunReport): Promise<ExcelJS.Workbook> {
  const built = await buildReportWorkbook(report);
  const reread = new ExcelJS.Workbook();
  await reread.xlsx.load(await built.xlsx.writeBuffer());
  return reread;
}

function sheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`no sheet ${name}`);
  return ws;
}

type Rec = Record<string, ExcelJS.CellValue>;

/** Data rows below the header as header-keyed records. */
function records(ws: ExcelJS.Worksheet): Rec[] {
  const headerRow = HEADER_ROW[ws.name] ?? 1;
  const headers = (ws.getRow(headerRow).values as ExcelJS.CellValue[]).slice(1).map(String);
  const out: Rec[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    out.push(Object.fromEntries(headers.map((h, i) => [h, row.getCell(i + 1).value])));
  }
  return out;
}

/** 1-based column number of a header. */
function columnOf(ws: ExcelJS.Worksheet, header: string): number {
  const headers = (ws.getRow(HEADER_ROW[ws.name] ?? 1).values as ExcelJS.CellValue[]).slice(1).map(String);
  const col = headers.indexOf(header);
  if (col < 0) throw new Error(`no column ${header} in ${ws.name}`);
  return col + 1;
}

function cellOf(ws: ExcelJS.Worksheet, header: string, rowIndex: number): ExcelJS.Cell {
  return ws.getRow((HEADER_ROW[ws.name] ?? 1) + 1 + rowIndex).getCell(columnOf(ws, header));
}

const fillOf = (cell: ExcelJS.Cell): string | undefined => (cell.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;

function clone(report: RunReport, from: 'de-CH' | 'en-NL', to: LocaleResult['target_locale'], verdict: LocaleResult['verdict']): void {
  const copy = structuredClone(localeOf(report, from));
  copy.target_locale = to;
  copy.hreflang = to;
  copy.verdict = verdict;
  report.locales.push(copy);
}

describe('workbook structure', () => {
  it('has exactly the eight tabs of the spec, in order', async () => {
    const wb = await load(sampleReport());
    expect(wb.worksheets.map((w) => w.name)).toEqual(TABS);
  });

  it('gives every tab a bold filled header, a frozen header, frozen first columns and an autofilter over the data', async () => {
    const wb = await load(sampleReport());
    for (const ws of wb.worksheets) {
      const headerRow = HEADER_ROW[ws.name] ?? 1;
      const first = ws.getRow(headerRow).getCell(1);
      expect(first.font?.bold, `${ws.name} header bold`).toBe(true);
      expect(first.fill, `${ws.name} header fill`).toMatchObject({ type: 'pattern', pattern: 'solid' });
      const view = ws.views[0];
      expect(view, `${ws.name} view`).toMatchObject({ state: 'frozen', ySplit: headerRow, xSplit: FROZEN_COLUMNS[ws.name] });
      const lastColumn = ws.getColumn(ws.columnCount).letter;
      expect(ws.autoFilter, `${ws.name} filter`).toBe(`A${headerRow}:${lastColumn}${ws.rowCount}`);
      for (let c = 1; c <= ws.columnCount; c++) expect(ws.getRow(headerRow).getCell(c).font?.bold).toBe(true);
    }
  });

  it('keeps empty tabs: header, freeze and filter stay, and no "none" row is added', async () => {
    const report = sampleReport();
    report.locales = [];
    report.run_log = [];
    const wb = await load(report);
    for (const ws of wb.worksheets) {
      const headerRow = HEADER_ROW[ws.name] ?? 1;
      expect(ws.rowCount, ws.name).toBe(headerRow);
      expect(ws.getRow(headerRow).getCell(1).font?.bold).toBe(true);
      expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: headerRow });
      expect(ws.autoFilter).toBe(`A${headerRow}:${ws.getColumn(ws.columnCount).letter}${headerRow}`);
    }
  });

  it('uses content-based widths capped at 60 and wraps text', async () => {
    const report = sampleReport();
    segmentOf(localeOf(report, 'de-CH'), 'p-019').final_text = 'Sehr langer Text '.repeat(40);
    const ws = sheet(await load(report), 'Segments');
    const width = (h: string): number => ws.getColumn(columnOf(ws, h)).width ?? 0;
    expect(width('segment_id')).toBeGreaterThanOrEqual(12);
    expect(width('segment_id')).toBeLessThan(25);
    expect(width('de-CH')).toBe(60);
    expect(cellOf(ws, 'de-CH', 0).alignment).toMatchObject({ wrapText: true, vertical: 'top' });
  });

  it('is deterministic: same report, same cells, workbook dated from the report', async () => {
    const report = sampleReport();
    const a = await load(report);
    const b = await load(report);
    const dump = (wb: ExcelJS.Workbook): string => JSON.stringify(wb.worksheets.map((w) => w.getSheetValues()));
    expect(dump(a)).toBe(dump(b));
    expect(a.created.toISOString()).toBe('2026-09-30T10:00:21.000Z'); // finished_at, at the one-second precision of xlsx metadata
    expect(a.creator).toBe('locale-engine');
  });
});

describe('Summary', () => {
  it('starts with the run block: run, date, status, source, page type, version, cost, calls, tokens', async () => {
    const ws = sheet(await load(sampleReport()), 'Summary');
    const block = Array.from({ length: 11 }, (_, i) => [ws.getCell(i + 1, 1).value, ws.getCell(i + 1, 2).value]);
    expect(block).toEqual([
      ['Run ID', 'run-20260930-a1b2c3'],
      ['Date (UTC)', new Date('2026-09-30T10:00:00.000Z')],
      ['Status', 'COMPLETE'],
      ['Source ref (url)', 'https://www.example.nl/producten/centrifugaalpompen'],
      ['Source locale / language', 'nl-NL / nl'],
      ['Page type', 'CONTENT — no legal marker in the URL path or the title'],
      ['Tool version', '0.1.0'],
      ['Total cost (USD, excl. 1 unpriced call)', 0.0421],
      ['Calls', 9],
      ['Input tokens', 12840],
      ['Output tokens', 4310],
    ]);
    expect(ws.getCell(1, 1).font?.bold).toBe(true);
    expect(ws.getCell(8, 2).numFmt).toBe('0.0000');
    expect(ws.getRow(12).hasValues).toBe(false);
  });

  it('lists one row per locale with typed numbers', async () => {
    const ws = sheet(await load(sampleReport()), 'Summary');
    const rows = records(ws);
    expect(Object.keys(rows[0] as Rec)).toEqual([
      'Locale',
      'Verdict',
      'Quality score',
      'Penalty',
      'Words',
      'Segments',
      'Findings minor (open)',
      'Findings major (open)',
      'Findings critical (open)',
      'Human-review segments',
      'Changes',
      'Format changes',
      'Repairs',
      'Cost USD',
      'Provider per stage',
      'Top review reasons',
      'Verdict reasons',
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      Locale: 'de-CH',
      Verdict: 'HUMAN_REVIEW',
      'Quality score': 94,
      Penalty: 6,
      Words: 90,
      Segments: 23,
      'Findings minor (open)': 1,
      'Findings major (open)': 1,
      'Findings critical (open)': 0,
      'Human-review segments': 1,
      Changes: 6,
      'Format changes': 2,
      Repairs: 2,
      'Cost USD': 0.025,
    });
    expect(rows[1]).toMatchObject({
      Locale: 'en-NL',
      Verdict: 'FAIL',
      'Quality score': 74,
      'Findings minor (open)': 1,
      'Findings major (open)': 0,
      'Findings critical (open)': 1,
      'Human-review segments': 2,
    });
    expect(cellOf(ws, 'Quality score', 0).numFmt).toBe('0.0');
    expect(cellOf(ws, 'Quality score', 0).type).toBe(ExcelJS.ValueType.Number);
  });

  it('counts only open findings per severity (fixed ones are history)', async () => {
    const report = sampleReport();
    for (const seg of localeOf(report, 'de-CH').segments) for (const f of seg.validation?.findings ?? []) f.status = 'open';
    const rows = records(sheet(await load(report), 'Summary'));
    expect(rows[0]).toMatchObject({ 'Findings minor (open)': 2, 'Findings major (open)': 1, 'Findings critical (open)': 1 });
  });

  it('shows the provider per stage, the top review reasons and the verdict reasons', async () => {
    const rows = records(sheet(await load(sampleReport()), 'Summary'));
    expect(rows[0]?.['Provider per stage']).toBe(
      'translation: anthropic:fixture-model-a · localization: anthropic:fixture-model-a · validation: anthropic:fixture-model-a · backtranslation: anthropic:fixture-model-a · repair: anthropic:fixture-model-a',
    );
    expect(rows[1]?.['Provider per stage']).toBe(
      'translation: anthropic:fixture-model-a · localization: anthropic:fixture-model-a · validation: openai:fixture-model-b · backtranslation: openai:fixture-model-b',
    );
    expect(rows[0]?.['Top review reasons']).toBe('INTEGRITY-MARKET-CLAIM: source claims "in heel Nederland" and no de-CH delivery fact is supplied');
    expect(rows[1]?.['Top review reasons']).toBe('INTEGRITY-ENTITY: phone number altered and not repaired after 2 loops\nPROVIDER_ERROR: retries exhausted');
    expect(String(rows[0]?.['Verdict reasons'])).toContain('[EVIDENCE: INTEGRITY-MARKET-CLAIM]');
  });

  it('counts repeated review reasons and keeps the most frequent three', async () => {
    const report = sampleReport();
    const de = localeOf(report, 'de-CH');
    for (const id of ['h-002', 'li-004', 'li-005']) segmentOf(de, id).review_reasons = ['LEGAL: counsel review'];
    segmentOf(de, 'p-019').review_reasons = ['R2'];
    segmentOf(de, 'p-007').review_reasons = ['R3', 'R4'];
    const reasons = String(records(sheet(await load(report), 'Summary'))[0]?.['Top review reasons']).split('\n');
    expect(reasons).toHaveLength(3);
    expect(reasons[0]).toBe('LEGAL: counsel review (×3)');
  });

  it('colour-codes the verdict: PASS green, PASS_WITH_NOTES light green, HUMAN_REVIEW amber, FAIL red', async () => {
    const report = sampleReport();
    clone(report, 'de-CH', 'de-DE', 'PASS');
    clone(report, 'de-CH', 'de-AT', 'PASS_WITH_NOTES');
    const ws = sheet(await load(report), 'Summary');
    const fills = [0, 1, 2, 3].map((i) => [cellOf(ws, 'Verdict', i).value, fillOf(cellOf(ws, 'Verdict', i))]);
    expect(fills).toEqual([
      ['HUMAN_REVIEW', 'FFFFEB9C'],
      ['FAIL', 'FFFFC7CE'],
      ['PASS', 'FFA9D08E'],
      ['PASS_WITH_NOTES', 'FFE2EFDA'],
    ]);
    expect(new Set(fills.map((f) => f[1])).size).toBe(4);
    expect(cellOf(ws, 'Verdict', 1).font?.color?.argb).toBe('FF9C0006');
  });

  it('shows "n/a (not validated)" instead of score and penalty when validation did not run', async () => {
    const report = sampleReport();
    report.options.stages.validate = false;
    for (const l of report.locales) {
      l.verdict = 'HUMAN_REVIEW';
      l.verdict_reasons = ['NOT_VALIDATED: translate-only run [EVIDENCE: options.stages.validate=false]'];
      l.quality_score = 100;
      l.penalty = 0;
    }
    const ws = sheet(await load(report), 'Summary');
    for (let i = 0; i < 2; i++) {
      expect(cellOf(ws, 'Quality score', i).value).toBe('n/a (not validated)');
      expect(cellOf(ws, 'Penalty', i).value).toBe('n/a (not validated)');
      expect(cellOf(ws, 'Verdict', i).value).toBe('HUMAN_REVIEW');
      expect(String(cellOf(ws, 'Verdict reasons', i).value)).toContain('NOT_VALIDATED');
    }
  });

  it('also recognises an unvalidated locale by its NOT_VALIDATED verdict reason', async () => {
    const report = sampleReport();
    localeOf(report, 'en-NL').verdict_reasons = ['NOT_VALIDATED: provider failed'];
    const ws = sheet(await load(report), 'Summary');
    expect(cellOf(ws, 'Quality score', 0).value).toBe(94);
    expect(cellOf(ws, 'Quality score', 1).value).toBe('n/a (not validated)');
  });
});

describe('Segments', () => {
  it('has the fixed columns and one column per target locale', async () => {
    const ws = sheet(await load(sampleReport()), 'Segments');
    expect((ws.getRow(1).values as ExcelJS.CellValue[]).slice(1)).toEqual(['segment_id', 'block_type', 'meta_kind', 'detected_language', 'source', 'de-CH', 'en-NL']);
  });

  it('lists every segment once, in source order, with source and final texts as stored', async () => {
    const rows = records(sheet(await load(sampleReport()), 'Segments'));
    expect(rows).toHaveLength(23);
    expect(rows.map((r) => r['segment_id']).slice(0, 7)).toEqual(['meta-title', 'meta-description', 'meta-slug', 'meta-keyword', 'h-001', 'h-002', 'p-003']);
    const golden = rows.find((r) => r['segment_id'] === 'p-003');
    expect(golden).toMatchObject({ block_type: 'paragraph', 'de-CH': GOLDEN_LOCALIZED });
    expect(String(golden?.['source'])).toContain('in heel Nederland');
    const li = rows.find((r) => r['segment_id'] === 'li-004');
    expect(li?.['source']).toBe('Bekijk onze <a1>pompenreeks</a1> voor elke toepassing');
    expect(li?.['de-CH']).toBe('Sehen Sie sich unsere <a1>Pumpenreihe</a1> für jede Anwendung an');
    expect(rows.find((r) => r['segment_id'] === 'meta-title')).toMatchObject({ block_type: 'meta', meta_kind: 'title' });
  });

  it('lists the detected language per segment (mixed-language pages)', async () => {
    const rows = records(sheet(await load(sampleReport()), 'Segments'));
    const languages = new Set(rows.map((r) => r['detected_language']));
    expect(languages).toEqual(new Set(['nl', 'en']));
    expect(rows.find((r) => r['segment_id'] === 'td-012')?.['detected_language']).toBe('en');
    expect(rows.find((r) => r['segment_id'] === 'p-003')?.['detected_language']).toBe('nl');
  });

  it('shows a marker, highlighted, for segments without output', async () => {
    const report = sampleReport();
    const de = localeOf(report, 'de-CH');
    const ns = segmentOf(de, 'p-007');
    ns.status = 'NOT_PROCESSED';
    ns.final_text = null;
    de.segments = de.segments.filter((s) => s.segment_id !== 'h-002'); // a segment the locale does not have at all
    const ws = sheet(await load(report), 'Segments');
    const rows = records(ws);
    const index = (id: string): number => rows.findIndex((r) => r['segment_id'] === id);
    expect(rows[index('p-019')]?.['en-NL']).toBe('[PROVIDER_ERROR: p-019]');
    expect(fillOf(cellOf(ws, 'en-NL', index('p-019')))).toBe('FFFDE8E8');
    expect(rows[index('p-007')]?.['de-CH']).toBe('[NOT_PROCESSED: p-007]');
    expect(rows[index('h-002')]?.['de-CH']).toBe('[NOT_PROCESSED: h-002]');
    expect(rows[index('h-002')]?.['en-NL']).toBe('Why choose our pumps?');
    expect(fillOf(cellOf(ws, 'de-CH', index('p-003')))).toBeUndefined();
  });
});

describe('Validation_Findings', () => {
  it('lists every finding, segment-level and document-level, open or not', async () => {
    const ws = sheet(await load(sampleReport()), 'Validation_Findings');
    const rows = records(ws);
    expect(rows.map((r) => r['finding_id'])).toEqual(['de-CH-f-003', 'de-CH-f-001', 'de-CH-f-002', 'de-CH-f-004', 'en-NL-f-002', 'en-NL-f-001']);
    expect(rows.map((r) => r['status'])).toEqual(['fixed', 'open', 'fixed', 'open', 'open', 'open']);
  });

  it('carries locale, segment, rule or category, evidence tag, explanation, spans, fix and origin', async () => {
    const rows = records(sheet(await load(sampleReport()), 'Validation_Findings'));
    expect(rows[1]).toEqual({
      locale: 'de-CH',
      segment_id: 'p-003',
      rule_or_category: 'accuracy/omission',
      severity: 'major',
      evidence: '[EVIDENCE: INTEGRITY-MARKET-CLAIM]',
      explanation: '[EVIDENCE: INTEGRITY-MARKET-CLAIM] Deliberate neutralization; business must confirm Swiss delivery scope and lead time.',
      source_span: 'in heel Nederland',
      target_span: null, // empty string: nothing left in the target
      suggested_fix: "Add de-CH.delivery to market_facts.yaml, e.g. 'in die ganze Schweiz' with confirmed lead time.",
      origin: 'llm_judge',
      status: 'open',
      finding_id: 'de-CH-f-001',
    });
    expect(rows[3]).toMatchObject({ segment_id: '(document)', origin: 'pipeline', rule_or_category: 'CURRENCY-POLICY-01', evidence: '[HYPOTHESIS]' });
  });

  it('colour-codes severity', async () => {
    const ws = sheet(await load(sampleReport()), 'Validation_Findings');
    const byId = (id: string): number => records(ws).findIndex((r) => r['finding_id'] === id);
    expect(fillOf(cellOf(ws, 'severity', byId('de-CH-f-002')))).toBe('FFFFC7CE'); // critical
    expect(fillOf(cellOf(ws, 'severity', byId('de-CH-f-001')))).toBe('FFF8CBAD'); // major
    expect(fillOf(cellOf(ws, 'severity', byId('de-CH-f-003')))).toBe('FFFFF2CC'); // minor
  });
});

describe('Localization_Changes', () => {
  it('lists every change and every repair record, each once', async () => {
    const rows = records(sheet(await load(sampleReport()), 'Localization_Changes'));
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => r['locale'] === 'de-CH')).toHaveLength(7);
    expect(rows.filter((r) => r['locale'] === 'en-NL')).toHaveLength(2);
    // the title repair is recorded both as a change and as a repair record: one row
    expect(rows.filter((r) => r['rule'] === 'SEO-TITLE-LEN')).toHaveLength(1);
  });

  it('carries from, to, rule id, reason and origin (llm, deterministic, repair)', async () => {
    const rows = records(sheet(await load(sampleReport()), 'Localization_Changes'));
    const offerte = rows.find((r) => r['rule'] === 'DECH-LEX-OFFERTE' && r['segment_id'] === 'p-003');
    expect(offerte).toMatchObject({
      locale: 'de-CH',
      from: 'ein unverbindliches Angebot',
      to: 'eine unverbindliche Offerte',
      origin: 'llm',
    });
    expect(String(offerte?.['reason'])).toContain('[EVIDENCE: DECH-LEX-OFFERTE]');
    expect(rows.find((r) => r['rule'] === 'DECH-LEX-HELV-01')?.['origin']).toBe('deterministic');
    expect(new Set(rows.map((r) => r['origin']))).toEqual(new Set(['llm', 'deterministic', 'repair']));
    expect(rows.find((r) => r['rule'] === 'SEO-TITLE-LEN')?.['origin']).toBe('repair');
  });

  it('includes repair records that are not also recorded as changes, with their loop and kind', async () => {
    const rows = records(sheet(await load(sampleReport()), 'Localization_Changes'));
    const autofix = rows.find((r) => r['rule'] === 'DECH-SZ-01');
    expect(autofix).toMatchObject({ locale: 'de-CH', segment_id: 'p-007', from: 'Größe', to: 'Grösse', origin: 'repair' });
    expect(String(autofix?.['note'])).toMatch(/^loop 1 · deterministic autofix · span \d+-\d+$/);
    expect(String(autofix?.['reason'])).toContain('[EVIDENCE: DECH-SZ-01]');
  });

  it('shows a removal as an empty "to" cell with a note', async () => {
    const rows = records(sheet(await load(sampleReport()), 'Localization_Changes'));
    const removed = rows.find((r) => r['rule'] === 'INTEGRITY-MARKET-CLAIM');
    expect(removed).toMatchObject({ from: 'in den gesamten Niederlanden', to: null, note: 'text removed' });
  });

  it('lists an LLM repair record that has no matching change', async () => {
    const report = sampleReport();
    const de = localeOf(report, 'de-CH');
    segmentOf(de, 'meta-title').changes = [];
    const rows = records(sheet(await load(report), 'Localization_Changes'));
    const repair = rows.find((r) => r['rule'] === 'SEO-TITLE-LEN');
    expect(repair).toMatchObject({ origin: 'repair', from: 'Beratung, Lieferung, Wartung', to: 'Beratung und Wartung' });
    expect(String(repair?.['note'])).toContain('LLM repair');
  });
});

describe('Market_Recommendations', () => {
  it('lists every recommendation of every locale, all tagged', async () => {
    const rows = records(sheet(await load(sampleReport()), 'Market_Recommendations'));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ locale: 'de-CH', id: 'DECH-rec-001', source: 'judge', segment_id: 'p-003' });
    expect(rows[2]).toMatchObject({ id: 'DECH-MARKET-LANG', source: 'market_check', segment_id: null });
    for (const r of rows) expect(String(r['recommendation'])).toMatch(/\[(?:EVIDENCE: [^\]]+|HYPOTHESIS[^\]]*)\]/);
  });

  it('adds per-segment judge recommendations the locale list does not contain, once', async () => {
    const report = sampleReport();
    const de = localeOf(report, 'de-CH');
    const validation = segmentOf(de, 'p-007').validation;
    if (!validation) throw new Error('fixture: p-007 has a validation');
    validation.localization_recommendations = ['[HYPOTHESIS] Extra tip', de.recommendations[0]?.text ?? '', '[HYPOTHESIS] Extra tip'];
    const rows = records(sheet(await load(report), 'Market_Recommendations'));
    expect(rows).toHaveLength(5);
    expect(rows[3]).toMatchObject({ locale: 'de-CH', id: 'p-007#rec-1', recommendation: '[HYPOTHESIS] Extra tip', source: 'judge', segment_id: 'p-007' });
  });
});

describe('SEO_Meta', () => {
  it('has one row per locale with lengths, limits and OK flags as typed cells', async () => {
    const ws = sheet(await load(sampleReport()), 'SEO_Meta');
    const rows = records(ws);
    expect(Object.keys(rows[0] as Rec)).toEqual([
      'locale',
      'hreflang',
      'title',
      'title_length',
      'title_max',
      'title_ok',
      'meta_description',
      'meta_description_length',
      'meta_description_max',
      'meta_description_ok',
      'slug',
      'h1',
      'source_keyword',
      'source_keyword_origin',
      'translated_keyword',
      'keyword_status',
      'note',
    ]);
    expect(rows[0]).toMatchObject({
      locale: 'de-CH',
      hreflang: 'de-CH',
      title: 'Kreiselpumpen für die Industrie | Beratung und Wartung',
      title_length: 54,
      title_max: 60,
      title_ok: true,
      meta_description_max: 155,
      meta_description_ok: true,
      slug: 'kreiselpumpen-industrie',
      h1: 'Kreiselpumpen für die Industrie',
      source_keyword: 'centrifugaalpomp',
      source_keyword_origin: 'provided',
      translated_keyword: 'Kreiselpumpe',
    });
    expect(rows[1]).toMatchObject({ locale: 'en-NL', title_length: 65, title_ok: false });
    expect(cellOf(ws, 'title_length', 0).type).toBe(ExcelJS.ValueType.Number);
    expect(cellOf(ws, 'title_ok', 0).type).toBe(ExcelJS.ValueType.Boolean);
    expect(fillOf(cellOf(ws, 'title_ok', 1))).toBe('FFFDE8E8');
    expect(fillOf(cellOf(ws, 'title_ok', 0))).toBeUndefined();
  });

  it('always marks the keyword TRANSLATED_UNVERIFIED with a [HYPOTHESIS] note', async () => {
    const rows = records(sheet(await load(sampleReport()), 'SEO_Meta'));
    for (const r of rows) {
      expect(r['keyword_status']).toBe('TRANSLATED_UNVERIFIED');
      expect(String(r['note'])).toContain('[HYPOTHESIS]');
    }
  });

  it('leaves the keyword cells blank, but still tags the note, when there is no primary keyword', async () => {
    const report = sampleReport();
    localeOf(report, 'de-CH').seo_meta.primary_keyword = null;
    const rows = records(sheet(await load(report), 'SEO_Meta'));
    expect(rows[0]).toMatchObject({ source_keyword: null, translated_keyword: null, keyword_status: null });
    expect(String(rows[0]?.['note'])).toContain('[HYPOTHESIS]');
  });
});

describe('Format_Changes', () => {
  it('lists every number, currency and date reformat with its rule and origin', async () => {
    const rows = records(sheet(await load(sampleReport()), 'Format_Changes'));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ locale: 'de-CH', segment_id: 'p-007', aspect: 'number', from: '1.250,00', to: "1'250.00", rule: 'DECH-NUM-01', origin: 'deterministic', note: null });
    expect(rows[1]).toMatchObject({ aspect: 'currency', from: '€ 1.250,00', to: "€ 1'250.00", rule: 'DECH-CUR-01', note: 'EUR retained; no conversion' });
    expect(rows.filter((r) => r['locale'] === 'en-NL').map((r) => r['rule'])).toEqual(['ENNL-NUM-01', 'ENNL-CUR-01']);
  });
});

describe('Run_Log', () => {
  it('lists every log entry with typed timestamps and the data as a JSON string', async () => {
    const report = sampleReport();
    const ws = sheet(await load(report), 'Run_Log');
    const rows = records(ws);
    expect(rows).toHaveLength(report.run_log.length);
    expect(rows.map((r) => r['code'])).toEqual(report.run_log.map((e) => e.code));
    expect(rows[0]?.['timestamp']).toEqual(new Date('2026-09-30T10:00:00.100Z'));
    expect(cellOf(ws, 'timestamp', 0).type).toBe(ExcelJS.ValueType.Date);
    const param = rows.find((r) => r['code'] === 'PARAM_UNSUPPORTED');
    expect(param).toMatchObject({ level: 'warn', stage: 'validation', provider: 'openai' });
    expect(JSON.parse(String(param?.['data']))).toEqual({ param: 'temperature', requested: 0 });
    expect(rows[0]?.['data']).toBeNull();
    const error = rows.find((r) => r['code'] === 'PROVIDER_ERROR');
    expect(error).toMatchObject({ level: 'error', locale: 'en-NL', segment_id: 'p-019' });
    expect(rows.map((r) => r['code'])).toEqual(expect.arrayContaining(['PARAM_UNSUPPORTED', 'PROVIDER_FALLBACK', 'JUDGE_NOT_INDEPENDENT']));
  });

  it('highlights warnings and errors', async () => {
    const ws = sheet(await load(sampleReport()), 'Run_Log');
    const rows = records(ws);
    expect(fillOf(cellOf(ws, 'level', rows.findIndex((r) => r['level'] === 'warn')))).toBe('FFFFEB9C');
    expect(fillOf(cellOf(ws, 'level', rows.findIndex((r) => r['level'] === 'error')))).toBe('FFFFC7CE');
    expect(fillOf(cellOf(ws, 'level', 0))).toBeUndefined();
  });
});

describe('cell safety', () => {
  it('guards formula injection on every tab: strings stay strings and never start with = + - @ TAB or CR', async () => {
    const report = sampleReport();
    const de = localeOf(report, 'de-CH');
    const attacks = ['=HYPERLINK("http://evil.example","click")', '+SUM(1+1)', '-2+3', '@SUM(1)', '\t=1+1', '\r=1+1'];
    segmentOf(de, 'p-019').final_text = attacks[0] as string;
    segmentOf(de, 'p-019').source_text = attacks[1] as string;
    segmentOf(de, 'li-006').final_text = attacks[2] as string;
    segmentOf(de, 'li-005').final_text = attacks[3] as string;
    segmentOf(de, 'h-002').final_text = attacks[4] as string;
    segmentOf(de, 'p-003').changes[0]!.reason = `${attacks[0]} [EVIDENCE: X]`;
    segmentOf(de, 'p-003').changes[0]!.from = attacks[5] as string;
    de.recommendations[0]!.text = `${attacks[3]} [HYPOTHESIS]`;
    de.document_findings[0]!.explanation = `${attacks[2]} [EVIDENCE: X]`;
    de.seo_meta.title = attacks[0] as string;
    report.run_log[0]!.message = attacks[0] as string;

    const wb = await load(report);
    let checked = 0;
    for (const ws of wb.worksheets) {
      ws.eachRow((row) =>
        row.eachCell((cell) => {
          expect(cell.type, `${ws.name}!${cell.address}`).not.toBe(ExcelJS.ValueType.Formula);
          if (typeof cell.value === 'string') {
            expect(cell.value, `${ws.name}!${cell.address}`).not.toMatch(/^[=+\-@\t\r]/);
            checked++;
          }
        }),
      );
    }
    expect(checked).toBeGreaterThan(100);

    const segments = records(sheet(wb, 'Segments'));
    expect(segments.find((r) => r['segment_id'] === 'p-019')).toMatchObject({ 'de-CH': ` ${attacks[0]}`, source: ` ${attacks[1]}` });
    expect(segments.find((r) => r['segment_id'] === 'li-006')?.['de-CH']).toBe(` ${attacks[2]}`);
    expect(segments.find((r) => r['segment_id'] === 'h-002')?.['de-CH']).toBe(` ${attacks[4]}`);
    const changes = records(sheet(wb, 'Localization_Changes'));
    expect(changes.find((r) => r['rule'] === 'DECH-LEX-OFFERTE' && r['segment_id'] === 'p-003')).toMatchObject({
      from: ` ${attacks[5]}`.replace('\r', '\n'), // XML parsers normalise a lone CR to LF
      reason: ` ${attacks[0]} [EVIDENCE: X]`,
    });
    expect(records(sheet(wb, 'Run_Log'))[0]?.['message']).toBe(` ${attacks[0]}`);
    expect(String(records(sheet(wb, 'SEO_Meta'))[0]?.['title'])).toBe(` ${attacks[0]}`);
  });

  it('leaves harmless text exactly as it is', async () => {
    const rows = records(sheet(await load(sampleReport()), 'Segments'));
    expect(rows.find((r) => r['segment_id'] === 'td-013')?.['de-CH']).toBe('80 m');
    expect(rows.find((r) => r['segment_id'] === 'h-001')?.['de-CH']).toBe('Kreiselpumpen für die Industrie');
  });

  it('truncates a cell that exceeds Excel limits, with a visible marker', async () => {
    const report = sampleReport();
    segmentOf(localeOf(report, 'de-CH'), 'p-019').final_text = 'x'.repeat(40_000);
    const rows = records(sheet(await load(report), 'Segments'));
    const text = String(rows.find((r) => r['segment_id'] === 'p-019')?.['de-CH']);
    expect(text.length).toBeLessThan(32_767);
    expect(text).toMatch(/… \[truncated, 8000 more characters\]$/);
  });

  it('strips control characters that would corrupt the file and keeps line breaks', async () => {
    const report = sampleReport();
    segmentOf(localeOf(report, 'de-CH'), 'p-019').final_text = 'a\u0000b\u0007c\nd';
    const rows = records(sheet(await load(report), 'Segments'));
    expect(rows.find((r) => r['segment_id'] === 'p-019')?.['de-CH']).toBe('abc\nd');
  });
});
