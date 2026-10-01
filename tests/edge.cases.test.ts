/**
 * The six edge-case exemplars of prompts/exemplars/edge_*.md (spec §5.2), each driven end to end through the real engine with the offline
 * mock provider: the model's answer is scripted, everything else (routing, rules, autofix, format normalisation, recommendations, verdicts)
 * is the production code.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { createEngine } from '../src/pipeline/engine.js';
import type { MockCall, MockFixtures } from '../src/providers/mock.js';
import { createProviderRegistry } from '../src/providers/registry.js';
import { ProvidersConfigSchema } from '../src/schemas/index.js';
import type { InputSpec, LocaleResult, RunReport } from '../src/schemas/index.js';
import { fixturePath } from './fixtures/ingest/helpers.js';

const config = loadConfig();
const providers = ProvidersConfigSchema.parse({
  version: 1,
  providers: { mock: { kind: 'mock', default_model: 'm', models: { m: { id: 'm', structured_output: 'native', pricing: { input_per_mtok: 0, output_per_mtok: 0 }, pricing_verified: true } } } },
  routing: { default_provider: 'mock', stages: {} },
});

async function run(input: InputSpec, targets: string[], fixtures: MockFixtures = {}, options: Record<string, unknown> = {}): Promise<{ report: RunReport; calls: MockCall[] }> {
  const calls: MockCall[] = [];
  const registry = createProviderRegistry({ config: providers, env: {}, mockScript: { fixtures, calls } });
  const engine = createEngine({ config, env: {}, registryFactory: async () => registry });
  const report = await engine.runPipeline({ input, targets: targets as never, options: { backtranslate: false, repair: false, write_outputs: false, ...options } });
  return { report, calls };
}

const html = (body: string, name?: string): InputSpec => ({ kind: 'text', format: 'html', text: `<main>${body}</main>`, ...(name ? { name } : {}) });
const locale = (r: RunReport, code: string): LocaleResult => r.locales.find((l) => l.target_locale === code) as LocaleResult;
const openRules = (l: LocaleResult): string[] =>
  l.segments.flatMap((s) => s.validation?.findings ?? []).filter((f) => f.status === 'open').map((f) => f.rule_or_category);
const seg = (l: LocaleResult, id: string) => l.segments.find((s) => s.segment_id === id)!;
const say = (loc: string, id: string, text: string): MockFixtures => ({
  translation: { [loc]: { [id]: { translation: text } } },
  localization: { [loc]: { [id]: { localized_text: text } } },
});

describe('edge_false_friend: Dutch -> English false friends are caught', () => {
  const source = html('<p>Neem contact op voor een actuele offerte.</p>');
  it('"an actual offer" is two major findings that name the rules; "a current quotation" is clean', async () => {
    const bad = await run(source, ['en-NL'], say('en-NL', 'p-001', 'Contact us for an actual offer.'), { source_locale: 'nl-NL' });
    const l = locale(bad.report, 'en-NL');
    expect(openRules(l)).toEqual(expect.arrayContaining(['ENNL-FF-ACTUEEL', 'ENNL-FF-OFFERTE']));
    const findings = seg(l, 'p-001').validation?.findings ?? [];
    expect(findings.filter((f) => f.rule_or_category.startsWith('ENNL-FF-')).every((f) => f.severity === 'major' && f.origin === 'deterministic')).toBe(true);
    expect(l.verdict).not.toBe('PASS');

    const good = await run(source, ['en-NL'], say('en-NL', 'p-001', 'Contact us for a current quotation.'), { source_locale: 'nl-NL' });
    expect(openRules(locale(good.report, 'en-NL')).filter((r) => r.startsWith('ENNL-FF-'))).toEqual([]);
  });
});

describe('edge_variant_divergence: en-NL and en-GB are different outputs of one source', () => {
  const source = html('<p>Prijs € 1.250,00 excl. BTW.</p>');
  const fixtures: MockFixtures = {
    translation: { 'en-NL': { 'p-001': { translation: 'Price € 1.250,00 excl. VAT (BTW).' } }, 'en-GB': { 'p-001': { translation: 'Price € 1.250,00 excl. VAT.' } } },
    localization: { 'en-NL': { 'p-001': { localized_text: 'Price € 1.250,00 excl. VAT (BTW).' } }, 'en-GB': { 'p-001': { localized_text: 'Price € 1.250,00 excl. VAT.' } } },
  };

  it('the code reformats the number (the model kept it verbatim), keeps the euro, and only en-NL carries "(BTW)"', async () => {
    const { report } = await run(source, ['en-NL', 'en-GB'], fixtures, { source_locale: 'nl-NL' });
    const nl = locale(report, 'en-NL');
    const gb = locale(report, 'en-GB');
    expect(seg(nl, 'p-001').final_text).toBe('Price €1,250.00 excl. VAT (BTW).');
    expect(seg(gb, 'p-001').final_text).toBe('Price €1,250.00 excl. VAT.');
    expect(seg(nl, 'p-001').format_changes).toHaveLength(1); // logged FORMAT_CHANGE, nothing converted to pounds
    expect(openRules(nl)).not.toContain('ENNL-BTW-01');
    expect(gb.recommendations.map((r) => r.id)).toContain('ENGB-MARKET-CUR'); // "UK buyers expect GBP pricing — confirm currency policy"
    expect(nl.recommendations.map((r) => r.id)).not.toContain('ENGB-MARKET-CUR');
  });

  it('a missing "(BTW)" on first mention is a finding for en-NL only', async () => {
    const both: MockFixtures = {
      translation: { 'en-NL': { 'p-001': { translation: 'Price € 1.250,00 excl. VAT.' } }, 'en-GB': { 'p-001': { translation: 'Price € 1.250,00 excl. VAT.' } } },
      localization: { 'en-NL': { 'p-001': { localized_text: 'Price € 1.250,00 excl. VAT.' } }, 'en-GB': { 'p-001': { localized_text: 'Price € 1.250,00 excl. VAT.' } } },
    };
    const { report } = await run(source, ['en-NL', 'en-GB'], both, { source_locale: 'nl-NL' });
    expect(openRules(locale(report, 'en-NL'))).toContain('ENNL-BTW-01');
    expect(openRules(locale(report, 'en-GB'))).not.toContain('ENNL-BTW-01');
  });
});

describe('edge_de_at_month: German variants differ even in month names', () => {
  const source = html('<p>Beschikbaar vanaf januari 2027.</p>');
  const fixtures = (de: string, at: string, ch: string): MockFixtures => ({
    translation: { 'de-DE': { 'p-001': { translation: de } }, 'de-AT': { 'p-001': { translation: at } }, 'de-CH': { 'p-001': { translation: ch } } },
    localization: { 'de-DE': { 'p-001': { localized_text: de } }, 'de-AT': { 'p-001': { localized_text: at } }, 'de-CH': { 'p-001': { localized_text: ch } } },
  });

  it('Jänner in de-AT, Januar in de-DE and de-CH: clean; the other way round is flagged', async () => {
    const ok = await run(source, ['de-DE', 'de-AT', 'de-CH'], fixtures('Verfügbar ab Januar 2027.', 'Verfügbar ab Jänner 2027.', 'Verfügbar ab Januar 2027.'), { source_locale: 'nl-NL' });
    for (const code of ['de-DE', 'de-AT', 'de-CH']) expect(openRules(locale(ok.report, code)).filter((r) => /MONTH/.test(r)), code).toEqual([]);

    const wrong = await run(source, ['de-DE', 'de-AT'], fixtures('Verfügbar ab Jänner 2027.', 'Verfügbar ab Januar 2027.', ''), { source_locale: 'nl-NL' });
    expect(openRules(locale(wrong.report, 'de-AT'))).toContain('DEAT-MONTH-01');
    expect(openRules(locale(wrong.report, 'de-DE'))).toContain('DEDE-MONTH-01');
  });

  it('a written date gets the period after the day (deterministic autofix of DEDE-DATE-02, no model call to repair it)', async () => {
    const date = html('<p>Levering op 30 september 2026.</p>');
    const { report, calls } = await run(date, ['de-DE'], say('de-DE', 'p-001', 'Lieferung am 30 September 2026.'), { source_locale: 'nl-NL', repair: true });
    const l = locale(report, 'de-DE');
    expect(seg(l, 'p-001').final_text).toBe('Lieferung am 30. September 2026.');
    expect(seg(l, 'p-001').repairs.map((r) => r.origin)).toEqual(['autofix']);
    expect(openRules(l)).toEqual([]);
    expect(calls.filter((c) => c.stage === 'repair')).toEqual([]);
    // with the repair stage switched off the slip stays visible as an open finding
    const off = await run(date, ['de-DE'], say('de-DE', 'p-001', 'Lieferung am 30 September 2026.'), { source_locale: 'nl-NL', repair: false });
    expect(openRules(locale(off.report, 'de-DE'))).toContain('DEDE-DATE-02');
  });
});

describe('edge_same_language: the source is already in the target language', () => {
  const source = html('<p>The impeller turns and the liquid is thrown outwards at high speed.</p>');
  it('en-GB -> en-GB never reaches a model; en-GB -> en-NL is an adaptation without a translation step', async () => {
    const { report, calls } = await run(source, ['en-GB', 'en-NL'], {}, { source_locale: 'en-GB' });
    expect(locale(report, 'en-GB').operations).toEqual({ SKIP_IDENTICAL: 1 });
    expect(locale(report, 'en-NL').operations).toEqual({ ADAPT_ONLY: 1 });
    expect(calls.filter((c) => c.stage === 'translation')).toEqual([]);
    expect(calls.filter((c) => c.stage === 'localization').map((c) => c.payload['target_locale'])).toEqual(['en-NL']);
    expect(seg(locale(report, 'en-GB'), 'p-001').final_text).toBe('The impeller turns and the liquid is thrown outwards at high speed.');
    expect(seg(locale(report, 'en-NL'), 'p-001').changes).toEqual([]); // fidelity to the source wording is the default
  });
});

describe('edge_mixed_language: a Dutch page with an English spec table', () => {
  it('translates the Dutch segments and only adapts the English ones, per segment', async () => {
    const { report, calls } = await run({ kind: 'file', path: fixturePath('pumps-mixed.html') }, ['en-GB'], {}, { source_locale: 'nl-NL' });
    const l = locale(report, 'en-GB');
    expect(Object.keys(l.operations).sort()).toEqual(['ADAPT_ONLY', 'TRANSLATE_LOCALIZE']);
    const english = l.segments.filter((s) => s.operation === 'ADAPT_ONLY');
    expect(english.map((s) => s.source_text)).toEqual(expect.arrayContaining(['Suitable for clean and dirty water applications']));
    for (const s of english) expect(s.final_text, s.segment_id).toBe(s.source_text);
    // the translation call carries the Dutch segments only
    const translated = calls.filter((c) => c.stage === 'translation').flatMap((c) => (c.payload['segments'] as Array<Record<string, unknown>>).map((x) => x['source_language']));
    expect(new Set(translated)).toEqual(new Set(['nl']));
  });
});

describe('edge_legal_page: translation only, never localized, every segment for a human', () => {
  it('a /privacyverklaring page is TRANSLATE_ONLY, flags every segment and carries counsel recommendations', async () => {
    const { report, calls } = await run({ kind: 'file', path: fixturePath('privacyverklaring.html') }, ['de-DE'], {}, { source_locale: 'nl-NL' });
    expect(report.source.page_type).toBe('LEGAL');
    const l = locale(report, 'de-DE');
    expect(l.operations).toEqual({ TRANSLATE_ONLY: l.counts.segments });
    expect(calls.filter((c) => c.stage === 'localization')).toEqual([]);
    expect(l.segments.filter((s) => s.requires_human_review)).toHaveLength(l.counts.segments);
    expect(l.verdict).toBe('HUMAN_REVIEW');
    const legal = l.recommendations.find((r) => r.id === 'DEDE-MARKET-LEGAL');
    expect(legal?.text).toContain('verify with counsel');
    expect(path.basename(report.source.origin_ref)).toBe('privacyverklaring.html');
  });
});
