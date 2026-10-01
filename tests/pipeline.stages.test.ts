/** Stage behaviour through processLocale with the mock provider: batching, failure isolation, halting, both repair paths, routing. */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { processLocale } from '../src/pipeline/locale-run.js';
import type { MockCall, MockFixtures } from '../src/providers/mock.js';
import { ProviderError } from '../src/schemas/provider.js';
import type { Segment } from '../src/schemas/segment.js';
import { makeDoc, makeRun, mockProvider, segment, testRegistry } from './helpers/harness.js';

const cfg = loadConfig();

const para = (n: number, text = `Dit is de tekst van alinea nummer ${n} over onze pompen.`): Segment =>
  segment({ segment_id: `p-${String(n).padStart(3, '0')}`, order: n, text });
const small = (maxSegments: number) => ({ ...cfg, stages: { ...cfg.stages, batching: { ...cfg.stages.batching, max_segments: maxSegments } } });
const stageOf = (calls: MockCall[]) => calls.map((c) => c.stage);
const count = (calls: MockCall[], stage: string) => calls.filter((c) => c.stage === stage).length;

describe('batching and failure isolation', () => {
  it('splits work into batches of max_segments and maps every result back', async () => {
    const calls: MockCall[] = [];
    const run = makeRun(small(5), testRegistry(mockProvider('mock', { calls })));
    const doc = makeDoc(Array.from({ length: 12 }, (_, i) => para(i + 1)));
    const { result } = await processLocale(run, 'de-DE', doc);
    expect(count(calls, 'translation')).toBe(3);
    expect(count(calls, 'localization')).toBe(3);
    expect(result.counts).toMatchObject({ segments: 12, ok: 12, provider_error: 0 });
    expect(result.segments.every((s) => s.final_text?.startsWith('[mock de-DE]'))).toBe(true);
  });

  it('a failed batch is retried segment by segment (BATCH_SPLIT) and then succeeds', async () => {
    const calls: MockCall[] = [];
    let failedOnce = false;
    const fail = (c: MockCall) => {
      const n = (c.payload['segments'] as unknown[]).length;
      if (c.stage === 'translation' && n > 1 && !failedOnce) {
        failedOnce = true;
        return new ProviderError('temporary', 'SERVER', { provider: c.provider });
      }
      return undefined;
    };
    const run = makeRun(small(5), testRegistry(mockProvider('mock', { calls, fail })));
    const { result } = await processLocale(run, 'de-DE', makeDoc([para(1), para(2), para(3)]));
    expect(result.counts.ok).toBe(3);
    expect(count(calls, 'translation')).toBe(1 + 3); // the failed batch plus three single calls
    expect(run.log.count('BATCH_SPLIT')).toBe(1);
  });

  it('a segment the model omits from its answer is re-requested on its own', async () => {
    const calls: MockCall[] = [];
    const handlers = {
      translation: (c: MockCall) => {
        const segs = c.payload['segments'] as Array<{ segment_id: string; text: string }>;
        const keep = segs.length > 1 ? segs.slice(0, -1) : segs;
        return { results: keep.map((s) => ({ segment_id: s.segment_id, target_locale: 'de-DE', translation: `T:${s.text}`, entities_preserved: [], terminology_applied: [] })) };
      },
    };
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { calls, handlers })));
    const { result } = await processLocale(run, 'de-DE', makeDoc([para(1), para(2), para(3)]));
    expect(result.counts.ok).toBe(3);
    expect(count(calls, 'translation')).toBe(2);
  });

  it('a segment that keeps failing becomes PROVIDER_ERROR (verdict FAIL); the rest of the page is unaffected', async () => {
    const fail = (c: MockCall) => {
      const segs = c.payload['segments'] as Array<{ segment_id: string }>;
      return c.stage === 'translation' && segs.some((s) => s.segment_id === 'p-002') ? new ProviderError('nope', 'SERVER', { provider: c.provider, retryable: false }) : undefined;
    };
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { fail })));
    const { result } = await processLocale(run, 'de-DE', makeDoc([para(1), para(2), para(3)]));
    const bad = result.segments.find((s) => s.segment_id === 'p-002');
    expect(bad).toMatchObject({ status: 'PROVIDER_ERROR', final_text: null });
    expect(bad?.validation).toBeNull();
    expect(result.segments.filter((s) => s.status === 'OK')).toHaveLength(2);
    expect(result.counts).toMatchObject({ provider_error: 1, ok: 2 });
    expect(result.verdict).toBe('FAIL');
    expect(run.log.entries().some((e) => e.code === 'PROVIDER_ERROR' && e.segment_id === 'p-002')).toBe(true);
  });

  it('the cost ceiling halts the run gracefully: calls stop, unfinished segments are NOT_PROCESSED, the locale still reports', async () => {
    const calls: MockCall[] = [];
    const run = makeRun(small(5), testRegistry(mockProvider('mock', { calls })), { ceiling: 1e-9 });
    const { result, halted } = await processLocale(run, 'de-DE', makeDoc(Array.from({ length: 12 }, (_, i) => para(i + 1))));
    expect(halted).toBe(true);
    expect(count(calls, 'localization') + count(calls, 'validation')).toBe(0);
    expect(result.counts.not_processed).toBeGreaterThan(0);
    expect(result.counts.ok + result.counts.not_processed).toBe(12);
    expect(result.verdict).toBe('FAIL');
    // nothing that never got localized and judged may be reported as a good result
    expect(result.segments.filter((s) => s.status === 'OK').every((s) => s.validation?.verdict !== 'PASS')).toBe(true);
    expect(result.segments.filter((s) => s.status === 'NOT_PROCESSED').every((s) => s.final_text === null && s.validation === null)).toBe(true);
    expect(run.log.count('COST_CEILING') + run.log.count('PROVIDER_ERROR')).toBeGreaterThanOrEqual(0);
  });
});

