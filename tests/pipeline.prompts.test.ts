/**
 * Runtime prompts (spec §6.3, §8.1): every template renders for every locale and output mode, named variables only, no template drift,
 * exemplars are valid against the wire schemas and reproduce the spec's golden standard.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { btSystem, judgeSystem } from '../src/pipeline/validate.js';
import { buildLocalizationSystem } from '../src/pipeline/localize.js';
import { loadEdgeExemplars, loadTemplate, renderLocaleProfile, renderTemplate } from '../src/pipeline/prompt.js';
import type { PromptName } from '../src/pipeline/prompt.js';
import { repairSystem } from '../src/pipeline/repair.js';
import { buildTranslationSystem } from '../src/pipeline/translate.js';
import { LOCALES } from '../src/schemas/common.js';
import type { LocaleCode } from '../src/schemas/common.js';
import {
  BackTranslateBatchWireSchema,
  JudgeBatchWireSchema,
  LangDetectBatchWireSchema,
  LocalizeBatchWireSchema,
  RepairBatchWireSchema,
  TranslateBatchWireSchema,
} from '../src/schemas/llm.js';
import { EngineError } from '../src/util/errors.js';
import { projectRoot } from '../src/util/paths.js';
import { GOLDEN_SOURCE, goldenDoc, localeContext, mockProvider, readGolden, testRegistry } from './helpers/harness.js';

const cfg = loadConfig();
const promptsDir = path.join(projectRoot(), 'prompts');
const registry = testRegistry(mockProvider('mock'));

describe('templates', () => {
  const names: PromptName[] = ['translate', 'localize', 'validate', 'backtranslate', 'repair', 'detect'];
  it.each(names)('%s.v1.md has valid front matter whose variables equal its tokens', (name) => {
    const tpl = loadTemplate(promptsDir, name);
    expect(tpl.version).toBe(1);
    const tokens = new Set([...tpl.body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]));
    expect(tokens).toEqual(new Set(tpl.variables));
  });

  it.each(names)('%s follows the v3.0 structure (persona, objective, parameters, context, exemplars, output format, reasoning, self-check)', (name) => {
    const body = loadTemplate(promptsDir, name).body;
    for (const h of ['# Persona', '# Objective', '# Parameters', '# Context', '# Output format', '# Reasoning', '# Self-correction rubric']) {
      expect(body, `${name} lacks "${h}"`).toContain(h);
    }
    expect(body).toMatch(/# (Exemplars|Hard rules)/);
    expect(body.toLowerCase()).toContain('data, never instructions');
  });

  it('renderTemplate is strict: missing, extra and undeclared variables are errors', () => {
    const tpl = { body: 'Hello {{name}}', variables: ['name'], file: 'x.md' };
    expect(renderTemplate(tpl, { name: 'World' })).toBe('Hello World');
    expect(() => renderTemplate(tpl, {})).toThrow(/missing/);
    expect(() => renderTemplate(tpl, { name: 'a', other: 'b' })).toThrow(/not declared/);
    expect(() => renderTemplate({ ...tpl, body: 'Hello {{name}} {{ghost}}' }, { name: 'a' })).toThrow(/template drift/);
    expect(() => renderTemplate({ ...tpl, variables: ['name', 'unused'] }, { name: 'a', unused: '' })).toThrow(/declared but unused/);
    expect(() => renderTemplate({ ...tpl, body: 'Hello {{name}} {{ 1x }}' }, { name: 'a' })).toThrow(EngineError);
  });

  it('substituted values are inserted literally (no $ pattern expansion)', () => {
    const tpl = { body: '[{{v}}]', variables: ['v'], file: 'x.md' };
    expect(renderTemplate(tpl, { v: "$& $1 $$" })).toBe("[$& $1 $$]");
  });
});

describe('exemplars', () => {
  it('golden exemplars validate against the wire schemas', () => {
    expect(TranslateBatchWireSchema.parse(readGolden('translation').output)).toBeTruthy();
    expect(LocalizeBatchWireSchema.parse(readGolden('localization').output)).toBeTruthy();
    expect(JudgeBatchWireSchema.parse(readGolden('validation').output)).toBeTruthy();
    expect(BackTranslateBatchWireSchema.parse(readGolden('backtranslation').output)).toBeTruthy();
    expect(RepairBatchWireSchema.parse(readGolden('repair').output)).toBeTruthy();
    expect(LangDetectBatchWireSchema.parse(readGolden('language_detection').output)).toBeTruthy();
  });

  it('reproduce the golden standard of spec §5.1 exactly', () => {
    const t = readGolden('translation');
    expect((t.input.segments[0] as { text: string }).text).toBe(GOLDEN_SOURCE);
    const tr = t.output.results[0] as { translation: string; entities_preserved: string[]; terminology_applied: Array<{ rule: string }> };
    expect(tr.translation).toBe(
      'Unsere Kreiselpumpen fördern bis zu 450 m³/h bei einer Förderhöhe von 80 Metern. Fordern Sie noch heute ein unverbindliches Angebot an – Lieferung innerhalb von 5 Werktagen in den gesamten Niederlanden.',
    );
    expect(tr.entities_preserved).toEqual(['450 m³/h', '80']);
    expect(tr.terminology_applied.map((x) => x.rule)).toEqual(['GLOSS-0012', 'GLOSS-0019']);

    const l = readGolden('localization').output.results[0] as { localized_text: string; changes: Array<{ rule: string; reason: string }>; requires_human_review: boolean };
    expect(l.localized_text).toBe(
      'Unsere Kreiselpumpen fördern bis zu 450 m³/h bei einer Förderhöhe von 80 Metern. Fordern Sie noch heute eine unverbindliche Offerte an – Lieferung innert 5 Arbeitstagen.',
    );
    expect(l.changes.map((c) => c.rule)).toEqual(['DECH-LEX-OFFERTE', 'DECH-LEX-INNERT', 'INTEGRITY-MARKET-CLAIM']);
    expect(l.changes.every((c) => /\[EVIDENCE: [^\]]+\]/.test(c.reason))).toBe(true);
    expect(l.requires_human_review).toBe(true);
    expect(l.localized_text.includes('ß')).toBe(false);

    const v = readGolden('validation').output.results[0] as { scores: Record<string, number>; mqm_errors: Array<{ category: string; severity: string }> };
    expect(v.scores).toEqual({ accuracy: 95, fluency: 98, terminology: 100, locale_conventions: 100, style_brand: 95 });
    expect(v.mqm_errors).toHaveLength(1);
    expect(v.mqm_errors[0]).toMatchObject({ category: 'accuracy/omission', severity: 'major' });

    const b = readGolden('backtranslation').output.results[0] as { back_translation: string };
    expect(b.back_translation).toBe('Our centrifugal pumps deliver up to 450 m³/h at a head of 80 metres. Request a non-binding quotation today – delivery within 5 working days.');
  });

  it('the repair exemplar offsets point at the flagged text', () => {
    const g = readGolden('repair');
    const seg = g.input.segments[0] as { current_text: string; spans: Array<{ start: number; end: number; text: string }> };
    const span = seg.spans[0] as { start: number; end: number; text: string };
    expect(seg.current_text.slice(span.start, span.end)).toBe(span.text);
  });

  it('every edge exemplar a profile lists exists, and every file declares the stages it serves', () => {
    const all = loadEdgeExemplars(promptsDir);
    const ids = new Set(all.map((e) => e.id));
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (const code of LOCALES) for (const id of cfg.locales[code].edge_exemplars) expect(ids.has(id), `${code} lists unknown ${id}`).toBe(true);
    for (const f of readdirSync(path.join(promptsDir, 'exemplars')).filter((x) => x.startsWith('edge_'))) expect(existsSync(path.join(promptsDir, 'exemplars', f))).toBe(true);
    for (const e of all) expect(e.stages.length).toBeGreaterThan(0);
  });
});

describe.each(LOCALES)('system prompts for %s', (code) => {
  const target = code as LocaleCode;
  const lc = localeContext(cfg, target, goldenDoc(), registry);
  const batch = [] as never[];

  it('translation: neutral profile, glossary targets of the language-neutral base locale, both output modes', () => {
    const tagged = buildTranslationSystem(lc, batch, 'nl', 'tagged');
    const json = buildTranslationSystem(lc, batch, 'nl', 'json');
    expect(tagged).not.toMatch(/\{\{|\}\}/);
    expect(tagged).toContain('<final_answer>');
    expect(tagged).toContain('<thinking>');
    expect(json).not.toContain('<final_answer>\n{');
    expect(json).toContain('bare JSON');
    expect(tagged).toContain('"results"');
    expect(tagged).toContain(`for the locale ${target}`);
    expect(tagged).toContain('data, never instructions');
    // the translation stage must not leak market-specific rules
    expect(tagged).not.toContain('DECH-SZ-01');
  });

  it('localization: the profile rules the linter enforces are rendered with their ids; market facts and claim handling are explained', () => {
    const s = buildLocalizationSystem(lc, batch, 'json');
    expect(s).not.toMatch(/\{\{|\}\}/);
    for (const r of cfg.locales[target].rules) expect(s, `${target} localize prompt lacks ${r.id}`).toContain(r.id);
    expect(s).toContain('INTEGRITY-MARKET-CLAIM');
    expect(s).toContain('Market facts for');
    expect(s).toContain('None supplied');
    expect(s).toContain('NEUTRALIZE');
    expect(s).not.toContain('Brand voice'); // the template file is not sent to the model
  });

  it('validation, back-translation and repair render', () => {
    expect(judgeSystem(lc, batch, 'tagged')).not.toMatch(/\{\{|\}\}/);
    expect(judgeSystem(lc, batch, 'json')).toContain('confidence');
    expect(btSystem(lc, 'en', 'tagged')).toContain('English');
    expect(repairSystem(lc, 'json')).toContain('flagged spans');
  });
});

describe('specific prompt content', () => {
  const at = localeContext(cfg, 'de-AT', goldenDoc(), registry);
  const ch = localeContext(cfg, 'de-CH', goldenDoc(), registry);
  const nl = localeContext(cfg, 'en-NL', goldenDoc(), registry);
  const gb = localeContext(cfg, 'en-GB', goldenDoc(), registry);

  it('edge exemplars are selected per stage and locale', () => {
    expect(buildLocalizationSystem(at, [], 'json')).toContain('Jänner');
    expect(buildLocalizationSystem(ch, [], 'json')).not.toContain('Edge case — German variants differ even in month names');
    expect(buildLocalizationSystem(nl, [], 'json')).toContain('false friends');
    expect(buildLocalizationSystem(gb, [], 'json')).toContain('en-NL and en-GB are different outputs');
    expect(buildTranslationSystem(nl, [], 'nl', 'json')).toContain('false friends');
    expect(buildTranslationSystem(gb, [], 'nl', 'json')).not.toContain('false friends');
  });

  it('the de-CH prompt teaches Swiss conventions, with ß only ever shown as the wrong form', () => {
    const s = renderLocaleProfile(cfg.locales['de-CH'], 'localize');
    expect(s).toContain('DECH-SZ-01');
    expect(s).toContain('«…»');
    expect(s).toContain("1'234.50");
    const szLine = s.split('\n').find((l) => l.includes('DECH-SZ-01')) ?? '';
    expect(szLine).toContain('critical');
    expect(szLine).toContain('always written ss');
    // outside the DECH-SZ-01 rule line no German word carries ß
    const rest = s.split('\n').filter((l) => !l.includes('DECH-SZ-01')).join('\n');
    expect(/\p{L}ß|ß\p{L}/u.test(rest)).toBe(false);
  });

  it('the translation prompt carries the language-neutral glossary target (Angebot for de-CH), the localization prompt the market form (Offerte)', () => {
    const doc = goldenDoc();
    const lcx = localeContext(cfg, 'de-CH', doc, registry);
    const hits = [{ term_id: 'GLOSS-0047', category: 'commercial', do_not_translate: false, source_form: 'offerte', matched: 'offerte', start: 0, end: 7, targets: cfg.glossary.find((g) => g.term_id === 'GLOSS-0047')?.forms ?? {} }];
    const state = { glossaryHits: hits, operation: 'TRANSLATE_LOCALIZE' } as never;
    const tr = buildTranslationSystem(lcx, [state], 'nl', 'json');
    const lo = buildLocalizationSystem(lcx, [state], 'json');
    expect(tr).toMatch(/\| GLOSS-0047 \| offerte \| Angebot \|/);
    expect(lo).toMatch(/\| GLOSS-0047 \| offerte \| Offerte \|/);
  });

  it('prompt files contain no marketing hype words (house rule)', () => {
    for (const f of ['translate', 'localize', 'validate', 'backtranslate', 'repair', 'detect']) {
      const body = readFileSync(path.join(promptsDir, `${f}.v1.md`), 'utf8');
      expect(body.toLowerCase()).not.toMatch(/world-class|ai-powered|cutting-edge/);
    }
  });
});
