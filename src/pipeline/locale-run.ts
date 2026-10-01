/** Everything that happens for ONE target locale: route → translate → localize → format → validate → repair → assemble. */
import { findGlossaryHits } from '../config/glossary.js';
import { findMarketClaims, normalizeFormats } from '../lint/index.js';
import type { LintContext, MarketClaim } from '../lint/types.js';
import { regionOf } from '../schemas/common.js';
import type { LocaleCode, Operation, Stage } from '../schemas/common.js';
import type { Change, FormatChange } from '../schemas/findings.js';
import type { LocaleResult, SegmentResult, SourceDocument, StageBinding } from '../schemas/index.js';
import { plainText } from '../util/inline.js';
import { slugify } from '../util/slug.js';
import { aggregateLocale, assignFindingIds, buildSegmentResult, usageOfLocale } from './finalize.js';
import type { MarketClaimPayload } from './payloads.js';
import { runLocalization } from './localize.js';
import { buildRecommendations } from './recommendations.js';
import { runRepair } from './repair.js';
import { decideOperation, localeOfSegment } from './route.js';
import { buildSeoMeta } from './seo.js';
import type { LocaleContext, RunContext, SegState } from './state.js';
import { runTranslation } from './translate.js';
import { validateStates } from './validate.js';

export interface PriorSegment {
  translation: string | null;
}

/** Texts that already exist (validate mode: a page.json from an earlier run, or a source/target pair). */
export interface ExistingSegment {
  text: string | null;
  translation: string | null;
  localized: string | null;
  changes: Change[];
  formatChanges: FormatChange[];
  status: SegState['status'];
}

export interface LocaleRunOptions {
  /** Translations from a previous `translate` run (page.json input of `localize`). */
  prior?: Map<string, PriorSegment>;
  /** Final texts to validate instead of producing new ones; the operation is still decided by the routing rules. */
  existing?: Map<string, ExistingSegment>;
  /** The texts are already final: skip format normalisation and slug shaping. */
  skipPostProcess?: boolean;
}

function claimAction(lc: LocaleContext, claim: MarketClaim, sourceRegion: string | undefined): MarketClaimPayload {
  const covered = claim.country !== null ? claim.regions.includes(lc.profile.region) : sourceRegion !== undefined && sourceRegion === lc.profile.region;
  if (covered) return { source_phrase: claim.phrase, action: 'KEEP', replacement_phrase: null };
  if (lc.facts?.delivery) return { source_phrase: claim.phrase, action: 'REPLACE_WITH_FACT', replacement_phrase: lc.facts.delivery };
  return { source_phrase: claim.phrase, action: 'NEUTRALIZE', replacement_phrase: null };
}

export function buildStates(lc: LocaleContext, opts: LocaleRunOptions = {}): SegState[] {
  const { doc, target, pageType } = lc;
  const glossary = lc.run.config.glossary;
  const sourceRegion = regionOf(doc.source_locale);
  return doc.segments.map((seg): SegState => {
    const detected = seg.lang && seg.lang.lang !== 'und' ? seg.lang : undefined;
    const lang = detected?.lang ?? doc.source_language;
    const segmentLocale = localeOfSegment(lang, doc.source_locale);
    const operation: Operation = decideOperation(lang, segmentLocale, target, pageType);
    const plain = plainText(seg.text);
    const claims = seg.translatable ? findMarketClaims(plain, lc.run.config.common) : [];
    const s: SegState = {
      seg,
      lang,
      langConfidence: detected?.confidence ?? seg.lang?.confidence ?? 0,
      segmentLocale,
      operation,
      status: 'OK',
      translation: null,
      localized: null,
      text: null,
      changes: [],
      formatChanges: [],
      entitiesPreserved: [],
      terminology: [],
      llmReview: false,
      reviewReasons: [],
      repairs: [],
      notes: [],
      glossaryHits: seg.translatable ? findGlossaryHits(plain, lang, glossary) : [],
      claims,
      claimActions: claims.map((c) => claimAction(lc, c, sourceRegion)),
      backTranslation: null,
      validation: null,
      repairLoops: 0,
      dirty: true,
    };
    if (pageType === 'LEGAL') {
      s.llmReview = true;
      s.reviewReasons.push('LEGAL_PAGE: legal content is translated only and always needs human review');
    }
    if (operation === 'SKIP_IDENTICAL') {
      s.text = seg.text;
      s.notes.push(
        `[EVIDENCE: detection p=${(detected?.confidence ?? doc.source_language_detection?.confidence ?? 1).toFixed(2)}] Source already in target locale.`,
      );
    } else if (!seg.translatable) {
      s.translation = seg.text;
      s.localized = seg.text;
      s.text = seg.text;
      s.notes.push(`[EVIDENCE: ${seg.segment_id}] Entity-only segment: copied, formats only.`);
    } else if (operation === 'ADAPT_ONLY') {
      s.translation = seg.text;
    }
    const prior = opts.prior?.get(seg.segment_id);
    if (prior?.translation && s.translation === null) {
      s.translation = prior.translation;
      s.text = prior.translation;
    }
    const existing = opts.existing?.get(seg.segment_id);
    if (existing) {
      s.text = existing.text;
      s.translation = existing.translation;
      s.localized = existing.localized;
      s.changes = [...existing.changes];
      s.formatChanges = [...existing.formatChanges];
      s.status = existing.status;
    }
    return s;
  });
}