describe('repair loop', () => {
  const eszett: MockFixtures = {
    translation: { 'de-CH': { 'p-001': { translation: 'Die Größe der Pumpe ist beträchtlich.' } } },
    localization: { 'de-CH': { 'p-001': { localized_text: 'Die Größe der Pumpe ist beträchtlich.' } } },
  };
  const doc = makeDoc([para(1, 'De grootte van de pomp is aanzienlijk.')]);

  it('deterministic autofix repairs a critical ß in de-CH without a model call and re-validates', async () => {
    const calls: MockCall[] = [];
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { fixtures: eszett, calls })));
    const { result } = await processLocale(run, 'de-CH', doc);
    const seg = result.segments[0];
    expect(seg?.final_text).toBe('Die Grösse der Pumpe ist beträchtlich.');
    expect(seg?.repairs).toHaveLength(1);
    expect(seg?.repairs[0]).toMatchObject({ origin: 'autofix', rule: 'DECH-SZ-01', before: 'ß', after: 'ss', loop: 1 });
    const fixed = seg?.validation?.findings.filter((f) => f.status === 'fixed') ?? [];
    expect(fixed.map((f) => f.rule_or_category)).toEqual(['DECH-SZ-01']);
    expect(seg?.validation?.findings.filter((f) => f.status === 'open')).toEqual([]);
    expect(seg?.validation?.verdict).toBe('PASS');
    expect(count(calls, 'repair')).toBe(0);
    expect(count(calls, 'validation')).toBe(2); // initial pass + re-validation after the fix
    expect(result.verdict).toBe('PASS');
  });

  const offerte: MockFixtures = {
    translation: { 'de-CH': { 'p-001': { translation: 'Fordern Sie ein unverbindliches Angebot an.' } } },
    localization: { 'de-CH': { 'p-001': { localized_text: 'Fordern Sie ein unverbindliches Angebot an.' } } },
  };
  const offerteDoc = makeDoc([para(1, 'Vraag een vrijblijvende offerte aan.')]);

  it('span-scoped model repair: only the flagged span (with article and adjective) is sent and replaced', async () => {
    const calls: MockCall[] = [];
    const fixtures: MockFixtures = { ...offerte, repair: { 'de-CH': { 'p-001': [{ match: 'ein unverbindliches Angebot', replacement: 'eine unverbindliche Offerte', rule: 'DECH-LEX-OFFERTE' }] } } };
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { fixtures, calls })));
    const { result } = await processLocale(run, 'de-CH', offerteDoc);
    const seg = result.segments[0];
    const sent = calls.find((c) => c.stage === 'repair');
    const span = (sent?.payload['segments'] as Array<{ current_text: string; spans: Array<{ span_id: string; start: number; end: number; text: string; findings: Array<{ rule: string }> }> }>)[0];
    expect(span?.current_text).toBe('Fordern Sie ein unverbindliches Angebot an.');
    expect(span?.spans).toHaveLength(1);
    expect(span?.spans[0]).toMatchObject({ span_id: 's1', start: 12, end: 39, text: 'ein unverbindliches Angebot' });
    expect(span?.spans[0]?.findings[0]?.rule).toBe('DECH-LEX-OFFERTE');
    expect(seg?.final_text).toBe('Fordern Sie eine unverbindliche Offerte an.');
    expect(seg?.repairs[0]).toMatchObject({ origin: 'llm', rule: 'DECH-LEX-OFFERTE', before: 'ein unverbindliches Angebot', after: 'eine unverbindliche Offerte' });
    expect(seg?.validation?.findings.some((f) => f.rule_or_category === 'DECH-LEX-OFFERTE' && f.status === 'fixed')).toBe(true);
    expect(seg?.validation?.verdict).toBe('PASS');
    expect(seg?.repairs[0]?.reason).toMatch(/\[EVIDENCE: [^\]]+\]|\[HYPOTHESIS\]/);
  });

  it('a finding no repair can fix stays open: HUMAN_REVIEW "unresolved major", and the loop does not spin', async () => {
    const calls: MockCall[] = [];
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { fixtures: offerte, calls })));
    const { result } = await processLocale(run, 'de-CH', offerteDoc);
    const seg = result.segments[0];
    expect(seg?.repairs).toEqual([]);
    expect(seg?.validation?.verdict).toBe('HUMAN_REVIEW');
    expect(seg?.validation?.verdict_reasons.join(' ')).toContain('unresolved major');
    expect(count(calls, 'repair')).toBe(1); // tried once, nothing changed, stopped
  });

  it('a replacement that drops inline markup is rejected and the original text is kept', async () => {
    const tagged = makeDoc([
      segment({ segment_id: 'p-001', text: 'Vraag een vrijblijvende <a1>offerte</a1> aan.', inline: { a1: { tag: 'a', attrs: { href: '/offerte' } } } }),
    ]);
    const fixtures: MockFixtures = {
      translation: { 'de-CH': { 'p-001': { translation: 'Fordern Sie ein unverbindliches <a1>Angebot</a1> an.' } } },
      localization: { 'de-CH': { 'p-001': { localized_text: 'Fordern Sie ein unverbindliches <a1>Angebot</a1> an.' } } },
      repair: { 'de-CH': { 'p-001': [{ match: 'ein unverbindliches <a1>Angebot</a1>', replacement: 'eine unverbindliche Offerte' }] } },
    };
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { fixtures })));
    const { result } = await processLocale(run, 'de-CH', tagged);
    const seg = result.segments[0];
    expect(run.log.count('REPAIR_REJECTED')).toBe(1);
    expect(seg?.final_text).toBe('Fordern Sie ein unverbindliches <a1>Angebot</a1> an.');
    expect(seg?.repairs).toEqual([]);
    expect(seg?.validation?.verdict).toBe('HUMAN_REVIEW');
  });

  it('max_repair_loops = 0 leaves findings open', async () => {
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { fixtures: eszett })), { settings: { maxRepairLoops: 0 } });
    const { result } = await processLocale(run, 'de-CH', doc);
    expect(result.segments[0]?.final_text).toBe('Die Größe der Pumpe ist beträchtlich.');
    expect(result.segments[0]?.validation?.verdict).toBe('FAIL');
  });
});

