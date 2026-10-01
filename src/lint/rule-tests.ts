/**
 * Executes the `tests` blocks of the rule files (DDR-008: rules are self-verifying). Locale rules run under their own locale,
 * `_common.yaml` rules once, under each test's `target_locale` (default de-DE).
 */
import type { LoadedConfig } from '../config/load.js';
import { languageOf, LOCALES, type FindingDraft, type LocaleCode, type Rule, type RuleTest } from '../schemas/index.js';
import { applyAutofix } from './autofix.js';
import { quote } from './draft.js';
import { lintDocument, lintSegment } from './engine.js';
import type { LintContext, LintSegmentInput, RuleTestOutcome } from './types.js';

type RuleTestConfig = Pick<LoadedConfig, 'locales' | 'common' | 'glossary' | 'stages'>;

const COMMON_DEFAULT_LOCALE: LocaleCode = 'de-DE';

function describe(findings: FindingDraft[]): string {
  if (findings.length === 0) return 'no finding';
  const each = findings.map((f) => (f.target_span !== null ? `${quote(f.target_span)}${f.span ? ` @${f.span.start}-${f.span.end}` : ''}` : f.explanation));
  return `${findings.length} finding(s): ${each.join('; ')}`;
}

function runRuleTest(config: RuleTestConfig, rule: Rule, test: RuleTest, index: number, locale: LocaleCode): RuleTestOutcome {
  const base = { rule_id: rule.id, locale, index, expect: test.expect };
  const target = config.locales[locale];
  if (!target) return { ...base, actual: 'pass', ok: false, fixed_ok: null, detail: `no profile for target locale ${locale}` };
  // the rule under test must be in force even when a test borrows another locale's profile
  const profile = target.effective_rules.some((r) => r.id === rule.id) ? target : { ...target, effective_rules: [...target.effective_rules, rule] };
  const ctx: LintContext = {
    target: locale,
    profile,
    common: config.common,
    glossary: config.glossary,
    thresholds: { back_translation_similarity_min: config.stages.thresholds.back_translation_similarity_min },
    ...(test.market_facts ? { marketFacts: test.market_facts } : {}),
  };
  const sourceLocale = test.source_locale ?? 'nl-NL';
  const input: LintSegmentInput = {
    segment_id: `${rule.id}#${index}`,
    block_type: test.block_type ?? 'paragraph',
    ...(test.meta_kind ? { meta_kind: test.meta_kind } : {}),
    operation: test.operation ?? 'TRANSLATE_LOCALIZE',
    source_text: test.source ?? '',
    source_lang: test.source_lang ?? languageOf(sourceLocale),
    source_locale: sourceLocale,
    target_text: test.target,
    translatable: true,
    back_translation: test.back_translation ?? null,
  };
  const documentLevel = rule.type === 'first_mention' || rule.type === 'currency_policy';
  const result = documentLevel ? lintDocument([input], ctx) : lintSegment(input, ctx);
  const mine = result.findings.filter((f) => f.rule_or_category === rule.id);
  const actual = mine.length > 0 ? 'fail' : 'pass';
  const ok = actual === test.expect;
  const parts = [ok ? `${actual} as expected (${describe(mine)})` : `expected ${test.expect}, got ${actual} (${describe(mine)})`];
  let fixed_ok: boolean | null = null;
  if (test.fixed !== undefined) {
    const fixed = applyAutofix(test.target, mine).text;
    fixed_ok = fixed === test.fixed;
    if (!fixed_ok) parts.push(`autofix produced ${quote(fixed)}, expected ${quote(test.fixed)}`);
  }
  return { ...base, actual, ok, fixed_ok, detail: parts.join('; ') };
}

/** Every `tests` entry of every rule of every locale (common rules once). */
export function runAllRuleTests(config: RuleTestConfig): RuleTestOutcome[] {
  const out: RuleTestOutcome[] = [];
  for (const code of LOCALES) {
    const profile = config.locales[code];
    if (!profile) continue;
    for (const declared of profile.rules) {
      const rule = profile.effective_rules.find((r) => r.id === declared.id) ?? declared;
      rule.tests.forEach((t, i) => out.push(runRuleTest(config, rule, t, i, t.target_locale ?? code)));
    }
  }
  for (const declared of config.common.rules) {
    declared.tests.forEach((t, i) => {
      const locale = t.target_locale ?? COMMON_DEFAULT_LOCALE;
      const rule = config.locales[locale]?.effective_rules.find((r) => r.id === declared.id) ?? declared;
      out.push(runRuleTest(config, rule, t, i, locale));
    });
  }
  return out;
}
