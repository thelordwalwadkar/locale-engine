import { describe, expect, it } from 'vitest';
import { makeBatches } from '../src/pipeline/batching.js';
import { ensureTagged, hypothesisRecommendation } from '../src/pipeline/evidence.js';
import { decideOperation, defaultTargets, localeOfSegment, resolveTargets, sameLocale } from '../src/pipeline/route.js';
import { decideVerdict, penaltyFor, rawWeight, scoreFor, scoringSettings, worstVerdict } from '../src/pipeline/scoring.js';
import { loadConfig } from '../src/config/load.js';
import { hasEvidenceTag } from '../src/schemas/common.js';
import { CostTracker, totalsOf } from '../src/telemetry/cost.js';
import { createRedactor, redactDeep } from '../src/telemetry/redact.js';
import { RunLog } from '../src/telemetry/run-log.js';
import { EngineError } from '../src/util/errors.js';
import type { CallRecord } from '../src/schemas/report.js';

const cfg = loadConfig();
const settings = scoringSettings(cfg.stages);

describe('routing (spec §4.1, §5.2)', () => {
  it('different language → translate + localize (translate only on legal pages)', () => {
    expect(decideOperation('nl', 'nl-NL', 'de-CH', 'CONTENT')).toBe('TRANSLATE_LOCALIZE');
    expect(decideOperation('nl', 'nl-NL', 'de-CH', 'LEGAL')).toBe('TRANSLATE_ONLY');
    expect(decideOperation('en', 'en-*', 'it-IT', 'CONTENT')).toBe('TRANSLATE_LOCALIZE');
  });
  it('same language: adapt only, or skip when the locale is already the target', () => {
    expect(decideOperation('en', 'en-*', 'en-GB', 'CONTENT')).toBe('ADAPT_ONLY');
    expect(decideOperation('en', 'en-GB', 'en-NL', 'CONTENT')).toBe('ADAPT_ONLY');
    expect(decideOperation('en', 'en-GB', 'en-GB', 'CONTENT')).toBe('SKIP_IDENTICAL');
    expect(decideOperation('nl', 'nl-NL', 'nl-NL', 'CONTENT')).toBe('SKIP_IDENTICAL');
    expect(decideOperation('en', 'en-*', 'en-GB', 'LEGAL')).toBe('SKIP_IDENTICAL');
  });
  it('mixed-language pages: an English table on a Dutch page is en-*', () => {
    expect(localeOfSegment('en', 'nl-NL')).toBe('en-*');
    expect(localeOfSegment('nl', 'nl-NL')).toBe('nl-NL');
    expect(decideOperation('en', localeOfSegment('en', 'nl-NL'), 'en-GB', 'CONTENT')).toBe('ADAPT_ONLY');
    expect(decideOperation('en', localeOfSegment('en', 'nl-NL'), 'de-DE', 'CONTENT')).toBe('TRANSLATE_LOCALIZE');
  });
  it('sameLocale never equates a wildcard with a concrete locale', () => {
    expect(sameLocale('en-*', 'en-GB')).toBe(false);
    expect(sameLocale('en-gb', 'en-GB')).toBe(true);
  });
  it('--targets all expands per source language; en → nl-NL stays off by default', () => {
    expect(defaultTargets(cfg.stages, 'nl')).toEqual(['en-NL', 'en-GB', 'de-DE', 'de-AT', 'de-CH', 'it-IT']);
    expect(defaultTargets(cfg.stages, 'en')).toHaveLength(6);
    expect(() => defaultTargets(cfg.stages, 'de')).toThrow(EngineError);
    const enabled = { ...cfg.stages, locale_matrix: { ...cfg.stages.locale_matrix, enable_en_to_nl: true } };
    expect(defaultTargets(enabled, 'en')).toContain('nl-NL');
    expect(defaultTargets(enabled, 'nl')).not.toContain('nl-NL');
  });
  it('explicit targets are validated', () => {
    expect(resolveTargets(['de-CH', 'it-IT', 'de-CH'], 'nl', cfg.stages)).toEqual(['de-CH', 'it-IT']);
    expect(() => resolveTargets(['de-XX'], 'nl', cfg.stages)).toThrow(/unknown target locale/);
    expect(() => resolveTargets(['nl-NL'], 'en', cfg.stages)).toThrow(/disabled/);
    expect(() => resolveTargets([], 'nl', cfg.stages)).toThrow(/no target/);
  });
});