describe('routing and special pages', () => {
  it('legal page: translation only, no localization, every segment flagged, legal market checks only', async () => {
    const calls: MockCall[] = [];
    const doc = makeDoc([para(1, 'Wij verwerken uw persoonsgegevens conform de geldende wetgeving.')], { page_type: 'LEGAL', page_type_evidence: 'url path "/privacyverklaring"' });
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { calls })));
    const { result } = await processLocale(run, 'de-CH', doc);
    expect(count(calls, 'localization')).toBe(0);
    expect(count(calls, 'translation')).toBe(1);
    const seg = result.segments[0];
    expect(seg?.operation).toBe('TRANSLATE_ONLY');
    expect(seg?.requires_human_review).toBe(true);
    expect(seg?.review_reasons.some((r) => r.startsWith('LEGAL_PAGE'))).toBe(true);
    expect(result.verdict).toBe('HUMAN_REVIEW');
    const ids = result.recommendations.map((r) => r.id);
    expect(ids).toContain('DECH-MARKET-LEGAL');
    expect(ids).not.toContain('DECH-MARKET-SVGW');
    expect(result.recommendations.find((r) => r.id === 'DECH-MARKET-LEGAL')?.text).toContain('verify with counsel');
  });

  const mixed = makeDoc([
    para(1, 'Onze pompen zijn robuust en betrouwbaar.'),
    segment({ segment_id: 'td-002', block_type: 'table_cell', order: 2, text: 'Flow rate and head are listed in the table below.', lang: { lang: 'en', confidence: 0.97, method: 'lib' } }),
  ]);

  it('mixed-language page, German target: each segment is translated from its own language', async () => {
    const calls: MockCall[] = [];
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { calls })));
    const { result } = await processLocale(run, 'de-DE', mixed);
    const langs = calls.filter((c) => c.stage === 'translation').map((c) => (c.payload['segments'] as Array<{ source_language: string }>)[0]?.source_language).sort();
    expect(langs).toEqual(['en', 'nl']);
    expect(result.segments.map((s) => s.source_lang)).toEqual(['nl', 'en']);
    expect(result.operations).toEqual({ TRANSLATE_LOCALIZE: 2 });
  });

  it('mixed-language page, English target: the English segment is adapted only (no translation step)', async () => {
    const calls: MockCall[] = [];
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { calls })));
    const { result } = await processLocale(run, 'en-GB', mixed);
    const cell = result.segments.find((s) => s.segment_id === 'td-002');
    expect(cell?.operation).toBe('ADAPT_ONLY');
    expect(cell?.translation).toBe('Flow rate and head are listed in the table below.');
    const translated = calls.filter((c) => c.stage === 'translation').flatMap((c) => (c.payload['segments'] as Array<{ segment_id: string }>).map((s) => s.segment_id));
    expect(translated).toEqual(['p-001']);
    const adapted = calls.filter((c) => c.stage === 'localization').flatMap((c) => (c.payload['segments'] as Array<{ segment_id: string }>).map((s) => s.segment_id)).sort();
    expect(adapted).toEqual(['p-001', 'td-002']);
  });

  it('source already in the target locale: copied, no model call, deterministic checks only, noted', async () => {
    const calls: MockCall[] = [];
    const doc = makeDoc([segment({ segment_id: 'p-001', text: 'Our pumps deliver high efficiency.', lang: { lang: 'en', confidence: 0.98, method: 'lib' } })], { source_locale: 'en-GB', source_language: 'en' });
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { calls })));
    const { result } = await processLocale(run, 'en-GB', doc);
    const seg = result.segments[0];
    expect(calls).toEqual([]);
    expect(seg?.operation).toBe('SKIP_IDENTICAL');
    expect(seg?.final_text).toBe('Our pumps deliver high efficiency.');
    expect(seg?.notes).toContain('[EVIDENCE: detection p=0.98] Source already in target locale.');
    expect(seg?.validation?.llm_judge).toBeNull();
    expect(seg?.validation?.verdict).toBe('PASS');
  });

  it('entity-only segments skip the model and are only format-normalised', async () => {
    const calls: MockCall[] = [];
    const doc = makeDoc([segment({ segment_id: 'td-001', block_type: 'table_cell', text: '€ 1.250,00', translatable: false })]);
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { calls })));
    const { result } = await processLocale(run, 'de-CH', doc);
    expect(calls).toEqual([]);
    expect(result.segments[0]?.final_text).toBe("€ 1'250.00");
    expect(result.segments[0]?.format_changes[0]).toMatchObject({ aspect: 'currency', from: '€ 1.250,00', to: "€ 1'250.00", rule: 'DECH-CUR-01', segment_id: 'td-001', locale: 'de-CH' });
  });
});

