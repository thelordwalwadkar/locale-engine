import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { findMarketClaims, lintSegment, type LintContext } from '../src/lint/index.js';
import type { Change, LocaleCode, MarketFacts, Operation } from '../src/schemas/index.js';

const cfg = loadConfig();

function lint(source: string, target: string, locale: LocaleCode, opts: { facts?: MarketFacts; sourceLocale?: string; operation?: Operation; changes?: Change[] } = {}) {
  const ctx: LintContext = {
    target: locale,
    profile: cfg.locales[locale],
    common: cfg.common,
    glossary: cfg.glossary,
    thresholds: { back_translation_similarity_min: 0.4 },
    ...(opts.facts ? { marketFacts: opts.facts } : {}),
  };
  const sourceLocale = opts.sourceLocale ?? 'nl-NL';
  return lintSegment(
    {
      segment_id: 'p-001',
      block_type: 'paragraph',
      operation: opts.operation ?? 'TRANSLATE_LOCALIZE',
      source_text: source,
      source_lang: sourceLocale.slice(0, 2),
      source_locale: sourceLocale,
      target_text: target,
      translatable: true,
      ...(opts.changes ? { changes: opts.changes } : {}),
    },
    ctx,
  );
}
const claimFindings = (r: ReturnType<typeof lint>) => r.findings.filter((f) => f.rule_or_category === 'INTEGRITY-MARKET-CLAIM');

describe('findMarketClaims', () => {
  it.each([
    ['Levering binnen 5 werkdagen in heel Nederland.', 'in heel Nederland', 'NL', ['NL']],
    ['Lieferung in den gesamten Niederlanden.', 'in den gesamten Niederlanden', 'NL', ['NL']],
    ['Service in ganz Deutschland.', 'in ganz Deutschland', 'DE', ['DE']],
    ['Delivery across the Netherlands.', 'across the Netherlands', 'NL', ['NL']],
    ['Fast delivery to the UK.', 'delivery to the UK', 'GB', ['GB']],
    ['Consegna in tutta Italia.', 'in tutta Italia', 'IT', ['IT']],
    ['Levering in de Benelux.', 'Levering in de Benelux', 'BENELUX', ['NL', 'BE', 'LU']],
  ])('%s', (text, phrase, country, regions) => {
    const claims = findMarketClaims(text, cfg.common);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ phrase, country, regions });
    const span = claims[0]!.span;
    expect(text.slice(span.start, span.end)).toBe(phrase);
  });

  it('generic scope claims carry no country', () => {
    for (const [text, phrase] of [
      ['Landelijke dekking met eigen servicewagens.', 'Landelijke'],
      ['Nationwide coverage.', 'Nationwide'],
      ['Wir liefern bundesweit.', 'bundesweit'],
      ['Service schweizweit.', 'schweizweit'],
    ] as const) {
      expect(findMarketClaims(text, cfg.common), text).toEqual([expect.objectContaining({ phrase, country: null, regions: [] })]);
    }
  });

  it('a country name alone, or an adjective, is never a claim', () => {
    for (const text of ['Wij zijn een Nederlands bedrijf.', 'Onze fabriek staat in Nederland.', 'Made in Germany.', 'Nederlandse kwaliteit sinds 1950.', 'In heel Nederlandse steden.']) {
      expect(findMarketClaims(text, cfg.common), text).toEqual([]);
    }
  });
});

