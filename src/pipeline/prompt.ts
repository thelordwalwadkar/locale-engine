/**
 * Runtime prompt assembly. Templates in `prompts/*.v1.md` are rendered with NAMED VARIABLES ONLY (no string concatenation in stage
 * code): a variable that the template does not declare, or a declared one that is not supplied, is an error, so prompt drift is caught
 * by tests instead of in production. The locale rules shown to the model are the very rules the linter enforces (ARCHITECTURE P5).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ZodType } from 'zod';
import type { GlossaryPromptEntry } from '../config/glossary.js';
import type { LoadedConfig } from '../config/load.js';
import { languageOf } from '../schemas/common.js';
import type { LocaleCode, Stage } from '../schemas/common.js';
import type { MarketFacts, StructuredOutputMode } from '../schemas/config.js';
import type { ResolvedLocaleProfile, Rule } from '../schemas/locale.js';
import { EngineError } from '../util/errors.js';

// ---------------------------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------------------------

export type PromptName = 'translate' | 'localize' | 'validate' | 'backtranslate' | 'repair' | 'detect';

export interface PromptTemplate {
  name: PromptName;
  version: number;
  stage: Stage;
  variables: string[];
  body: string;
  file: string;
}

const TOKEN = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g;
const templateCache = new Map<string, PromptTemplate>();

function splitFrontMatter(raw: string, file: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new EngineError('CONFIG_INVALID', `${file}: missing YAML front matter`);
  const meta = parseYaml(m[1] ?? '') as Record<string, unknown> | null;
  return { meta: meta ?? {}, body: m[2] ?? '' };
}

export function loadTemplate(promptsDir: string, name: PromptName, version = 1): PromptTemplate {
  const file = path.join(promptsDir, `${name}.v${version}.md`);
  const cached = templateCache.get(file);
  if (cached) return cached;
  if (!existsSync(file)) throw new EngineError('CONFIG_INVALID', `prompt template not found: ${file}`);
  const { meta, body } = splitFrontMatter(readFileSync(file, 'utf8'), file);
  const parsed = z
    .object({ name: z.literal(name), version: z.literal(version), stage: z.string(), variables: z.array(z.string()) })
    .safeParse(meta);
  if (!parsed.success) throw new EngineError('CONFIG_INVALID', `${file}: invalid front matter: ${parsed.error.message}`);
  const tpl: PromptTemplate = { name, version, stage: parsed.data.stage as Stage, variables: parsed.data.variables, body, file };
  templateCache.set(file, tpl);
  return tpl;
}

/** Render with named variables. Throws on any mismatch between the template's tokens, its declared variables and the supplied values. */
export function renderTemplate(tpl: Pick<PromptTemplate, 'body' | 'variables' | 'file'>, vars: Record<string, string>): string {
  const used = new Set<string>();
  for (const m of tpl.body.matchAll(TOKEN)) used.add(m[1] as string);
  const stray = tpl.body.replace(TOKEN, '').includes('{{');
  if (stray) throw new EngineError('CONFIG_INVALID', `${tpl.file}: contains "{{" that is not a valid {{variable}} token`);
  const declared = new Set(tpl.variables);
  const undeclared = [...used].filter((v) => !declared.has(v));
  const unused = [...declared].filter((v) => !used.has(v));
  if (undeclared.length || unused.length) {
    throw new EngineError('CONFIG_INVALID', `${tpl.file}: template drift — tokens not declared: [${undeclared.join(', ')}]; declared but unused: [${unused.join(', ')}]`);
  }
  const missing = [...declared].filter((v) => !(v in vars));
  const extra = Object.keys(vars).filter((v) => !declared.has(v));
  if (missing.length || extra.length) {
    throw new EngineError('INTERNAL', `${tpl.file}: variables mismatch — missing: [${missing.join(', ')}]; not declared: [${extra.join(', ')}]`);
  }
  return tpl.body.replace(TOKEN, (_all, name: string) => vars[name] as string).trim();
}

// ---------------------------------------------------------------------------------------------------------------
// Output contract (tagged vs JSON-only) and schema text
// ---------------------------------------------------------------------------------------------------------------

export type OutputMode = 'tagged' | 'json';

/** `native` and `json_mode` models answer with bare JSON; `prompted` models think inside <thinking> and answer inside <final_answer>. */
export function outputModeFor(structured: StructuredOutputMode): OutputMode {
  return structured === 'prompted' ? 'tagged' : 'json';
}

export function schemaText(schema: ZodType): string {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  delete js['$schema'];
  return JSON.stringify(js, null, 2);
}

