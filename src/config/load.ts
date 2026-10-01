/**
 * Loads and cross-validates everything in `config/` (frozen after Phase 1; later phases only READ it).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodType } from 'zod';
import { LOCALES, type LocaleCode } from '../schemas/common.js';
import {
  MarketFactsFileSchema,
  ProvidersConfigSchema,
  StagesConfigSchema,
  type Glossary,
  type MarketFactsFile,
  type ProvidersConfig,
  type StagesConfig,
} from '../schemas/config.js';
import {
  CommonConfigSchema,
  LocaleProfileSchema,
  type CommonConfig,
  type ResolvedLocaleProfile,
  type Rule,
} from '../schemas/locale.js';
import { EngineError } from '../util/errors.js';
import { configDir as resolveConfigDir, promptsDir as resolvePromptsDir } from '../util/paths.js';
import { loadGlossary } from './glossary.js';

export interface LoadedConfig {
  configDir: string;
  promptsDir: string;
  stages: StagesConfig;
  providers: ProvidersConfig;
  common: CommonConfig;
  locales: Record<LocaleCode, ResolvedLocaleProfile>;
  glossary: Glossary;
  marketFacts: MarketFactsFile;
  brandVoice: string;
}

export interface LoadOptions {
  configDir?: string;
  promptsDir?: string;
}

function readYaml<T>(file: string, schema: ZodType<T>): T {
  if (!existsSync(file)) throw new EngineError('CONFIG_INVALID', `config file not found: ${file}`);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new EngineError('CONFIG_INVALID', `${file}: YAML syntax error: ${(e as Error).message}`);
  }
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const lines = parsed.error.issues.slice(0, 12).map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new EngineError('CONFIG_INVALID', `${file} is invalid:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

/** Resolve `lexicon_ref`s and prepend the common rules; enforce rule-id uniqueness and one `format` rule per aspect. */
export function resolveProfile(profileIn: import('../schemas/locale.js').LocaleProfile, common: CommonConfig): ResolvedLocaleProfile {
  const resolveRule = (rule: Rule): Rule => {
    if (rule.type !== 'lexicon' || !rule.lexicon_ref) return rule;
    const shared = common.lexicons[rule.lexicon_ref];
    if (!shared) {
      throw new EngineError('CONFIG_INVALID', `rule ${rule.id}: lexicon_ref "${rule.lexicon_ref}" is not defined in _common.yaml -> lexicons`);
    }
    return { ...rule, terms: [...shared, ...rule.terms] };
  };
  const effective = [...common.rules, ...profileIn.rules].map(resolveRule);

  const ids = new Set<string>();
  for (const r of effective) {
    if (ids.has(r.id)) throw new EngineError('CONFIG_INVALID', `${profileIn.locale}: duplicate rule id ${r.id}`);
    ids.add(r.id);
    if (r.type === 'lexicon' && r.autofix && r.terms.some((t) => t.prefer === undefined)) {
      throw new EngineError('CONFIG_INVALID', `${profileIn.locale}: rule ${r.id} has autofix: true but a term without "prefer"`);
    }
  }
  for (const aspect of ['number', 'currency', 'date'] as const) {
    const n = effective.filter((r) => r.type === 'format' && r.aspect === aspect).length;
    if (n !== 1) {
      throw new EngineError('CONFIG_INVALID', `${profileIn.locale}: expected exactly one format rule with aspect "${aspect}", found ${n}`);
    }
  }
  return { ...profileIn, effective_rules: effective };
}

export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
  const dir = resolveConfigDir(opts.configDir);
  const prompts = resolvePromptsDir(opts.promptsDir);

  const stages = readYaml(path.join(dir, 'stages.yaml'), StagesConfigSchema);
  const providers = readYaml(path.join(dir, 'providers.yaml'), ProvidersConfigSchema);
  const common = readYaml(path.join(dir, 'locales', '_common.yaml'), CommonConfigSchema);

  const locales = {} as Record<LocaleCode, ResolvedLocaleProfile>;
  for (const code of LOCALES) {
    const profile = readYaml(path.join(dir, 'locales', `${code}.yaml`), LocaleProfileSchema);
    if (profile.locale !== code) {
      throw new EngineError('CONFIG_INVALID', `${code}.yaml declares locale "${profile.locale}"`);
    }
    locales[code] = resolveProfile(profile, common);
  }

  const glossary = loadGlossary(path.join(dir, 'glossary.csv'));
  const marketFacts = readYaml(path.join(dir, 'market_facts.yaml'), MarketFactsFileSchema);
  const brandVoicePath = path.join(dir, 'brand_voice.md');
  const brandVoice = existsSync(brandVoicePath) ? readFileSync(brandVoicePath, 'utf8') : '';

  return { configDir: dir, promptsDir: prompts, stages, providers, common, locales, glossary, marketFacts, brandVoice };
}