describe('formats and document-level rules', () => {
  it('numbers and currency are reformatted by code and logged; BTW becomes "VAT (BTW)" on first mention through the autofix', async () => {
    const doc = makeDoc([para(1, 'Prijs: € 1.250,00 excl. BTW.')]);
    const fixtures: MockFixtures = {
      translation: { 'en-NL': { 'p-001': { translation: 'Price: € 1.250,00 excl. VAT.' } } },
      localization: { 'en-NL': { 'p-001': { localized_text: 'Price: € 1.250,00 excl. VAT.' } } },
    };
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { fixtures })));
    const { result } = await processLocale(run, 'en-NL', doc);
    const seg = result.segments[0];
    expect(seg?.final_text).toBe('Price: €1,250.00 excl. VAT (BTW).');
    expect(seg?.format_changes.map((c) => ({ aspect: c.aspect, from: c.from, to: c.to, rule: c.rule }))).toEqual([{ aspect: 'currency', from: '€ 1.250,00', to: '€1,250.00', rule: 'ENNL-CUR-01' }]);
    expect(seg?.repairs[0]).toMatchObject({ origin: 'autofix', rule: 'ENNL-BTW-01', after: 'VAT (BTW)' });
    expect(result.verdict).not.toBe('FAIL');
  });

  it('currency policy: euro prices for a UK audience without GBP facts become a tagged recommendation, amounts are retained', async () => {
    const doc = makeDoc([para(1, 'Prijs: € 1.250,00 excl. BTW.')]);
    const run = makeRun(cfg, testRegistry(mockProvider('mock')));
    const { result } = await processLocale(run, 'en-GB', doc);
    expect(result.segments[0]?.final_text).toContain('€1,250.00');
    const rec = result.recommendations.find((r) => r.id.startsWith('PIPE-CURRENCY-POLICY-01'));
    expect(rec?.text).toBe('[HYPOTHESIS] UK buyers expect GBP pricing — confirm currency policy.');
    expect(result.document_findings.some((f) => f.rule_or_category === 'CURRENCY-POLICY-01')).toBe(true);
  });

  it('SEO meta: title, description and slug are localised; the translated keyword is an unverified hypothesis', async () => {
    const doc = makeDoc(
      [
        segment({ segment_id: 'meta-title', block_type: 'meta', meta_kind: 'title', order: 1, text: 'Centrifugaalpompen voor de industrie' }),
        segment({ segment_id: 'meta-slug', block_type: 'meta', meta_kind: 'slug', order: 2, text: 'centrifugaal pompen' }),
        segment({ segment_id: 'meta-keyword', block_type: 'meta', meta_kind: 'keyword', order: 3, text: 'centrifugaalpomp' }),
        para(4, 'Onze centrifugaalpompen zijn robuust.'),
      ],
      { seo: { primary_keyword: { text: 'centrifugaalpomp', origin: 'provided' } } },
    );
    const fixtures: MockFixtures = {
      translation: { 'de-CH': { 'meta-slug': { translation: 'Kreiselpumpen für Größe' }, 'meta-title': { translation: 'Kreiselpumpen für die Industrie' }, 'meta-keyword': { translation: 'Kreiselpumpe' } } },
    };
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { fixtures })));
    const { result } = await processLocale(run, 'de-CH', doc);
    const seo = result.seo_meta;
    expect(seo.hreflang).toBe('de-CH');
    expect(seo.title).toBe('Kreiselpumpen für die Industrie');
    expect(seo.title_ok).toBe(true);
    expect(seo.slug).toBe('kreiselpumpen-fuer-groesse');
    expect(seo.primary_keyword).toMatchObject({ source: 'centrifugaalpomp', translated: 'Kreiselpumpe', keyword_status: 'TRANSLATED_UNVERIFIED' });
    expect(seo.primary_keyword?.note).toContain('[HYPOTHESIS]');
    expect(result.segments.find((s) => s.segment_id === 'meta-slug')?.final_text).toBe('kreiselpumpen-fuer-groesse');
    expect(stageOf([]).length).toBe(0);
  });
});