export function renderOutputContract(promptsDir: string, mode: OutputMode, schema: ZodType): string {
  const file = path.join(promptsDir, '_fragments', mode === 'tagged' ? 'output-tagged.md' : 'output-json.md');
  if (!existsSync(file)) throw new EngineError('CONFIG_INVALID', `prompt fragment not found: ${file}`);
  return renderTemplate({ body: readFileSync(file, 'utf8'), variables: ['output_schema'], file }, { output_schema: schemaText(schema) });
}

// ---------------------------------------------------------------------------------------------------------------
// Exemplars
// ---------------------------------------------------------------------------------------------------------------

export interface GoldenExemplar {
  title: string;
  glossary_shown: string[];
  input: unknown;
  thinking: string;
  output: unknown;
}

export type GoldenName = 'translation' | 'localization' | 'validation' | 'backtranslation' | 'repair' | 'language_detection';

export function loadGolden(promptsDir: string, name: GoldenName): GoldenExemplar {
  const file = path.join(promptsDir, 'exemplars', `golden.${name}.json`);
  if (!existsSync(file)) throw new EngineError('CONFIG_INVALID', `golden exemplar not found: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8')) as GoldenExemplar;
}

export function renderGolden(g: GoldenExemplar, mode: OutputMode): string {
  const input = JSON.stringify(g.input, null, 2);
  const output = JSON.stringify(g.output, null, 2);
  const glossary = g.glossary_shown.length ? `Glossary hits in this example: ${g.glossary_shown.join('; ')}.\n\n` : '';
  const answer =
    mode === 'tagged'
      ? `<thinking>\n${g.thinking}\n</thinking>\n<final_answer>\n${output}\n</final_answer>`
      : `\`\`\`json\n${output}\n\`\`\``;
  return `## Golden standard\n${g.title}\n\n${glossary}User message:\n\`\`\`json\n${input}\n\`\`\`\n\nExpected answer${mode === 'json' ? ' (bare JSON, no tags)' : ''}:\n${answer}`;
}

export interface EdgeExemplar {
  id: string;
  stages: Stage[];
  body: string;
}

export function loadEdgeExemplars(promptsDir: string): EdgeExemplar[] {
  const dir = path.join(promptsDir, 'exemplars');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^edge_[a-z_]+\.md$/.test(f))
    .sort()
    .map((f) => {
      const file = path.join(dir, f);
      const { meta, body } = splitFrontMatter(readFileSync(file, 'utf8'), file);
      const parsed = z.object({ id: z.string(), stages: z.array(z.string()) }).parse(meta);
      return { id: parsed.id, stages: parsed.stages as Stage[], body: body.trim() };
    });
}