/** Mechanical post-processing after the model stages: number / currency / date formats (logged as FORMAT_CHANGE) and slug shape. */
export function postProcess(lc: LocaleContext, s: SegState): void {
  if (s.status !== 'OK' || s.text === null || s.operation === 'SKIP_IDENTICAL') return;
  const norm = normalizeFormats(
    { source_text: s.seg.text, source_lang: s.lang, source_locale: s.segmentLocale, target_text: s.text, target: lc.target },
    lc.lint,
  );
  s.text = norm.text;
  s.formatChanges = norm.changes.map((c) => ({ ...c, type: 'FORMAT_CHANGE' as const, segment_id: s.seg.segment_id, locale: lc.target }));
  if (s.seg.meta_kind === 'slug') {
    const slug = slugify(plainText(s.text), { transliterate: lc.profile.slug.transliterate, stripDiacritics: lc.profile.slug.strip_diacritics });
    if (slug !== s.text) {
      const change: Change = {
        from: s.text,
        to: slug,
        rule: 'SEO-SLUG-01',
        reason: '[EVIDENCE: SEO-SLUG-01] Slug normalised: lowercase, hyphenated, umlauts transliterated.',
        origin: 'deterministic',
      };
      s.changes.push(change);
      s.text = slug;
    }
  }
}

function lintContextFor(run: RunContext, target: LocaleCode): LintContext {
  const { config } = run;
  const facts = config.marketFacts[target];
  return {
    target,
    profile: config.locales[target],
    common: config.common,
    glossary: config.glossary,
    ...(facts ? { marketFacts: facts } : {}),
    thresholds: { back_translation_similarity_min: config.stages.thresholds.back_translation_similarity_min },
  };
}

export function makeLocaleContext(run: RunContext, target: LocaleCode, doc: SourceDocument): LocaleContext {
  return {
    run,
    target,
    profile: run.config.locales[target],
    lint: lintContextFor(run, target),
    facts: run.config.marketFacts[target],
    doc,
    pageType: doc.page_type,
    halted: false,
    findingSeq: 0,
    docFindings: [],
  };
}

function providersOf(lc: LocaleContext): LocaleResult['providers'] {
  const out: Partial<Record<Stage, StageBinding>> = {};
  for (const c of lc.run.costs.calls().filter((x) => x.locale === lc.target && x.ok)) out[c.stage] = { provider: c.provider, model: c.model };
  return out;
}

