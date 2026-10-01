/**
 * The JSON documents sent to models as the user message (data), one shape per stage. Instructions live in the system prompt
 * (`prompts/*.v1.md`); the user message is data only, which keeps untrusted page text out of the instruction channel.
 * Every payload starts with `stage` so providers, mocks and logs can tell them apart.
 */
import type { BlockType, LocaleCode, MetaKind, Operation, PageType, Severity } from '../schemas/index.js';

export interface DocumentContext {
  title: string | null;
  h1: string | null;
  page_type: PageType;
}

export type MarketClaimAction = 'KEEP' | 'NEUTRALIZE' | 'REPLACE_WITH_FACT';

export interface MarketClaimPayload {
  source_phrase: string;
  action: MarketClaimAction;
  replacement_phrase: string | null;
}

export interface TranslateSegmentPayload {
  segment_id: string;
  block_type: BlockType;
  meta_kind: MetaKind | null;
  source_language: string;
  text: string;
  glossary_term_ids: string[];
}

export interface TranslatePayload {
  stage: 'translation';
  source_locale: string;
  target_locale: LocaleCode;
  operation: Operation;
  document: DocumentContext;
  segments: TranslateSegmentPayload[];
}

export interface LocalizeSegmentPayload {
  segment_id: string;
  block_type: BlockType;
  meta_kind: MetaKind | null;
  source_text: string;
  /** The translation (TRANSLATE_LOCALIZE) or the source text itself (ADAPT_ONLY). */
  input_text: string;
  glossary_term_ids: string[];
  market_claims: MarketClaimPayload[];
}

export interface LocalizePayload {
  stage: 'localization';
  source_locale: string;
  target_locale: LocaleCode;
  operation: Operation;
  document: DocumentContext;
  segments: LocalizeSegmentPayload[];
}

export interface JudgeSegmentPayload {
  segment_id: string;
  block_type: BlockType;
  meta_kind: MetaKind | null;
  source_text: string;
  target_text: string;
  changes: Array<{ from: string; to: string; rule: string }>;
  deterministic_findings: Array<{ rule: string; severity: Severity; target_span: string | null; note: string }>;
  back_translation: string | null;
  glossary_term_ids: string[];
  market_claims: MarketClaimPayload[];
}

export interface JudgePayload {
  stage: 'validation';
  source_locale: string;
  target_locale: LocaleCode;
  operation: Operation;
  document: DocumentContext;
  segments: JudgeSegmentPayload[];
}

export interface BackTranslatePayload {
  stage: 'backtranslation';
  target_locale: LocaleCode;
  back_translation_language: string;
  segments: Array<{ segment_id: string; text: string }>;
}

export interface RepairSpanPayload {
  span_id: string;
  /** Offsets into `current_text` (placeholders included). */
  start: number;
  end: number;
  text: string;
  findings: Array<{ rule: string; severity: Severity; explanation: string; suggested_fix: string | null }>;
}

export interface RepairSegmentPayload {
  segment_id: string;
  block_type: BlockType;
  source_text: string;
  current_text: string;
  spans: RepairSpanPayload[];
}

export interface RepairPayload {
  stage: 'repair';
  source_locale: string;
  target_locale: LocaleCode;
  segments: RepairSegmentPayload[];
}

export interface DetectPayload {
  stage: 'language_detection';
  candidates: string[];
  segments: Array<{ segment_id: string; text: string }>;
}

export type StagePayload = TranslatePayload | LocalizePayload | JudgePayload | BackTranslatePayload | RepairPayload | DetectPayload;
