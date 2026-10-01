/**
 * Phase 5 gate (DDR-008): every `tests` entry of every rule file behaves as declared when executed by the lint engine, and the
 * golden segment (spec §5.1) yields the golden deterministic checks.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { lintSegment, runAllRuleTests, type LintContext, type LintSegmentInput } from '../src/lint/index.js';
import { LOCALES, type Change, type DeterministicCheck, type LocaleCode } from '../src/schemas/index.js';
import { fixturesDir } from '../src/util/paths.js';

const cfg = loadConfig();
const outcomes = runAllRuleTests(cfg);

interface GoldenFixture {
  segment_id: string;
  source_locale: string;
  source_lang: string;
  target_locale: LocaleCode;
  source_text: string;
  translation: string;
  localized_text: string;
  changes: Change[];
  expected_pass_checks: DeterministicCheck[];
  expected_review_reasons: string[];
}
const golden = JSON.parse(readFileSync(path.join(fixturesDir(), 'lint', 'golden-p003.json'), 'utf8')) as GoldenFixture;

function goldenLint(targetText: string) {
  const ctx: LintContext = {
    target: golden.target_locale,
    profile: cfg.locales[golden.target_locale],
    common: cfg.common,
    glossary: cfg.glossary,
    thresholds: { back_translation_similarity_min: cfg.stages.thresholds.back_translation_similarity_min },
  };
  const input: LintSegmentInput = {
    segment_id: golden.segment_id,
    block_type: 'paragraph',
    operation: 'TRANSLATE_LOCALIZE',
    source_text: golden.source_text,
    source_lang: golden.source_lang,
    source_locale: golden.source_locale,
    target_text: targetText,
    translatable: true,
    changes: golden.changes,
  };
  return lintSegment(input, ctx);
}

describe('runAllRuleTests', () => {
  it('executes every test entry of every rule file exactly once', () => {
    const own = LOCALES.reduce((n, l) => n + cfg.locales[l].rules.reduce((m, r) => m + r.tests.length, 0), 0);
    const shared = cfg.common.rules.reduce((m, r) => m + r.tests.length, 0);
    expect(outcomes).toHaveLength(own + shared);
    expect(outcomes.filter((o) => o.fixed_ok !== null).length).toBeGreaterThan(20);
  });

  it.each(outcomes.map((o) => [`${o.locale} ${o.rule_id} #${o.index} (expect ${o.expect})`, o] as const))('%s', (_, o) => {
    expect(o.ok, o.detail).toBe(true);
    expect(o.fixed_ok, o.detail).not.toBe(false);
  });

  it('reports mismatches with a readable detail', () => {
    const broken = { ...cfg, locales: { ...cfg.locales } };
    const ch = cfg.locales['de-CH'];
    // a copy of DECH-SZ-01 whose test now claims the ß sentence passes
    const rule = ch.effective_rules.find((r) => r.id === 'DECH-SZ-01');
    if (!rule) throw new Error('DECH-SZ-01 missing');
    const wrong = { ...rule, tests: [{ target: 'Die Größe beträgt 80 Meter.', expect: 'pass' as const }] };
    broken.locales['de-CH'] = { ...ch, rules: [wrong], effective_rules: ch.effective_rules.map((r) => (r.id === rule.id ? wrong : r)) };
    const res = runAllRuleTests(broken).find((o) => o.locale === 'de-CH' && o.rule_id === 'DECH-SZ-01');
    expect(res?.ok).toBe(false);
    expect(res?.actual).toBe('fail');
    expect(res?.detail).toContain('expected pass, got fail');
    expect(res?.detail).toContain('"ß"');
  });
});

describe('golden segment p-003 (spec §5.1, nl-NL -> de-CH)', () => {
  it('the final localized text yields exactly the two golden checks and the market-claim review reason', () => {
    const res = goldenLint(golden.localized_text);
    expect(res.checks).toEqual(golden.expected_pass_checks);
    expect(res.review_reasons).toEqual(golden.expected_review_reasons);
    expect(res.findings.filter((f) => f.severity !== 'minor')).toEqual([]);
  });

  it('is clean: "debiet" rendered as the verb "fördern" satisfies GLOSS-0016 (verb forms are accepted glossary variants)', () => {
    const res = goldenLint(golden.localized_text);
    expect(res.findings).toEqual([]);
  });

  it('the neutral translation triggers exactly the localization changes the golden made', () => {
    const res = goldenLint(golden.translation);
    const rules = [...new Set(res.findings.map((f) => f.rule_or_category))].sort();
    expect(rules).toEqual(expect.arrayContaining(['DECH-LEX-ARBEITSTAGE', 'DECH-LEX-INNERT', 'DECH-LEX-OFFERTE', 'INTEGRITY-MARKET-CLAIM']));
    const claim = res.findings.find((f) => f.rule_or_category === 'INTEGRITY-MARKET-CLAIM');
    expect(claim?.target_span).toBe('in den gesamten Niederlanden');
    expect(claim?.requires_human_review).toBe(true);
    const offerte = res.findings.find((f) => f.rule_or_category === 'DECH-LEX-OFFERTE');
    expect(offerte?.target_span).toBe('ein unverbindliches Angebot');
  });
});