describe('INTEGRITY-MARKET-CLAIM', () => {
  const source = 'Levering binnen 5 werkdagen in heel Nederland.';
  const reason = 'INTEGRITY-MARKET-CLAIM: source claims "in heel Nederland" and no de-CH delivery fact is supplied';

  it('a restated claim for a market without a fact is a finding that needs a human, spanning the restated phrase', () => {
    const target = 'Lieferung innert 5 Arbeitstagen <em1>in den gesamten Niederlanden</em1>.';
    const r = lint(source, target, 'de-CH');
    const [f] = claimFindings(r);
    expect(f).toMatchObject({ requires_human_review: true, target_span: 'in den gesamten Niederlanden', source_span: 'in heel Nederland', severity: 'major', repair_trigger: true });
    expect(target.slice(f!.span!.start, f!.span!.end)).toBe('in den gesamten Niederlanden');
    expect(r.review_reasons).toEqual([reason]);
  });

  it('a neutralised claim is no finding but still a review reason', () => {
    const r = lint(source, 'Lieferung innert 5 Arbeitstagen.', 'de-CH');
    expect(claimFindings(r)).toEqual([]);
    expect(r.review_reasons).toEqual([reason]);
  });

  it("the claim's own market keeps it without review", () => {
    const r = lint('Levering in heel Nederland.', 'Delivery across the Netherlands.', 'en-NL');
    expect(claimFindings(r)).toEqual([]);
    expect(r.review_reasons).toEqual([]);
  });

  it('a supplied delivery fact confirms the market; its own phrase may appear, the source country may not', () => {
    const facts = { delivery: 'in die ganze Schweiz' };
    const ok = lint('Levering in heel Nederland.', 'Lieferung in die ganze Schweiz.', 'de-CH', { facts });
    expect(claimFindings(ok)).toEqual([]);
    expect(ok.review_reasons).toEqual([]);
    const restated = lint('Levering in heel Nederland.', 'Lieferung in den gesamten Niederlanden.', 'de-CH', { facts });
    expect(claimFindings(restated)).toHaveLength(1);
    expect(claimFindings(restated)[0]?.suggested_fix).toContain('"in die ganze Schweiz"');
    const gb = lint('Levering in heel Nederland.', 'Delivery across the United Kingdom.', 'en-GB', { facts: { delivery: 'across the United Kingdom' } });
    expect(claimFindings(gb)).toEqual([]);
  });

  it('generic claims belong to the source region; an unknown source region never covers them', () => {
    expect(lint('Nationwide delivery.', 'Nationwide delivery.', 'en-GB', { sourceLocale: 'en-GB', operation: 'ADAPT_ONLY' }).review_reasons).toEqual([]);
    const unknown = lint('Nationwide delivery.', 'Nationwide delivery.', 'en-GB', { sourceLocale: 'en-*', operation: 'ADAPT_ONLY' });
    expect(claimFindings(unknown)).toHaveLength(1);
    expect(unknown.review_reasons).toHaveLength(1);
    const asCountry = lint('Landelijke dekking.', 'Coverage across the Netherlands.', 'en-GB');
    expect(claimFindings(asCountry)[0]?.target_span).toBe('across the Netherlands');
  });

  it('never fires on a target that merely mentions the country', () => {
    const r = lint(source, 'Unsere Pumpen werden in den Niederlanden gefertigt.', 'de-CH');
    expect(claimFindings(r)).toEqual([]);
  });
});

describe('INTEGRITY-EMPTY accepts the deliberate removal of a pure claim', () => {
  const removal: Change = { from: 'Lieferung in den gesamten Niederlanden', to: '', rule: 'INTEGRITY-MARKET-CLAIM', reason: '[EVIDENCE: INTEGRITY-MARKET-CLAIM] neutralised', origin: 'llm' };
  const empty = (r: ReturnType<typeof lint>) => r.findings.filter((f) => f.rule_or_category === 'INTEGRITY-EMPTY');
  it('no finding when the source is essentially only the claim', () => {
    expect(empty(lint('Levering in heel Nederland.', '', 'de-CH', { changes: [removal] }))).toEqual([]);
  });
  it('a finding without the change, or when the source says more than the claim', () => {
    expect(empty(lint('Levering in heel Nederland.', '', 'de-CH'))).toHaveLength(1);
    expect(empty(lint('Levering binnen 5 werkdagen in heel Nederland.', '', 'de-CH', { changes: [removal] }))).toHaveLength(1);
  });
});