describe('scoring (spec §6.6, ASSUMPTIONS A-009)', () => {
  it('reproduces the golden exemplar: one major in a 27-word segment scores 95', () => {
    const raw = rawWeight(['major'], settings);
    const penalty = penaltyFor(raw, 27, settings);
    expect(penalty).toBe(5);
    expect(scoreFor(penalty)).toBe(95);
  });
  it('normalises per 100 words above the floor and never goes below zero', () => {
    expect(penaltyFor(10, 400, settings)).toBe(2.5);
    expect(scoreFor(penaltyFor(rawWeight(['critical', 'critical', 'critical', 'critical', 'critical'], settings), 10, settings))).toBe(0);
  });
  const base = { status: 'OK' as const, validated: true, score: 100, open: [], judgeConfidence: 0.9, reviewReasons: [], legal: false, hasRecommendations: false };
  it('PASS / PASS_WITH_NOTES', () => {
    expect(decideVerdict(base, settings).verdict).toBe('PASS');
    expect(decideVerdict({ ...base, score: 99, open: [{ severity: 'minor', requires_human_review: false, rule_or_category: 'X-1' }] }, settings).verdict).toBe('PASS_WITH_NOTES');
    expect(decideVerdict({ ...base, hasRecommendations: true }, settings).verdict).toBe('PASS_WITH_NOTES');
  });
  it('HUMAN_REVIEW: business claim, legal page, low judge confidence, unresolved major (A-013)', () => {
    const golden = decideVerdict(
      { ...base, score: 95, open: [{ severity: 'major', requires_human_review: true, rule_or_category: 'accuracy/omission' }], reviewReasons: ['INTEGRITY-MARKET-CLAIM: source claims "in heel Nederland"'] },
      settings,
    );
    expect(golden.verdict).toBe('HUMAN_REVIEW');
    expect(golden.reasons).toEqual(['INTEGRITY-MARKET-CLAIM: source claims "in heel Nederland"']);
    expect(decideVerdict({ ...base, legal: true }, settings).verdict).toBe('HUMAN_REVIEW');
    expect(decideVerdict({ ...base, judgeConfidence: 0.55 }, settings).verdict).toBe('HUMAN_REVIEW');
    const major = decideVerdict({ ...base, score: 95, open: [{ severity: 'major', requires_human_review: false, rule_or_category: 'DECH-LEX-OFFERTE' }] }, settings);
    expect(major.verdict).toBe('HUMAN_REVIEW');
    expect(major.reasons[0]).toContain('unresolved major');
  });
  it('FAIL: critical open, score below threshold, provider error, not processed; FAIL outranks HUMAN_REVIEW', () => {
    expect(decideVerdict({ ...base, score: 75, open: [{ severity: 'critical', requires_human_review: false, rule_or_category: 'DECH-SZ-01' }] }, settings).verdict).toBe('FAIL');
    expect(decideVerdict({ ...base, score: 89, legal: true }, settings).verdict).toBe('FAIL');
    expect(decideVerdict({ ...base, status: 'PROVIDER_ERROR' }, settings).verdict).toBe('FAIL');
    expect(decideVerdict({ ...base, status: 'NOT_PROCESSED' }, settings).verdict).toBe('FAIL');
    expect(decideVerdict({ ...base, validated: false }, settings).verdict).toBe('HUMAN_REVIEW');
  });
  it('worstVerdict follows FAIL > HUMAN_REVIEW > PASS_WITH_NOTES > PASS', () => {
    expect(worstVerdict(['PASS', 'PASS_WITH_NOTES'])).toBe('PASS_WITH_NOTES');
    expect(worstVerdict(['PASS', 'HUMAN_REVIEW', 'PASS_WITH_NOTES'])).toBe('HUMAN_REVIEW');
    expect(worstVerdict(['HUMAN_REVIEW', 'FAIL'])).toBe('FAIL');
    expect(worstVerdict([])).toBe('PASS');
  });
});

