/**
 * GOLDEN STANDARD (spec §5.1): nl-NL → de-CH through the complete locale pipeline with a mock provider that replays the exemplar.
 * Every stage output, the deterministic checks, the score (95) and the verdict (HUMAN_REVIEW) must match the exemplar.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import type { MockCall } from '../src/providers/mock.js';
import { processLocale } from '../src/pipeline/locale-run.js';
import { EVIDENCE_TAG_RE } from '../src/schemas/common.js';
import { GOLDEN_SOURCE, goldenDoc, goldenFixtures, makeRun, mockProvider, readGolden, testRegistry } from './helpers/harness.js';

const cfg = loadConfig();

async function runGolden(target: 'de-CH' | 'de-DE' = 'de-CH') {
  const calls: MockCall[] = [];
  const run = makeRun(cfg, testRegistry(mockProvider('mock', { fixtures: goldenFixtures(), calls })));
  const out = await processLocale(run, target, goldenDoc());
  return { ...out, calls, run };
}

describe('golden standard nl-NL → de-CH', () => {
  it('reproduces every stage output of the exemplar', async () => {
    const { result } = await runGolden();
    const seg = result.segments[0];
    expect(seg).toBeDefined();
    if (!seg) return;
    const t = readGolden('translation').output.results[0] as { translation: string; entities_preserved: string[] };
    const l = readGolden('localization').output.results[0] as { localized_text: string; changes: Array<{ from: string; to: string; rule: string; reason: string }> };

    expect(seg.segment_id).toBe('p-003');
    expect(seg.status).toBe('OK');
    expect(seg.operation).toBe('TRANSLATE_LOCALIZE');
    expect(seg.source_text).toBe(GOLDEN_SOURCE);
    expect(seg.translation).toBe(t.translation);
    expect(seg.entities_preserved).toEqual(t.entities_preserved);
    expect(seg.terminology_applied).toEqual([
      { source: 'centrifugaalpomp', target: 'Kreiselpumpe', rule: 'GLOSS-0012' },
      { source: 'opvoerhoogte', target: 'Förderhöhe', rule: 'GLOSS-0019' },
    ]);
    expect(seg.localized_text).toBe(l.localized_text);
    expect(seg.final_text).toBe(l.localized_text);
    expect(seg.final_text?.includes('ß')).toBe(false);
    expect(seg.changes.map(({ from, to, rule, reason }) => ({ from, to, rule, reason }))).toEqual(l.changes);
    expect(seg.changes.every((c) => c.origin === 'llm')).toBe(true);
    expect(seg.format_changes).toEqual([]);
    expect(seg.repairs).toEqual([]);
  });

  it('validation block: deterministic checks, judge, back-translation, score 95, verdict HUMAN_REVIEW', async () => {
    const { result } = await runGolden();
    const v = result.segments[0]?.validation;
    expect(v).toBeTruthy();
    if (!v) return;
    const g = readGolden('validation').output.results[0] as { scores: Record<string, number>; mqm_errors: unknown[]; localization_recommendations: string[] };

    expect(v.segment_id).toBe('p-003');
    expect(v.target_locale).toBe('de-CH');
    expect(v.deterministic_checks).toEqual(
      expect.arrayContaining([
        { rule: 'DECH-SZ-01', result: 'PASS', note: '[EVIDENCE: DECH-SZ-01] No ß present.', severity: 'critical' },
        { rule: 'INTEGRITY-ENTITY', result: 'PASS', note: '[EVIDENCE: p-003] 450 m³/h and 80 preserved.', severity: 'critical' },
      ]),
    );
    expect(v.deterministic_checks.every((c) => c.result !== 'FAIL')).toBe(true);
    expect(v.llm_judge?.scores).toEqual(g.scores);
    expect(v.llm_judge?.mqm_errors).toEqual(g.mqm_errors);
    expect(v.llm_judge?.confidence).toBe(0.92);
    expect(v.back_translation).toBe('Our centrifugal pumps deliver up to 450 m³/h at a head of 80 metres. Request a non-binding quotation today – delivery within 5 working days.');
    expect(v.quality_score).toBe(95);
    expect(v.penalty).toBe(5);
    expect(v.verdict).toBe('HUMAN_REVIEW');
    expect(v.verdict_reasons.join(' ')).toContain('INTEGRITY-MARKET-CLAIM');
    expect(v.localization_recommendations).toEqual(g.localization_recommendations);
  });

  it('counts the neutralised claim exactly once (judge and pipeline do not double count)', async () => {
    const { result } = await runGolden();
    const open = result.segments[0]?.validation?.findings.filter((f) => f.status === 'open') ?? [];
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ origin: 'llm_judge', severity: 'major', rule_or_category: 'accuracy/omission', requires_human_review: true, segment_id: 'p-003' });
    expect(EVIDENCE_TAG_RE.test(open[0]?.explanation ?? '')).toBe(true);
    expect(result.segments[0]?.requires_human_review).toBe(true);
    expect(result.segments[0]?.review_reasons.some((r) => r.startsWith('INTEGRITY-MARKET-CLAIM'))).toBe(true);
  });

  it('locale result: score, verdict, recommendations (market checks are tagged hypotheses), usage and providers', async () => {
    const { result, calls } = await runGolden();
    expect(result.target_locale).toBe('de-CH');
    expect(result.hreflang).toBe('de-CH');
    expect(result.quality_score).toBe(95);
    expect(result.verdict).toBe('HUMAN_REVIEW');
    expect(result.counts).toMatchObject({ segments: 1, ok: 1, provider_error: 0, not_processed: 0, findings_major: 1, findings_open: 1, changes: 3, human_review_segments: 1 });
    const ids = result.recommendations.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['DECH-MARKET-CUR', 'DECH-MARKET-SVGW', 'PIPE-CLAIM-de-CH']));
    expect(result.recommendations.every((r) => EVIDENCE_TAG_RE.test(r.text))).toBe(true);
    expect(result.recommendations.find((r) => r.id === 'DECH-MARKET-SVGW')?.text.startsWith('[HYPOTHESIS] — verify with counsel')).toBe(true);
    // one call per stage, no repair call
    expect(calls.map((c) => c.stage).sort()).toEqual(['backtranslation', 'localization', 'translation', 'validation']);
    expect(result.usage.calls).toBe(4);
    expect(result.providers.translation).toEqual({ provider: 'mock', model: 'mock-a' });
  });

  it('the translation prompt is neutral (Angebot), the localization prompt carries the Swiss form (Offerte) and the claim decision', async () => {
    const { calls } = await runGolden();
    const tr = calls.find((c) => c.stage === 'translation');
    const lo = calls.find((c) => c.stage === 'localization');
    expect(tr?.system).toMatch(/\| GLOSS-0048 \| vrijblijvende offerte \| unverbindliches Angebot \|/);
    expect(lo?.system).toMatch(/\| GLOSS-0048 \| vrijblijvende offerte \| unverbindliche Offerte \|/);
    const seg = (lo?.payload['segments'] as Array<{ market_claims: unknown[]; input_text: string }>)[0];
    expect(seg?.market_claims).toEqual([{ source_phrase: 'in heel Nederland', action: 'NEUTRALIZE', replacement_phrase: null }]);
    expect(seg?.input_text).toBe((readGolden('translation').output.results[0] as { translation: string }).translation);
  });

  it('the judge sees the localization changes, the back-translation and the claim decision; parameters follow spec §0.2', async () => {
    const { calls } = await runGolden();
    const judge = calls.find((c) => c.stage === 'validation');
    const seg = (judge?.payload['segments'] as Array<Record<string, unknown>>)[0];
    expect((seg?.['changes'] as Array<{ rule: string }>).map((c) => c.rule)).toEqual(['DECH-LEX-OFFERTE', 'DECH-LEX-INNERT', 'INTEGRITY-MARKET-CLAIM']);
    expect(seg?.['back_translation']).toContain('centrifugal pumps');
    expect(seg?.['deterministic_findings']).toEqual([]);
    const p = Object.fromEntries(calls.map((c) => [c.stage, c.params]));
    expect(p['translation']).toMatchObject({ temperature: 0.2, top_p: 0.9 });
    expect(p['localization']).toMatchObject({ temperature: 0.3, top_p: 0.9 });
    expect(p['validation']).toMatchObject({ temperature: 0, top_p: 1 });
    expect(p['backtranslation']).toMatchObject({ temperature: 0, top_p: 1 });
  });

  it('the same source for de-DE stays a de-DE text: no Swiss forms are applied and the claim is neutralised there too', async () => {
    const calls: MockCall[] = [];
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { calls })));
    const { result } = await processLocale(run, 'de-DE', goldenDoc());
    const seg = result.segments[0];
    const lo = calls.find((c) => c.stage === 'localization');
    expect((lo?.payload['segments'] as Array<{ market_claims: Array<{ action: string }> }>)[0]?.market_claims[0]?.action).toBe('NEUTRALIZE');
    expect(seg?.final_text).not.toContain('in heel Nederland');
    expect(result.target_locale).toBe('de-DE');
  });
});