/** Edge exemplars relevant to this stage AND listed in the target locale's profile. */
export function renderEdgeExemplars(all: EdgeExemplar[], stage: Stage, profile: ResolvedLocaleProfile): string {
  const wanted = new Set(profile.edge_exemplars);
  const picked = all.filter((e) => wanted.has(e.id) && e.stages.includes(stage));
  if (!picked.length) return '';
  return `## Edge cases for ${profile.locale}\n\n${picked.map((e) => e.body).join('\n\n')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Context sections
// ---------------------------------------------------------------------------------------------------------------

const LANGUAGE_NAMES: Record<string, string> = { nl: 'Dutch', en: 'English', de: 'German', it: 'Italian', fr: 'French', es: 'Spanish' };

export function languageName(code: string): string {
  return LANGUAGE_NAMES[languageOf(code)] ?? code;
}

export type ProfileView = 'translate' | 'localize' | 'validate' | 'repair';

/** Common rules that matter to localization even though they live in `_common.yaml`. */
const COMMON_RULES_SHOWN = new Set(['INTEGRITY-MARKET-CLAIM', 'SEO-TITLE-LEN', 'SEO-META-LEN', 'SEO-SLUG-01']);

function clip(s: string, n = 110): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** One wrong → right pair derived from the rule's own tests. */
function ruleExample(rule: Rule): string | null {
  const fail = rule.tests.find((t) => t.expect === 'fail');
  const pass = rule.tests.find((t) => t.expect === 'pass');
  if (!fail) return null;
  const right = fail.fixed ?? pass?.target;
  if (right === undefined) return `e.g. wrong: “${clip(fail.target)}”`;
  const src = fail.source ? `(source: “${clip(fail.source, 70)}”) ` : '';
  return `e.g. ${src}wrong: “${clip(fail.target)}” → right: “${clip(right)}”`;
}

export function renderLocaleProfile(profile: ResolvedLocaleProfile, view: ProfileView): string {
  const f = profile.formatting;
  if (view === 'translate') {
    return [
      `## Target language`,
      `- Translate into standard ${languageName(profile.language)} as written for ${profile.display_name}: neutral, correct and faithful.`,
      `- Vocabulary variants, spelling variants, number / currency / date formats and quotation marks of the market are applied by the next stage (localization) and by a program — do not apply them now.`,
      `- Formal register for B2B copy.`,
    ].join('\n');
  }
  const lines: string[] = [];
  lines.push(`## Locale profile: ${profile.locale} — ${profile.display_name}`);
  lines.push(`Audience: ${profile.audience_label}. ${profile.description.replace(/\s+/g, ' ').trim()}`);
  lines.push('');
  lines.push(`### Conventions${view === 'localize' ? ' (a program applies these to numbers after you; shown so you understand the target — do not reformat numbers yourself)' : ''}`);
  lines.push(`- Numbers: decimal "${f.number.decimal}", thousands "${f.number.thousands}" — e.g. ${f.number.example}`);
  lines.push(`- Currency: symbol ${f.currency.position} the number — e.g. ${f.currency.example.replace(/ /g, ' ')}`);
  lines.push(`- Dates: ${f.date.numeric} — written: ${f.date.textual_example}`);
  lines.push(`- Quotation marks: ${f.quotes.open}…${f.quotes.close} (inner ${f.quotes.open_inner}…${f.quotes.close_inner})`);
  if (profile.prompt_notes.length) {
    lines.push('');
    lines.push('### Style notes');
    for (const n of profile.prompt_notes) lines.push(`- ${n}`);
  }
  // Match by id: rules that use a shared lexicon were resolved into new objects when the profile was loaded.
  const localIds = new Set(profile.rules.map((r) => r.id));
  const shown = profile.effective_rules.filter((r) => localIds.has(r.id) || COMMON_RULES_SHOWN.has(r.id));
  lines.push('');
  lines.push(`### Rules the output is checked against automatically (id · severity)`);
  for (const r of shown) {
    const ex = view === 'repair' || view === 'validate' ? null : ruleExample(r);
    const fix = r.fix && view !== 'validate' ? ` Fix: ${r.fix}` : '';
    lines.push(`- **${r.id}** · ${r.severity} — ${r.message}${fix}${ex ? ` (${ex})` : ''}`);
  }
  return lines.join('\n');
}

export function renderGlossaryHits(entries: GlossaryPromptEntry[], target: LocaleCode, view: 'translate' | 'other'): string {
  const heading = view === 'translate' ? `## Glossary hits (approved ${languageName(languageOf(target))} terms)` : `## Glossary hits (approved terms for ${target})`;
  if (!entries.length) return `${heading}\nNone of the glossary terms occur in these segments.`;
  const dnt = entries.filter((e) => e.do_not_translate);
  const terms = entries.filter((e) => !e.do_not_translate);
  const lines = [heading];
  if (terms.length) {
    lines.push('| id | source term | use | also acceptable | note |', '|---|---|---|---|---|');
    for (const e of terms) {
      const alt = e.target_variants.slice(1).join(', ');
      lines.push(`| ${e.term_id} | ${e.source} | ${e.target} | ${alt} | ${e.notes ?? ''} |`);
    }
  }
  if (dnt.length) lines.push(`Do not translate, keep exactly as written: ${dnt.map((e) => e.source).join(', ')}.`);
  return lines.join('\n');
}

export function renderMarketFacts(facts: MarketFacts | undefined, locale: LocaleCode): string {
  const heading = `## Market facts for ${locale} (the ONLY business facts you may use)`;
  const entries = Object.entries(facts ?? {}).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0));
  if (!entries.length) {
    return `${heading}\nNone supplied. Do not state delivery areas, lead times, phone numbers, e-mail addresses, prices, currencies or certifications for this market.`;
  }
  return [heading, ...entries.map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)].join('\n');
}

export function renderBrandVoice(text: string): string {
  const t = text.trim();
  if (!t || t.startsWith('<!-- locale-engine:template -->')) return '';
  return `## Brand voice\n${t}`;
}

/** Everything the loaders need once per run. */
export interface PromptKit {
  promptsDir: string;
  edge: EdgeExemplar[];
  brandVoice: string;
}

export function createPromptKit(config: Pick<LoadedConfig, 'promptsDir' | 'brandVoice'>): PromptKit {
  return { promptsDir: config.promptsDir, edge: loadEdgeExemplars(config.promptsDir), brandVoice: renderBrandVoice(config.brandVoice) };
}
