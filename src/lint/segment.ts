/**
 * One segment as the rules see it: plain source and target text (placeholders removed) with the maps back to the
 * placeholder-bearing target, plus lazily extracted entities and market claims shared by the rules of one lint run.
 */
import { languageOf, type Rule, type RuleType, type Span } from '../schemas/index.js';
import { escapeLiteral, mapPlainSpan, plainTextWithMap, tokenizeInline, type PlainMap } from '../util/inline.js';
import { findMarketClaims } from './claims.js';
import { brandForms, extractEntities, type Entity } from './entities.js';
import type { LintContext, LintSegmentInput, MarketClaim } from './types.js';

export type RuleOf<T extends RuleType> = Extract<Rule, { type: T }>;

export class SegmentView {
  readonly src: PlainMap;
  readonly tgt: PlainMap;
  /** ISO 639-1 language of the source (falls back to the language of `source_locale`). */
  readonly sourceLang: string;
  private readonly memo = new Map<string, unknown>();

  constructor(
    readonly input: LintSegmentInput,
    readonly ctx: LintContext,
  ) {
    this.src = plainTextWithMap(input.source_text);
    this.tgt = plainTextWithMap(input.target_text);
    this.sourceLang = languageOf(input.source_lang || input.source_locale);
  }

  private cached<T>(key: string, make: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return this.memo.get(key) as T;
  }

  sourceEntities(): Entity[] {
    return this.cached('srcEntities', () => extractEntities(this.src.plain, { lang: this.sourceLang, common: this.ctx.common, brands: brandForms(this.ctx.glossary) }));
  }

  /** Target entities, numbers read with the TARGET language's convention. */
  targetEntities(): Entity[] {
    return this.cached('tgtEntities', () => extractEntities(this.tgt.plain, { lang: this.ctx.profile.language, common: this.ctx.common, brands: brandForms(this.ctx.glossary) }));
  }

  sourceClaims(): MarketClaim[] {
    return this.cached('srcClaims', () => findMarketClaims(this.src.plain, this.ctx.common));
  }

  targetClaims(): MarketClaim[] {
    return this.cached('tgtClaims', () => findMarketClaims(this.tgt.plain, this.ctx.common));
  }

  /** Span in the placeholder-bearing target for a plain-text range (never splits a placeholder pair). */
  span(start: number, end: number): Span {
    return mapPlainSpan(this.tgt, start, end);
  }

  wholeSpan(): Span {
    return { start: 0, end: this.input.target_text.length };
  }

  /** The replacement encoded for the placeholder-bearing text, or undefined when the span contains inline markup (unsafe to rewrite). */
  safeReplacement(span: Span, plainReplacement: string): string | undefined {
    const inside = this.input.target_text.slice(span.start, span.end);
    return tokenizeInline(inside).some((t) => t.kind !== 'text') ? undefined : escapeLiteral(plainReplacement);
  }
}
