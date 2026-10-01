/**
 * LLM "wire" schemas: the exact JSON each runtime prompt asks the model to return.
 *
 * Designed to be accepted by provider-native structured-output modes (OpenAI strict, Anthropic json_schema,
 * Gemini responseSchema): plain objects/arrays/strings/numbers/booleans/enums, EVERY field required, no optionals,
 * no unions, no records, no defaults. Numeric ranges are expressed in descriptions as well (adapters strip
 * keywords a provider does not support; Zod still enforces them after parsing).
 *
 * Top level is always `{ results: [...] }` so a batch can be answered item by item and partially re-requested.
 */
import { z } from 'zod';
import { SeveritySchema } from './common.js';

// -- translation ------------------------------------------------------------------------------------------------

export const TranslationWireItemSchema = z.object({
  segment_id: z.string().describe('Copy of the input segment_id.'),
  target_locale: z.string().describe('Copy of the requested target locale, e.g. "de-CH".'),
  translation: z.string().describe('The translation. Inline tags such as <a1>…</a1> are kept.'),
  entities_preserved: z
    .array(z.string())
    .describe('Every number (with its unit), product code, brand name, URL and e-mail you kept unchanged, exactly as written.'),
  terminology_applied: z
    .array(
      z.object({
        source: z.string().describe('Source term as it appears in the glossary hit.'),
        target: z.string().describe('Target term you used.'),
        rule: z.string().describe('The glossary term id, e.g. GLOSS-0012.'),
      }),
    )
    .describe('One entry per glossary hit you applied.'),
});
export const TranslateBatchWireSchema = z.object({ results: z.array(TranslationWireItemSchema) });
export type TranslationWireItem = z.infer<typeof TranslationWireItemSchema>;
export type TranslateBatchWire = z.infer<typeof TranslateBatchWireSchema>;

// -- localization -----------------------------------------------------------------------------------------------

export const ChangeWireSchema = z.object({
  from: z.string().describe('Exact text span in the input translation that you changed.'),
  to: z.string().describe('Replacement text; empty string when the span was removed.'),
  rule: z.string().describe('A rule id from the locale profile (e.g. DECH-LEX-OFFERTE) or INTEGRITY-MARKET-CLAIM.'),
  reason: z.string().describe('Why, ending with or containing [EVIDENCE: <rule id or fact>] or [HYPOTHESIS].'),
});
export const LocalizationWireItemSchema = z.object({
  segment_id: z.string(),
  target_locale: z.string(),
  localized_text: z.string().describe('The localized text. Inline tags are kept.'),
  changes: z.array(ChangeWireSchema).describe('Every change you made relative to the input translation. Empty if none.'),
  requires_human_review: z.boolean().describe('true if a business claim was neutralised or a business decision is needed.'),
});
export const LocalizeBatchWireSchema = z.object({ results: z.array(LocalizationWireItemSchema) });
export type LocalizationWireItem = z.infer<typeof LocalizationWireItemSchema>;
export type LocalizeBatchWire = z.infer<typeof LocalizeBatchWireSchema>;

// -- validation (LLM judge) -------------------------------------------------------------------------------------

export const JudgeScoresWireSchema = z.object({
  accuracy: z.number().describe('0-100'),
  fluency: z.number().describe('0-100'),
  terminology: z.number().describe('0-100'),
  locale_conventions: z.number().describe('0-100'),
  style_brand: z.number().describe('0-100'),
});
export const MqmErrorWireSchema = z.object({
  category: z.string().describe('MQM category like "accuracy/mistranslation", "accuracy/omission", "fluency/grammar", "terminology/inconsistent", "locale/convention", "style/register".'),
  severity: SeveritySchema,
  source_span: z.string().describe('Exact span of the source text, or "" if not applicable.'),
  target_span: z.string().describe('Exact span of the evaluated target text, or "" if the error is an omission.'),
  explanation: z.string().describe('Why this is an error. MUST contain [EVIDENCE: <rule id or segment id>] or [HYPOTHESIS].'),
  suggested_fix: z.string().describe('Concrete replacement or action.'),
});
export const JudgeWireItemSchema = z.object({
  segment_id: z.string(),
  target_locale: z.string(),
  scores: JudgeScoresWireSchema,
  mqm_errors: z.array(MqmErrorWireSchema),
  confidence: z.number().describe('0-1: how sure you are of this assessment.'),
  localization_recommendations: z
    .array(z.string())
    .describe('Market-level recommendations, each starting with [HYPOTHESIS] (or carrying an [EVIDENCE: …] tag).'),
});
export const JudgeBatchWireSchema = z.object({ results: z.array(JudgeWireItemSchema) });
export type JudgeWireItem = z.infer<typeof JudgeWireItemSchema>;
export type JudgeBatchWire = z.infer<typeof JudgeBatchWireSchema>;

// -- back-translation -------------------------------------------------------------------------------------------

export const BackTranslationWireItemSchema = z.object({
  segment_id: z.string(),
  target_locale: z.string(),
  back_translation: z.string().describe('Literal translation of the evaluated text into the requested back-translation language.'),
});
export const BackTranslateBatchWireSchema = z.object({ results: z.array(BackTranslationWireItemSchema) });
export type BackTranslateBatchWire = z.infer<typeof BackTranslateBatchWireSchema>;

// -- repair -----------------------------------------------------------------------------------------------------

export const RepairWireSpanSchema = z.object({
  span_id: z.string().describe('Copy of the input span_id.'),
  replacement: z.string().describe('Text that replaces the span. Empty string deletes it. Inline tags inside the span must be kept.'),
  rule: z.string().describe('The rule id (or MQM category) of the finding you fixed.'),
  reason: z.string().describe('What you changed and why, with [EVIDENCE: …] or [HYPOTHESIS].'),
});
export const RepairWireItemSchema = z.object({
  segment_id: z.string(),
  repairs: z.array(RepairWireSpanSchema),
});
export const RepairBatchWireSchema = z.object({ results: z.array(RepairWireItemSchema) });
export type RepairBatchWire = z.infer<typeof RepairBatchWireSchema>;

// -- language detection (LLM fallback) --------------------------------------------------------------------------

export const LangDetectWireItemSchema = z.object({
  segment_id: z.string(),
  lang: z.enum(['nl', 'en', 'de', 'it', 'fr', 'es', 'other', 'und']).describe('und = cannot tell (names, codes).'),
  confidence: z.number().describe('0-1'),
});
export const LangDetectBatchWireSchema = z.object({ results: z.array(LangDetectWireItemSchema) });
export type LangDetectBatchWire = z.infer<typeof LangDetectBatchWireSchema>;