describe('evidence discipline', () => {
  it('leaves tagged text alone and marks untagged text as a hypothesis', () => {
    expect(ensureTagged('Fine. [EVIDENCE: DECH-SZ-01]')).toEqual({ text: 'Fine. [EVIDENCE: DECH-SZ-01]', amended: false });
    const r = ensureTagged('Looks odd');
    expect(r.amended).toBe(true);
    expect(hasEvidenceTag(r.text)).toBe(true);
    expect(r.text.endsWith('[HYPOTHESIS]')).toBe(true);
  });
  it('recommendation prefixes are idempotent and legal checks say "verify with counsel"', () => {
    expect(hypothesisRecommendation('Show prices in CHF.')).toBe('[HYPOTHESIS] Show prices in CHF.');
    expect(hypothesisRecommendation('Add an Impressum.', true)).toBe('[HYPOTHESIS] — verify with counsel Add an Impressum.');
    expect(hypothesisRecommendation('[HYPOTHESIS] x')).toBe('[HYPOTHESIS] x');
  });
});

describe('batching', () => {
  it('respects the segment and character limits and keeps order', () => {
    const items = [10, 10, 10, 10, 10];
    expect(makeBatches(items, { maxSegments: 2, maxChars: 1000 }, (n) => n)).toEqual([[10, 10], [10, 10], [10]]);
    expect(makeBatches(items, { maxSegments: 10, maxChars: 25 }, (n) => n)).toEqual([[10, 10], [10, 10], [10]]);
    expect(makeBatches([100, 5], { maxSegments: 10, maxChars: 50 }, (n) => n)).toEqual([[100], [5]]);
    expect(makeBatches([], { maxSegments: 2, maxChars: 10 }, () => 1)).toEqual([]);
  });
});

describe('telemetry', () => {
  const call = (cost: number | null, over: Partial<CallRecord> = {}): CallRecord => ({
    call_id: 'c',
    ts: '2026-09-30T12:00:00Z',
    stage: 'translation',
    locale: 'de-CH',
    provider: 'mock',
    model: 'mock-a',
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: cost,
    latency_ms: 10,
    attempts: 1,
    ok: true,
    segments: 1,
    warnings: [],
    ...over,
  });

  it('cost tracker trips at the ceiling and refuses further calls', () => {
    const t = new CostTracker(1);
    t.assertBudget();
    t.record(call(0.4));
    t.assertBudget();
    t.record(call(0.7));
    expect(t.exceeded).toBe(true);
    expect(() => t.assertBudget()).toThrow(EngineError);
    try {
      t.assertBudget();
    } catch (e) {
      expect((e as EngineError).code).toBe('COST_CEILING');
    }
    expect(t.totals().cost_usd).toBe(1.1);
  });
  it('unpriced calls count tokens but not cost and are reported', () => {
    const totals = totalsOf([call(0.5), call(null)]);
    expect(totals).toMatchObject({ calls: 2, input_tokens: 200, output_tokens: 100, cost_usd: 0.5, unpriced_calls: 1, latency_ms: 20 });
  });
  it('the redactor removes keys, env secrets and bearer tokens from messages and nested data', () => {
    const redact = createRedactor(['super-secret-value-123']);
    expect(redact('key sk-ant-abcdefghijklmnopqrstuv and super-secret-value-123')).toBe('key [REDACTED] and [REDACTED]');
    expect(redact('Authorization: Bearer abcdefghijklmnop1234567890')).not.toContain('abcdefghijklmnop');
    expect(redactDeep({ a: ['x sk-abcdefghijklmnopqrstuvwxyz'], n: 1 }, redact)).toEqual({ a: ['x [REDACTED]'], n: 1 });
  });
  it('the run log is append-only, timestamped and redacted', () => {
    const log = new RunLog(() => new Date('2026-09-30T12:00:00Z'), ['my-very-secret-key']);
    log.warn({ code: 'PARAM_UNSUPPORTED', message: 'ignored top_p with my-very-secret-key', stage: 'translation', provider: 'x', data: { k: 'my-very-secret-key' } });
    log.info({ code: 'STAGE_START', message: 'go' });
    const e = log.entries();
    expect(e).toHaveLength(2);
    expect(e[0]?.ts).toBe('2026-09-30T12:00:00.000Z');
    expect(JSON.stringify(e)).not.toContain('my-very-secret-key');
    expect(log.count('PARAM_UNSUPPORTED')).toBe(1);
  });
});
