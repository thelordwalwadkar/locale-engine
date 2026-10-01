/**
 * Phase 1 gate: the frozen configuration is complete, consistent and executable.
 * "Every rule has an ID, severity and at least one test string" (spec Phase 1) plus the cross-file invariants the later phases rely on.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { findGlossaryHits, doNotTranslateForms } from '../src/config/glossary.js';
import { LOCALES, regionOf, languageOf, type LocaleCode } from '../src/schemas/common.js';
import type { Rule } from '../src/schemas/locale.js';
import { compilePattern, expandPattern, matchAll } from '../src/util/regex.js';

const cfg = loadConfig();

function rulePatterns(rule: Rule): Array<{ where: string; source: string; flags?: string }> {
  const out: Array<{ where: string; source: string; flags?: string }> = [];
  const add = (where: string, source: string, flags?: string) => out.push({ where: `${rule.id} ${where}`, source, ...(flags !== undefined ? { flags } : {}) });
  switch (rule.type) {
    case 'lexicon':
      rule.terms.forEach((t, i) => add(`terms[${i}]`, t.pattern, rule.flags));
      break;
    case 'conditional':
      add('when_source', rule.when_source, rule.flags);
      if (rule.unless_source) add('unless_source', rule.unless_source, rule.flags);
      rule.target_forbid.forEach((p, i) => add(`target_forbid[${i}]`, p, rule.flags));
      rule.target_require.forEach((p, i) => add(`target_require[${i}]`, p, rule.flags));
      break;
    case 'first_mention':
      add('when_source', rule.when_source, rule.flags);
      add('term', rule.term, rule.flags);
      add('required_form', rule.required_form, rule.flags);
      break;
    default:
  }
  return out;
}

describe('config loads and validates', () => {
  it('loads every file with the schemas', () => {
    expect(Object.keys(cfg.locales).sort()).toEqual([...LOCALES].sort());
    expect(cfg.glossary.length).toBeGreaterThanOrEqual(40);
    expect(cfg.stages.version).toBe(1);
    expect(cfg.providers.routing.default_provider).toBeTruthy();
    expect(cfg.common.rules.length).toBeGreaterThan(5);
  });

  it('market_facts.yaml is an empty template (the engine never invents business facts)', () => {
    expect(cfg.marketFacts).toEqual({});
  });

  it('brand_voice.md is a template until filled in', () => {
    expect(cfg.brandVoice.startsWith('<!-- locale-engine:template -->')).toBe(true);
  });
});

describe('stage parameters match spec §0.2', () => {
  const expected = {
    language_detection: [0.0, 1.0],
    translation: [0.2, 0.9],
    localization: [0.3, 0.9],
    validation: [0.0, 1.0],
    backtranslation: [0.0, 1.0],
    repair: [0.1, 0.9],
  } as const;
  for (const [stage, [t, p]] of Object.entries(expected)) {
    it(`${stage}: temperature ${t}, top_p ${p}, justification present`, () => {
      const s = cfg.stages.stages[stage as keyof typeof expected];
      expect(s.temperature).toBe(t);
      expect(s.top_p).toBe(p);
      expect(s.justification.length).toBeGreaterThan(5);
    });
  }
  it('defaults match spec §3', () => {
    expect(cfg.stages.thresholds.pass).toBe(90);
    expect(cfg.stages.thresholds.max_repair_loops).toBe(2);
    expect(cfg.stages.cost.ceiling_usd).toBe(5);
    expect(cfg.stages.locale_matrix.pivot).toBe('direct');
    expect(cfg.stages.locale_matrix.enable_en_to_nl).toBe(false);
    expect(cfg.stages.locale_matrix.default_targets.nl).toEqual(['en-NL', 'en-GB', 'de-DE', 'de-AT', 'de-CH', 'it-IT']);
  });
});

describe.each(LOCALES)('locale profile %s', (code) => {
  const p = cfg.locales[code as LocaleCode];

  it('identity is consistent', () => {
    expect(p.locale).toBe(code);
    expect(p.language).toBe(languageOf(code));
    expect(p.region).toBe(regionOf(code));
    expect(p.hreflang).toBe(code);
  });

  it('every effective rule has an id, a severity, a message and at least one test string', () => {
    expect(p.effective_rules.length).toBeGreaterThan(0);
    for (const r of p.effective_rules) {
      expect(r.id, 'rule id').toMatch(/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/);
      expect(['minor', 'major', 'critical'], `${r.id} severity`).toContain(r.severity);
      expect(r.message.length, `${r.id} message`).toBeGreaterThan(10);
      expect(r.tests.length, `${r.id} tests`).toBeGreaterThanOrEqual(1);
      for (const t of r.tests) expect(typeof t.target, `${r.id} test target`).toBe('string');
    }
  });

  it('rule ids are unique and locale rules carry the locale prefix', () => {
    const prefix = code.replace('-', '').toUpperCase();
    const ids = p.effective_rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of p.rules) expect(r.id.startsWith(`${prefix}-`), `${r.id} should start with ${prefix}-`).toBe(true);
  });

  it('has exactly one format rule per aspect', () => {
    for (const aspect of ['number', 'currency', 'date']) {
      expect(p.effective_rules.filter((r) => r.type === 'format' && r.aspect === aspect)).toHaveLength(1);
    }
  });

  it('every pattern compiles with the engine dialect', () => {
    for (const r of p.effective_rules) for (const pat of rulePatterns(r)) expect(() => compilePattern(pat.source, pat.flags), pat.where).not.toThrow();
  });

  it('every autofix rule can rewrite, and proves it with a `fixed` test', () => {
    for (const r of p.effective_rules.filter((x) => x.autofix)) {
      expect(r.tests.some((t) => t.expect === 'fail' && t.fixed !== undefined), `${r.id} needs a failing test with "fixed"`).toBe(true);
      if (r.type === 'lexicon') for (const t of r.terms) expect(t.prefer, `${r.id} autofix term ${t.pattern}`).not.toBeUndefined();
    }
  });

  it('formatting block is coherent', () => {
    const f = p.formatting;
    expect(f.number.accepted_thousands).toContain(f.number.thousands);
    expect(f.number.decimal).not.toBe(f.number.thousands);
    expect(f.currency.local_code).toMatch(/^[A-Z]{3}$/);
    expect(f.currency.example.length).toBeGreaterThan(3);
    expect(p.seo.title_max).toBe(60);
    expect(p.seo.meta_description_max).toBe(155);
  });

  it('legal and regulatory market checks are marked verify_with_counsel', () => {
    for (const m of p.market_checks) {
      if (m.applies === 'legal_page' || /IMPRESSUM|REG|OVGW|SVGW|PIVA|MARKING|-CE|LEGAL/.test(m.id)) {
        expect(m.verify_with_counsel, m.id).toBe(true);
      }
    }
    expect(p.market_checks.some((m) => m.applies === 'legal_page'), 'needs a legal_page check').toBe(true);
  });
});

describe('spec-mandated rules exist with the stated severity', () => {
  const all = (code: LocaleCode) => new Map(cfg.locales[code].effective_rules.map((r) => [r.id, r]));
  it('en-NL', () => {
    const r = all('en-NL');
    for (const id of ['ENNL-SPELL-01', 'ENNL-FF-ACTUEEL', 'ENNL-FF-EVENTUEEL', 'ENNL-FF-OFFERTE', 'ENNL-FF-CONTROLEREN', 'ENNL-BTW-01']) expect(r.has(id), id).toBe(true);
  });
  it('en-GB', () => {
    const r = all('en-GB');
    for (const id of ['ENGB-SPELL-01', 'ENGB-TONE-01']) expect(r.has(id), id).toBe(true);
  });
  it('de-AT has DEAT-MONTH-01', () => {
    expect(all('de-AT').has('DEAT-MONTH-01')).toBe(true);
  });
  it('de-CH: DECH-SZ-01 is critical, plus DECH-QUOTE-01, DECH-NUM-01 and the golden lexical rules', () => {
    const r = all('de-CH');
    expect(r.get('DECH-SZ-01')?.severity).toBe('critical');
    for (const id of ['DECH-QUOTE-01', 'DECH-NUM-01', 'DECH-LEX-OFFERTE', 'DECH-LEX-INNERT']) expect(r.has(id), id).toBe(true);
  });
  it('shared integrity rules are critical where the spec says so', () => {
    const r = all('de-CH');
    expect(r.get('INTEGRITY-ENTITY')?.severity).toBe('critical');
    expect(r.get('INTEGRITY-URL')?.severity).toBe('critical');
    expect(r.has('INTEGRITY-MARKET-CLAIM')).toBe(true);
  });
  it('de-CH guidance shown to models never spells a German word with ß (the bare letter may be named)', () => {
    const p = cfg.locales['de-CH'];
    const corpus = [p.description, ...p.prompt_notes, ...p.market_checks.map((m) => m.text)].join(' ');
    expect(/\p{L}ß|ß\p{L}/u.test(corpus)).toBe(false);
  });
});

describe('shared data in _common.yaml', () => {
  it('every entity and claim pattern compiles', () => {
    const e = cfg.common.entities;
    for (const s of [...e.product_code_patterns, ...e.phone_patterns, ...e.protected_patterns, e.url_pattern, e.email_pattern]) expect(() => compilePattern(s, ''), s).not.toThrow();
    const names = (c: { names: string[] }) => c.names.join('|');
    for (const country of Object.values(cfg.common.market_claims.countries)) {
      for (const sp of cfg.common.market_claims.scope_patterns) {
        expect(sp.includes('{COUNTRY}'), sp).toBe(true);
        expect(() => compilePattern(sp.replace('{COUNTRY}', `(?:${names(country)})`)), sp).not.toThrow();
      }
    }
    for (const gp of cfg.common.market_claims.generic_scope_patterns) expect(() => compilePattern(gp), gp).not.toThrow();
  });
  it('page classification patterns compile', () => {
    for (const s of [...cfg.stages.page_classification.legal_url_patterns, ...cfg.stages.page_classification.legal_title_patterns]) {
      expect(() => compilePattern(s), s).not.toThrow();
    }
    const legal = cfg.stages.page_classification.legal_url_patterns.map((s) => compilePattern(s));
    const hit = (path: string) => legal.some((re) => matchAll(re, path).length > 0);
    expect(hit('/privacyverklaring')).toBe(true);
    expect(hit('/nl/privacy-policy/')).toBe(true);
    expect(hit('/impressum.html')).toBe(true);
    expect(hit('/algemene-voorwaarden')).toBe(true);
    expect(hit('/producten/centrifugaalpompen')).toBe(false);
    expect(hit('/over-ons')).toBe(false);
  });
  it('the \\b rewrite is Unicode-aware', () => {
    expect(matchAll(compilePattern('\\bÜbung\\b'), 'eine Übung hier')).toHaveLength(1);
    expect(matchAll(compilePattern('\\bJanuar\\b'), 'im Januar 2027')).toHaveLength(1);
    expect(matchAll(compilePattern('\\bJanuar\\b'), 'Januarloch')).toHaveLength(0);
    expect(expandPattern('[\\b]\\bx')).toContain('[\\b]'); // inside a class it is left alone
  });
  it('month tables have 12 entries and de-AT says Jänner', () => {
    expect(cfg.common.month_names['de-AT']?.[0]).toBe('Jänner');
    expect(cfg.common.month_names['de']?.[0]).toBe('Januar');
  });
});

describe('glossary (termbase)', () => {
  it('has >= 40 industrial pump terms, unique ids, every locale column filled for translatable terms', () => {
    expect(new Set(cfg.glossary.map((g) => g.term_id)).size).toBe(cfg.glossary.length);
    const translatable = cfg.glossary.filter((g) => !g.do_not_translate);
    expect(translatable.length).toBeGreaterThanOrEqual(40);
    for (const g of cfg.glossary) {
      for (const loc of LOCALES) expect(g.forms[loc]?.length, `${g.term_id} ${loc}`).toBeGreaterThan(0);
    }
  });
  it('do-not-translate terms are identical in every locale', () => {
    for (const g of cfg.glossary.filter((x) => x.do_not_translate)) {
      const distinct = new Set(Object.values(g.forms).map((f) => f.join('|')));
      expect(distinct.size, g.term_id).toBe(1);
    }
    const dnt = doNotTranslateForms(cfg.glossary);
    for (const b of ['Flygt', 'Godwin', 'Xylem', 'Lowara', 'Grundfos', 'Ebara', 'SAER']) expect(dnt).toContain(b);
  });
  it('de-CH forms never contain ß', () => {
    for (const g of cfg.glossary) for (const f of g.forms['de-CH'] ?? []) expect(f.includes('ß'), `${g.term_id} ${f}`).toBe(false);
  });
  it('golden-standard term ids (spec §5.1) are fixed', () => {
    const byId = new Map(cfg.glossary.map((g) => [g.term_id, g]));
    expect(byId.get('GLOSS-0012')?.forms['nl-NL']).toEqual(['centrifugaalpomp']);
    expect(byId.get('GLOSS-0012')?.forms['de-CH']?.[0]).toBe('Kreiselpumpe');
    expect(byId.get('GLOSS-0019')?.forms['nl-NL']).toEqual(['opvoerhoogte']);
    expect(byId.get('GLOSS-0019')?.forms['de-CH']?.[0]).toBe('Förderhöhe');
  });
  it('spec terminology: offerte, werkdagen, prevalenza, portata, preventivo', () => {
    const f = (id: string, loc: LocaleCode) => cfg.glossary.find((g) => g.term_id === id)?.forms[loc]?.[0];
    expect(f('GLOSS-0047', 'de-DE')).toBe('Angebot');
    expect(f('GLOSS-0047', 'de-CH')).toBe('Offerte');
    expect(f('GLOSS-0047', 'it-IT')).toBe('preventivo');
    expect(f('GLOSS-0049', 'de-DE')).toBe('Werktag');
    expect(f('GLOSS-0016', 'it-IT')).toBe('portata');
    expect(f('GLOSS-0019', 'it-IT')).toBe('prevalenza');
  });
  it('finds the golden segment terms (with plural tolerance)', () => {
    const text = 'Onze centrifugaalpompen leveren een debiet tot 450 m³/h bij een opvoerhoogte van 80 meter. Vraag vandaag nog een vrijblijvende offerte aan — levering binnen 5 werkdagen in heel Nederland.';
    const hits = findGlossaryHits(text, 'nl', cfg.glossary).map((h) => h.term_id);
    for (const id of ['GLOSS-0012', 'GLOSS-0016', 'GLOSS-0019', 'GLOSS-0048', 'GLOSS-0049', 'GLOSS-0050']) expect(hits, id).toContain(id);
    // "vrijblijvende offerte" wins over the shorter "offerte"
    expect(hits).not.toContain('GLOSS-0047');
    const en = findGlossaryHits('Flygt and Xylem impellers with a mechanical seal.', 'en', cfg.glossary).map((h) => h.term_id);
    for (const id of ['GLOSS-0080', 'GLOSS-0082', 'GLOSS-0029', 'GLOSS-0032']) expect(en, id).toContain(id);
  });
});