export async function processLocale(run: RunContext, target: LocaleCode, doc: SourceDocument, opts: LocaleRunOptions = {}): Promise<{ result: LocaleResult; halted: boolean }> {
  const lc = makeLocaleContext(run, target, doc);
  const sw = run.settings.stages;
  const states = buildStates(lc, opts);
  run.log.info({ code: 'LOCALE_START', message: `${target}: ${states.length} segment(s)`, locale: target });

  if (sw.translate) await runTranslation(lc, states);
  if (sw.localize) await runLocalization(lc, states);
  for (const s of states) {
    // A segment that still lacks a stage it needs (the run was halted before it got there) is not finished: never report it as a result.
    const needsLocalized =
      sw.localize && lc.pageType === 'CONTENT' && s.seg.translatable && (s.operation === 'TRANSLATE_LOCALIZE' || s.operation === 'ADAPT_ONLY');
    if (s.status === 'OK' && needsLocalized && s.localized === null) {
      s.status = lc.halted ? 'NOT_PROCESSED' : 'PROVIDER_ERROR';
      s.notes.push(`[EVIDENCE: ${s.seg.segment_id}] the localization stage did not complete for this segment${lc.halted ? ' (run halted: cost ceiling)' : ''}.`);
    }
    if (s.status === 'OK' && s.text === null && s.translation !== null) s.text = s.translation;
    if (s.status === 'OK' && s.text === null) s.status = lc.halted ? 'NOT_PROCESSED' : 'PROVIDER_ERROR';
  }
  if (!opts.skipPostProcess) for (const s of states) postProcess(lc, s);

  if (sw.validate) {
    await validateStates(lc, states);
    if (sw.repair && run.settings.maxRepairLoops > 0) await runRepair(lc, states);
  }

  const segments: SegmentResult[] = states.map((s) => buildSegmentResult(lc, s));
  assignFindingIds(lc, lc.docFindings);
  const agg = aggregateLocale(lc, states, segments);
  const counts = {
    segments: segments.length,
    ok: segments.filter((r) => r.status === 'OK').length,
    provider_error: segments.filter((r) => r.status === 'PROVIDER_ERROR').length,
    not_processed: segments.filter((r) => r.status === 'NOT_PROCESSED').length,
    findings_minor: 0,
    findings_major: 0,
    findings_critical: 0,
    findings_open: 0,
    changes: segments.reduce((n, r) => n + r.changes.length, 0),
    format_changes: segments.reduce((n, r) => n + r.format_changes.length, 0),
    repairs: segments.reduce((n, r) => n + r.repairs.length, 0),
    human_review_segments: segments.filter((r) => r.requires_human_review).length,
  };
  const open = [...segments.flatMap((r) => (r.validation?.findings ?? []).filter((f) => f.status === 'open')), ...lc.docFindings.filter((f) => f.status === 'open')];
  // document-level findings attached to a segment are already inside its findings list; count each finding once
  const seen = new Set<string>();
  for (const f of open) {
    if (seen.has(f.finding_id)) continue;
    seen.add(f.finding_id);
    counts.findings_open++;
    counts[`findings_${f.severity}` as 'findings_minor']++;
  }
  const operations: LocaleResult['operations'] = {};
  for (const s of states) operations[s.operation] = (operations[s.operation] ?? 0) + 1;

  const result: LocaleResult = {
    target_locale: target,
    hreflang: lc.profile.hreflang,
    verdict: agg.verdict,
    verdict_reasons: agg.reasons,
    quality_score: agg.score,
    penalty: agg.penalty,
    word_count: agg.words,
    operations,
    counts,
    providers: providersOf(lc),
    usage: usageOfLocale(lc),
    segments,
    document_findings: lc.docFindings,
    seo_meta: buildSeoMeta(lc, states),
    recommendations: buildRecommendations(lc, states),
  };
  run.log.info({ code: 'LOCALE_END', message: `${target}: ${agg.verdict} (${agg.score})`, locale: target });
  return { result, halted: lc.halted };
}

/** A locale whose processing crashed unexpectedly: every segment is reported as not processed and the verdict is FAIL (the run continues). */
export function failedLocaleResult(run: RunContext, target: LocaleCode, doc: SourceDocument, message: string): LocaleResult {
  const lc = makeLocaleContext(run, target, doc);
  const segments: SegmentResult[] = doc.segments.map((seg) => ({
    segment_id: seg.segment_id,
    block_type: seg.block_type,
    order: seg.order,
    ...(seg.meta_kind ? { meta_kind: seg.meta_kind } : {}),
    inline: seg.inline,
    source_text: seg.text,
    source_lang: seg.lang?.lang ?? doc.source_language,
    source_lang_confidence: seg.lang?.confidence ?? 0,
    operation: 'TRANSLATE_LOCALIZE' as const,
    status: 'NOT_PROCESSED' as const,
    translation: null,
    localized_text: null,
    final_text: null,
    changes: [],
    format_changes: [],
    entities_preserved: [],
    terminology_applied: [],
    requires_human_review: true,
    review_reasons: [],
    repairs: [],
    validation: null,
    notes: [],
  }));
  return {
    target_locale: target,
    hreflang: lc.profile.hreflang,
    verdict: 'FAIL',
    verdict_reasons: [`RUN_ERROR: processing of this locale stopped unexpectedly: ${message}`],
    quality_score: 0,
    penalty: 100,
    word_count: 0,
    operations: {},
    counts: {
      segments: segments.length,
      ok: 0,
      provider_error: 0,
      not_processed: segments.length,
      findings_minor: 0,
      findings_major: 0,
      findings_critical: 0,
      findings_open: 0,
      changes: 0,
      format_changes: 0,
      repairs: 0,
      human_review_segments: segments.length,
    },
    providers: {},
    usage: usageOfLocale(lc),
    segments,
    document_findings: [],
    seo_meta: buildSeoMeta(lc, []),
    recommendations: [],
  };
}
