/**
 * Shared primitives. Zod models in `src/schemas` are the single source of truth for every JSON shape
 * that crosses a boundary (LLM output, REST body, MCP tool input, report file) — ARCHITECTURE P7.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Locales & languages
// ---------------------------------------------------------------------------------------------

/** The seven locales that have a frozen profile in `config/locales/`. */
export const LOCALES = ['nl-NL', 'en-NL', 'en-GB', 'de-DE', 'de-AT', 'de-CH', 'it-IT'] as const;
export const LocaleCodeSchema = z.enum(LOCALES);
export type LocaleCode = z.infer<typeof LocaleCodeSchema>;

/** Content languages the engine understands. */
export const LANGUAGES = ['nl', 'en', 'de', 'it'] as const;
export const LanguageSchema = z.enum(LANGUAGES);
export type Language = z.infer<typeof LanguageSchema>;

/** `nl-NL` -> `nl`. Lower-cased. */
export function languageOf(locale: string): string {
  return (locale.split(/[-_]/)[0] ?? '').toLowerCase();
}

/** `nl-NL` -> `NL`; `en` -> undefined; `en-*` -> undefined. Upper-cased. */
export function regionOf(locale: string): string | undefined {
  const r = locale.split(/[-_]/)[1];
  return r && /^[A-Za-z]{2}$/.test(r) ? r.toUpperCase() : undefined;
}

/** A source locale may be a full locale (`nl-NL`, `en-GB`, `en-US`), a bare language (`en`) or a wildcard (`en-*`). */
export const SourceLocaleSchema = z
  .string()
  .regex(/^[a-z]{2,3}(?:-(?:[A-Za-z]{2}|\*))?$/, 'expected e.g. nl-NL, en-GB, en or en-*');

export function isKnownLocale(v: string): v is LocaleCode {
  return (LOCALES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------------------------
// Severity, verdicts, stages, operations
// ---------------------------------------------------------------------------------------------

export const SeveritySchema = z.enum(['minor', 'major', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

/** MQM-style penalty weights (spec §6.6). Overridable in `config/stages.yaml` (`scoring.weights`). */
export const SEVERITY_WEIGHT: Record<Severity, number> = { minor: 1, major: 5, critical: 25 };

export const VerdictSchema = z.enum(['PASS', 'PASS_WITH_NOTES', 'FAIL', 'HUMAN_REVIEW']);
export type Verdict = z.infer<typeof VerdictSchema>;

/** Worst-first ordering used when aggregating segment verdicts into a locale verdict. */
export const VERDICT_SEVERITY_ORDER: Verdict[] = ['FAIL', 'HUMAN_REVIEW', 'PASS_WITH_NOTES', 'PASS'];

export const STAGES = ['language_detection', 'translation', 'localization', 'validation', 'backtranslation', 'repair'] as const;
export const StageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof StageSchema>;

/**
 * What the pipeline does with one segment for one target locale.
 * - TRANSLATE_LOCALIZE: different language (default path)
 * - TRANSLATE_ONLY:     legal pages — never localise legal substance
 * - ADAPT_ONLY:         same language, different/unknown locale (e.g. en-* -> en-GB)
 * - SKIP_IDENTICAL:     source already in the target locale; deterministic checks only
 */
export const OperationSchema = z.enum(['TRANSLATE_LOCALIZE', 'TRANSLATE_ONLY', 'ADAPT_ONLY', 'SKIP_IDENTICAL']);
export type Operation = z.infer<typeof OperationSchema>;

export const PageTypeSchema = z.enum(['CONTENT', 'LEGAL']);
export type PageType = z.infer<typeof PageTypeSchema>;

export const RunStatusSchema = z.enum(['COMPLETE', 'HALTED_COST_CEILING', 'PARTIAL', 'FAILED']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

export const BLOCK_TYPES = ['heading', 'paragraph', 'list_item', 'table_cell', 'alt', 'meta', 'anchor'] as const;
export const BlockTypeSchema = z.enum(BLOCK_TYPES);
export type BlockType = z.infer<typeof BlockTypeSchema>;

export const META_KINDS = ['title', 'description', 'slug', 'keyword', 'og_title', 'og_description'] as const;
export const MetaKindSchema = z.enum(META_KINDS);
export type MetaKind = z.infer<typeof MetaKindSchema>;

// ---------------------------------------------------------------------------------------------
// Evidence tags (spec success criterion 5) — every finding carries one
// ---------------------------------------------------------------------------------------------

/** Matches `[EVIDENCE: DECH-SZ-01]`, `[EVIDENCE: p-003, DECH-SZ-01]` and `[HYPOTHESIS]` / `[HYPOTHESIS] — verify with counsel`. */
export const EVIDENCE_TAG_RE = /\[(?:EVIDENCE: [^\]]+|HYPOTHESIS[^\]]*)\]/;

export function hasEvidenceTag(text: string): boolean {
  return EVIDENCE_TAG_RE.test(text);
}

export function evidenceTag(ref: string | string[]): string {
  return `[EVIDENCE: ${Array.isArray(ref) ? ref.join(', ') : ref}]`;
}

export const HYPOTHESIS_TAG = '[HYPOTHESIS]';
export const HYPOTHESIS_COUNSEL_TAG = '[HYPOTHESIS] — verify with counsel';

/** A string that must contain an evidence tag. */
export const TaggedTextSchema = z.string().refine(hasEvidenceTag, {
  message: 'text must carry [EVIDENCE: <rule_id|segment_id>] or [HYPOTHESIS]',
});

// ---------------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------------

export const SpanSchema = z.object({ start: z.number().int().min(0), end: z.number().int().min(0) });
export type Span = z.infer<typeof SpanSchema>;

/** ISO-8601 timestamp string. */
export const TimestampSchema = z.string();
