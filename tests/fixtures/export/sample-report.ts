/**
 * Realistic run reports for the export tests, built programmatically and validated with `RunReportSchema` (so a schema change
 * breaks the fixture loudly). `sampleReport()` is a nl-NL page exported to de-CH (the spec §5.1 golden segment, a repair, a
 * currency-policy finding) and en-NL (an open critical finding, a provider error); `legalReport()` is the same run for a legal page.
 * Every call returns a fresh object, so tests may mutate it freely.
 */
import { RunReportSchema } from '../../../src/schemas/index.js';
import type {
  BlockType,
  Change,
  Finding,
  FormatChange,
  InlineTag,
  LocaleCode,
  LocaleResult,
  MetaKind,
  Operation,
  RepairRecord,
  Recommendation,
  RunReport,
  SegmentGroup,
  SegmentResult,
  SegmentValidation,
} from '../../../src/schemas/index.js';
import { charLength, wordCount } from '../../../src/util/text.js';

const GOLDEN_SOURCE =
  'Onze centrifugaalpompen leveren een debiet tot 450 m³/h bij een opvoerhoogte van 80 meter. Vraag vandaag nog een vrijblijvende offerte aan — levering binnen 5 werkdagen in heel Nederland.';
const GOLDEN_TRANSLATION =
  'Unsere Kreiselpumpen fördern bis zu 450 m³/h bei einer Förderhöhe von 80 Metern. Fordern Sie noch heute ein unverbindliches Angebot an – Lieferung innerhalb von 5 Werktagen in den gesamten Niederlanden.';
export const GOLDEN_LOCALIZED =
  'Unsere Kreiselpumpen fördern bis zu 450 m³/h bei einer Förderhöhe von 80 Metern. Fordern Sie noch heute eine unverbindliche Offerte an – Lieferung innert 5 Arbeitstagen.';

type TargetLocale = 'de-CH' | 'en-NL';

// ---------------------------------------------------------------------------------------------------------------
// The source page (nl-NL) — shared by both locales
// ---------------------------------------------------------------------------------------------------------------

interface SourceSegment {
  id: string;
  type: BlockType;
  text: string;
  lang?: string;
  meta?: MetaKind;
  level?: number;
  group?: SegmentGroup;
  href?: string;
  src?: string;
  inline?: Record<string, InlineTag>;
}

const cell = (row: number, col: number): SegmentGroup => ({ kind: 'table', id: 'tbl-1', row, col, header: row === 0 });

const SOURCE: SourceSegment[] = [
  { id: 'meta-title', type: 'meta', meta: 'title', text: 'Centrifugaalpompen voor de industrie | Advies, levering en onderhoud' },
  { id: 'meta-description', type: 'meta', meta: 'description', text: 'Centrifugaalpompen voor industrie en waterbeheer. Vraag vandaag nog een vrijblijvende offerte aan.' },
  { id: 'meta-slug', type: 'meta', meta: 'slug', text: 'centrifugaalpompen industrie' },
  { id: 'meta-keyword', type: 'meta', meta: 'keyword', text: 'centrifugaalpomp' },
  { id: 'h-001', type: 'heading', level: 1, text: 'Centrifugaalpompen voor de industrie' },
  { id: 'h-002', type: 'heading', level: 2, text: 'Waarom kiezen voor onze pompen?' },
  { id: 'p-003', type: 'paragraph', text: GOLDEN_SOURCE },
  {
    id: 'li-004',
    type: 'list_item',
    text: 'Bekijk onze <a1>pompenreeks</a1> voor elke toepassing',
    group: { kind: 'list', id: 'ul-1', ordered: false, index: 0, depth: 0 },
    inline: { a1: { tag: 'a', attrs: { href: '/pompen?type=cp&maat=large' } } },
  },
  {
    id: 'li-005',
    type: 'list_item',
    text: 'Advies van <strong1>ervaren</strong1> monteurs',
    group: { kind: 'list', id: 'ul-1', ordered: false, index: 1, depth: 0 },
    inline: { strong1: { tag: 'strong', attrs: {} } },
  },
  { id: 'li-006', type: 'list_item', text: 'Ook in het weekend bereikbaar', group: { kind: 'list', id: 'ul-2', ordered: true, index: 0, depth: 1 } },
  {
    id: 'p-007',
    type: 'paragraph',
    text: 'Vanaf € 1.250,00 excl. BTW, afhankelijk van de grootte.<br1/>Bel ons op +31 20 123 4567.',
    inline: { br1: { tag: 'br', attrs: {} } },
  },
  { id: 'td-008', type: 'table_cell', text: 'Model', group: cell(0, 0) },
  { id: 'td-009', type: 'table_cell', text: 'Debiet', group: cell(0, 1) },
  { id: 'td-010', type: 'table_cell', text: 'Opvoerhoogte', group: cell(0, 2) },
  { id: 'td-011', type: 'table_cell', text: 'CP-100', group: cell(1, 0) },
  { id: 'td-012', type: 'table_cell', text: 'Flow rate: 450 m³/h', lang: 'en', group: cell(1, 1) },
  { id: 'td-013', type: 'table_cell', text: '80 m', group: cell(1, 2) },
  { id: 'td-014', type: 'table_cell', text: 'CP-200', group: cell(2, 0) },
  { id: 'td-015', type: 'table_cell', text: '900 m³/h', group: cell(2, 1) },
  { id: 'td-016', type: 'table_cell', text: '95 m', group: cell(2, 2) },
  { id: 'alt-017', type: 'alt', src: '/images/pomp-cp100.jpg', text: 'Centrifugaalpomp CP-100 in een fabriekshal' },
  { id: 'a-018', type: 'anchor', href: '/contact?utm=pompen&ref=nl', text: 'Vraag een offerte aan' },
  { id: 'p-019', type: 'paragraph', text: 'Onze service staat 24 uur per dag voor u klaar.' },
];

// ---------------------------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------------------------

const EVIDENCE = (ref: string): string => `[EVIDENCE: ${ref}]`;

function finding(p: Partial<Finding> & Pick<Finding, 'finding_id' | 'locale' | 'rule_or_category' | 'severity' | 'evidence' | 'explanation'>): Finding {
  return {
    segment_id: null,
    origin: 'deterministic',
    source_span: null,
    target_span: null,
    span: null,
    suggested_fix: null,
    autofix: null,
    requires_human_review: false,
    repair_trigger: false,
    status: 'open',
    ...p,
  };
}

function validation(segmentId: string, locale: LocaleCode, text: string, p: Partial<SegmentValidation> = {}): SegmentValidation {
  const findings = p.findings ?? [];
  const penalty = findings.filter((f) => f.status === 'open').reduce((n, f) => n + { minor: 1, major: 5, critical: 25 }[f.severity], 0);
  return {
    segment_id: segmentId,
    target_locale: locale,
    deterministic_checks: [],
    llm_judge: null,
    back_translation: null,
    back_translation_similarity: null,
    quality_score: Math.max(0, 100 - penalty),
    penalty,
    word_count: wordCount(text),
    verdict: penalty === 0 ? 'PASS' : 'PASS_WITH_NOTES',
    verdict_reasons: [],
    localization_recommendations: [],
    findings,
    ...p,
  };
}

/** What one locale did with one source segment. */
interface Outcome {
  translation: string | null;
  localized: string | null;
  final: string | null;
  operation?: Operation;
  status?: SegmentResult['status'];
  changes?: Change[];
  format_changes?: FormatChange[];
  repairs?: RepairRecord[];
  reasons?: string[];
  review?: boolean;
  validation?: SegmentValidation | null;
  notes?: string[];
  terminology?: SegmentResult['terminology_applied'];
  entities?: string[];
}

/** A segment that needs no translation (codes, figures): the text is carried over unchanged. */
const same = (text: string): Outcome => ({ translation: text, localized: text, final: text });

function buildSegment(src: SourceSegment, order: number, o: Outcome): SegmentResult {
  const reasons = o.reasons ?? [];
  return {
    segment_id: src.id,
    block_type: src.type,
    order,
    ...(src.meta ? { meta_kind: src.meta } : {}),
    ...(src.level ? { level: src.level } : {}),
    ...(src.group ? { group: src.group } : {}),
    ...(src.href ? { href: src.href } : {}),
    ...(src.src ? { src: src.src } : {}),
    inline: src.inline ?? {},
    source_text: src.text,
    source_lang: src.lang ?? 'nl',
    source_lang_confidence: src.lang ? 0.97 : 0.99,
    operation: o.operation ?? 'TRANSLATE_LOCALIZE',
    status: o.status ?? 'OK',
    translation: o.translation,
    localized_text: o.localized,
    final_text: o.final,
    changes: o.changes ?? [],
    format_changes: o.format_changes ?? [],
    entities_preserved: o.entities ?? [],
    terminology_applied: o.terminology ?? [],
    requires_human_review: o.review ?? reasons.length > 0,
    review_reasons: reasons,
    repairs: o.repairs ?? [],
    validation: o.validation ?? null,
    notes: o.notes ?? [],
  };
}

function deriveCounts(segments: SegmentResult[], documentFindings: Finding[]): LocaleResult['counts'] {
  const findings = [...segments.flatMap((s) => s.validation?.findings ?? []), ...documentFindings];
  const open = (severity: Finding['severity']): number => findings.filter((f) => f.status === 'open' && f.severity === severity).length;
  const sum = (pick: (s: SegmentResult) => number): number => segments.reduce((n, s) => n + pick(s), 0);
  return {
    segments: segments.length,
    ok: segments.filter((s) => s.status === 'OK').length,
    provider_error: segments.filter((s) => s.status === 'PROVIDER_ERROR').length,
    not_processed: segments.filter((s) => s.status === 'NOT_PROCESSED').length,
    findings_minor: open('minor'),
    findings_major: open('major'),
    findings_critical: open('critical'),
    findings_open: findings.filter((f) => f.status === 'open').length,
    changes: sum((s) => s.changes.length),
    format_changes: sum((s) => s.format_changes.length),
    repairs: sum((s) => s.repairs.length),
    human_review_segments: segments.filter((s) => s.requires_human_review).length,
  };
}

interface LocaleSpec {
  code: TargetLocale;
  outcomes: Record<string, Outcome>;
  documentFindings: Finding[];
  recommendations: Recommendation[];
  verdict: LocaleResult['verdict'];
  verdictReasons: string[];
  penalty: number;
  providers: LocaleResult['providers'];
  usage: LocaleResult['usage'];
  primaryKeywordNote: string;
}

function buildLocale(spec: LocaleSpec): LocaleResult {
  const segments = SOURCE.map((src, i) => buildSegment(src, i + 1, spec.outcomes[src.id] as Outcome));
  const finalOf = (id: string): string | null => segments.find((s) => s.segment_id === id)?.final_text ?? null;
  const title = finalOf('meta-title');
  const description = finalOf('meta-description');
  const operations: LocaleResult['operations'] = {};
  for (const s of segments) operations[s.operation] = (operations[s.operation] ?? 0) + 1;
  return {
    target_locale: spec.code,
    hreflang: spec.code,
    verdict: spec.verdict,
    verdict_reasons: spec.verdictReasons,
    quality_score: Math.max(0, 100 - spec.penalty),
    penalty: spec.penalty,
    word_count: 90,
    operations,
    counts: deriveCounts(segments, spec.documentFindings),
    providers: spec.providers,
    usage: spec.usage,
    segments,
    document_findings: spec.documentFindings,
    seo_meta: {
      locale: spec.code,
      hreflang: spec.code,
      title,
      title_length: title === null ? 0 : charLength(title),
      title_max: 60,
      title_ok: title !== null && charLength(title) <= 60,
      meta_description: description,
      meta_description_length: description === null ? 0 : charLength(description),
      meta_description_max: 155,
      meta_description_ok: description !== null && charLength(description) <= 155,
      slug: finalOf('meta-slug'),
      h1: finalOf('h-001'),
      primary_keyword: {
        source: 'centrifugaalpomp',
        source_origin: 'provided',
        translated: finalOf('meta-keyword'),
        keyword_status: 'TRANSLATED_UNVERIFIED',
        note: spec.primaryKeywordNote,
      },
    },
    recommendations: spec.recommendations,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// de-CH: the golden exemplar, an autofix and an LLM repair, a currency-policy document finding
// ---------------------------------------------------------------------------------------------------------------

function deCh(): LocaleResult {
  const L: LocaleCode = 'de-CH';
  const longTitle = 'Kreiselpumpen für die Industrie | Beratung, Lieferung, Wartung';
  const title = 'Kreiselpumpen für die Industrie | Beratung und Wartung';
  const titleChange: Change = {
    from: 'Beratung, Lieferung, Wartung',
    to: 'Beratung und Wartung',
    rule: 'SEO-TITLE-LEN',
    reason: `${EVIDENCE('SEO-TITLE-LEN')} Title shortened from 62 to 54 characters.`,
    origin: 'repair',
  };
  const titleRepair: RepairRecord = {
    loop: 1,
    segment_id: 'meta-title',
    span_id: 'span-1',
    span: { start: longTitle.indexOf('Beratung'), end: longTitle.length },
    before: titleChange.from,
    after: titleChange.to,
    rule: 'SEO-TITLE-LEN',
    reason: titleChange.reason,
    origin: 'llm',
  };

  const goldenFindings: Finding[] = [
    finding({
      finding_id: 'de-CH-f-001',
      locale: L,
      segment_id: 'p-003',
      origin: 'llm_judge',
      rule_or_category: 'accuracy/omission',
      severity: 'major',
      evidence: EVIDENCE('INTEGRITY-MARKET-CLAIM'),
      explanation: `${EVIDENCE('INTEGRITY-MARKET-CLAIM')} Deliberate neutralization; business must confirm Swiss delivery scope and lead time.`,
      source_span: 'in heel Nederland',
      target_span: '',
      suggested_fix: "Add de-CH.delivery to market_facts.yaml, e.g. 'in die ganze Schweiz' with confirmed lead time.",
      requires_human_review: true,
    }),
  ];
  const golden: Outcome = {
    translation: GOLDEN_TRANSLATION,
    localized: GOLDEN_LOCALIZED,
    final: GOLDEN_LOCALIZED,
    changes: [
      { from: 'ein unverbindliches Angebot', to: 'eine unverbindliche Offerte', rule: 'DECH-LEX-OFFERTE', reason: `${EVIDENCE('DECH-LEX-OFFERTE')} Offerte is the standard Swiss B2B term for a quotation.`, origin: 'llm' },
      { from: 'innerhalb von 5 Werktagen', to: 'innert 5 Arbeitstagen', rule: 'DECH-LEX-INNERT', reason: `${EVIDENCE('DECH-LEX-INNERT')} Swiss preposition; Arbeitstage is the common Swiss usage.`, origin: 'llm' },
      { from: 'in den gesamten Niederlanden', to: '', rule: 'INTEGRITY-MARKET-CLAIM', reason: `${EVIDENCE('market_facts.yaml has no de-CH.delivery')} Geographic claim neutralized; delivery scope for Switzerland unconfirmed.`, origin: 'llm' },
    ],
    reasons: ['INTEGRITY-MARKET-CLAIM: source claims "in heel Nederland" and no de-CH delivery fact is supplied'],
    entities: ['450 m³/h', '80'],
    terminology: [
      { source: 'centrifugaalpomp', target: 'Kreiselpumpe', rule: 'GLOSS-0012' },
      { source: 'opvoerhoogte', target: 'Förderhöhe', rule: 'GLOSS-0019' },
    ],
    validation: validation('p-003', L, GOLDEN_LOCALIZED, {
      deterministic_checks: [
        { rule: 'DECH-SZ-01', result: 'PASS', note: `${EVIDENCE('DECH-SZ-01')} No ß present.` },
        { rule: 'INTEGRITY-ENTITY', result: 'PASS', note: `${EVIDENCE('p-003')} 450 m³/h and 80 preserved.` },
      ],
      llm_judge: {
        scores: { accuracy: 95, fluency: 98, terminology: 100, locale_conventions: 100, style_brand: 95 },
        mqm_errors: [
          {
            category: 'accuracy/omission',
            severity: 'major',
            source_span: 'in heel Nederland',
            target_span: '',
            explanation: `${EVIDENCE('INTEGRITY-MARKET-CLAIM')} Deliberate neutralization; business must confirm Swiss delivery scope and lead time.`,
            suggested_fix: "Add de-CH.delivery to market_facts.yaml, e.g. 'in die ganze Schweiz' with confirmed lead time.",
          },
        ],
        confidence: 0.9,
      },
      back_translation:
        'Our centrifugal pumps deliver up to 450 m³/h at a head of 80 metres. Request a non-binding quotation today – delivery within 5 working days.',
      back_translation_similarity: 0.84,
      quality_score: 95,
      penalty: 5,
      word_count: 27,
      verdict: 'HUMAN_REVIEW',
      verdict_reasons: [`HUMAN_REVIEW: business claim neutralised ${EVIDENCE('INTEGRITY-MARKET-CLAIM')}`],
      localization_recommendations: [
        '[HYPOTHESIS] Show prices in CHF and add a Swiss contact number if the client serves CH directly.',
        '[HYPOTHESIS] Reference SVGW certification if the pumps are used in potable-water applications and certification exists — verify.',
      ],
      findings: goldenFindings,
    }),
  };

  const pricedIn = "Ab € 1'250.00 zzgl. MWST, je nach Größe.<br1/>Rufen Sie uns an unter +31 20 123 4567.";
  const pricedFinal = pricedIn.replace('Größe', 'Grösse');
  const szFinding = finding({
    finding_id: 'de-CH-f-002',
    locale: L,
    segment_id: 'p-007',
    rule_or_category: 'DECH-SZ-01',
    severity: 'critical',
    evidence: EVIDENCE('DECH-SZ-01'),
    explanation: `${EVIDENCE('DECH-SZ-01')} Swiss Standard German never uses ß; found in "Größe".`,
    target_span: 'Größe',
    suggested_fix: 'Replace every ß with ss (Größe → Grösse).',
    span: { start: pricedIn.indexOf('Größe'), end: pricedIn.indexOf('Größe') + 'Größe'.length },
    autofix: { replacement: 'Grösse' },
    repair_trigger: true,
    status: 'fixed',
  });
  const titleFinding = finding({
    finding_id: 'de-CH-f-003',
    locale: L,
    segment_id: 'meta-title',
    rule_or_category: 'SEO-TITLE-LEN',
    severity: 'minor',
    evidence: EVIDENCE('SEO-TITLE-LEN'),
    explanation: `${EVIDENCE('SEO-TITLE-LEN')} The title has 62 characters; the limit is 60.`,
    target_span: longTitle,
    suggested_fix: 'Shorten the title to at most 60 characters.',
    repair_trigger: true,
    status: 'fixed',
  });
  const currency = finding({
    finding_id: 'de-CH-f-004',
    locale: L,
    origin: 'pipeline',
    rule_or_category: 'CURRENCY-POLICY-01',
    severity: 'minor',
    evidence: '[HYPOTHESIS]',
    explanation: '[HYPOTHESIS] Prices are retained in EUR; Swiss buyers expect CHF. Confirm the currency policy for CH.',
    suggested_fix: 'Add `currency` for de-CH to market_facts.yaml.',
  });

  return buildLocale({
    code: L,
    outcomes: {
      'meta-title': {
        translation: longTitle,
        localized: longTitle,
        final: title,
        changes: [titleChange],
        repairs: [titleRepair],
        validation: validation('meta-title', L, title, { findings: [titleFinding] }),
      },
      'meta-description': same('Kreiselpumpen für Industrie und Wasserwirtschaft. Fordern Sie noch heute eine unverbindliche Offerte an.'),
      'meta-slug': { translation: 'kreiselpumpen industrie', localized: 'kreiselpumpen industrie', final: 'kreiselpumpen-industrie' },
      'meta-keyword': same('Kreiselpumpe'),
      'h-001': { translation: 'Kreiselpumpen für die Industrie', localized: 'Kreiselpumpen für die Industrie', final: 'Kreiselpumpen für die Industrie', validation: validation('h-001', L, 'Kreiselpumpen für die Industrie') },
      'h-002': same('Warum unsere Pumpen?'),
      'p-003': golden,
      'li-004': same('Sehen Sie sich unsere <a1>Pumpenreihe</a1> für jede Anwendung an'),
      'li-005': same('Beratung durch <strong1>erfahrene</strong1> Monteure'),
      'li-006': same('Auch am Wochenende erreichbar'),
      'p-007': {
        translation: 'Ab € 1.250,00 zzgl. MwSt., je nach Größe.<br1/>Rufen Sie uns an unter +31 20 123 4567.',
        localized: pricedIn,
        final: pricedFinal,
        changes: [{ from: 'MwSt.', to: 'MWST', rule: 'DECH-LEX-HELV-01', reason: `${EVIDENCE('DECH-LEX-HELV-01')} Swiss VAT is abbreviated MWST.`, origin: 'deterministic' }],
        format_changes: [
          { type: 'FORMAT_CHANGE', segment_id: 'p-007', locale: L, aspect: 'number', from: '1.250,00', to: "1'250.00", rule: 'DECH-NUM-01', origin: 'deterministic' },
          { type: 'FORMAT_CHANGE', segment_id: 'p-007', locale: L, aspect: 'currency', from: '€ 1.250,00', to: "€ 1'250.00", rule: 'DECH-CUR-01', note: 'EUR retained; no conversion', origin: 'deterministic' },
        ],
        repairs: [
          {
            loop: 1,
            segment_id: 'p-007',
            span_id: 'span-1',
            span: { start: pricedIn.indexOf('Größe'), end: pricedIn.indexOf('Größe') + 'Größe'.length },
            before: 'Größe',
            after: 'Grösse',
            rule: 'DECH-SZ-01',
            reason: `${EVIDENCE('DECH-SZ-01')} Swiss Standard German never uses ß.`,
            origin: 'autofix',
          },
        ],
        validation: validation('p-007', L, pricedFinal, {
          deterministic_checks: [{ rule: 'DECH-SZ-01', result: 'PASS', note: `${EVIDENCE('DECH-SZ-01')} No ß present.` }],
          findings: [szFinding],
        }),
      },
      'td-008': same('Modell'),
      'td-009': { translation: 'Fördermenge', localized: 'Fördermenge', final: 'Fördermenge' },
      'td-010': { translation: 'Förderhöhe', localized: 'Förderhöhe', final: 'Förderhöhe' },
      'td-011': same('CP-100'),
      'td-012': { translation: 'Fördermenge: 450 m³/h', localized: 'Fördermenge: 450 m³/h', final: 'Fördermenge: 450 m³/h' },
      'td-013': same('80 m'),
      'td-014': same('CP-200'),
      'td-015': same('900 m³/h'),
      'td-016': same('95 m'),
      'alt-017': same('Kreiselpumpe CP-100 in einer Fabrikhalle'),
      'a-018': {
        translation: 'Angebot anfordern',
        localized: 'Offerte anfordern',
        final: 'Offerte anfordern',
        changes: [{ from: 'Angebot anfordern', to: 'Offerte anfordern', rule: 'DECH-LEX-OFFERTE', reason: `${EVIDENCE('DECH-LEX-OFFERTE')} Offerte is the standard Swiss B2B term.`, origin: 'llm' }],
      },
      'p-019': same('Unser Service steht Ihnen rund um die Uhr zur Verfügung.'),
    },
    documentFindings: [currency],
    recommendations: [
      { id: 'DECH-rec-001', locale: L, text: '[HYPOTHESIS] Show prices in CHF and add a Swiss contact number if the client serves CH directly.', source: 'judge', segment_id: 'p-003' },
      { id: 'DECH-rec-002', locale: L, text: '[HYPOTHESIS] Reference SVGW certification if the pumps are used in potable-water applications and certification exists — verify.', source: 'judge', segment_id: 'p-003' },
      { id: 'DECH-MARKET-LANG', locale: L, text: '[HYPOTHESIS] Switzerland is multilingual; check whether French- or Italian-language pages are needed.', source: 'market_check', segment_id: null },
    ],
    verdict: 'HUMAN_REVIEW',
    verdictReasons: [`HUMAN_REVIEW: business claim neutralised ${EVIDENCE('INTEGRITY-MARKET-CLAIM')}`],
    penalty: 6,
    providers: {
      translation: { provider: 'anthropic', model: 'fixture-model-a' },
      localization: { provider: 'anthropic', model: 'fixture-model-a' },
      validation: { provider: 'anthropic', model: 'fixture-model-a' },
      backtranslation: { provider: 'anthropic', model: 'fixture-model-a' },
      repair: { provider: 'anthropic', model: 'fixture-model-a' },
    },
    usage: { calls: 5, input_tokens: 7000, output_tokens: 2400, cost_usd: 0.025, unpriced_calls: 0, latency_ms: 9000 },
    primaryKeywordNote: '[HYPOTHESIS] Translated head term, not a measured search term; verify with keyword research for CH.',
  });
}

// ---------------------------------------------------------------------------------------------------------------
// en-NL: an open critical finding (FAIL), an over-long title, a provider error
// ---------------------------------------------------------------------------------------------------------------

function enNl(): LocaleResult {
  const L: LocaleCode = 'en-NL';
  const title = 'Centrifugal pumps for industry | Advice, delivery and maintenance';
  const priced = 'From €1,250.00 excl. VAT (BTW), depending on size.<br1/>Call us on +31 20 123 4576.';
  const entityFinding = finding({
    finding_id: 'en-NL-f-001',
    locale: L,
    segment_id: 'p-007',
    rule_or_category: 'INTEGRITY-ENTITY',
    severity: 'critical',
    evidence: EVIDENCE('INTEGRITY-ENTITY'),
    explanation: `${EVIDENCE('INTEGRITY-ENTITY')} The phone number was altered: +31 20 123 4567 became +31 20 123 4576.`,
    source_span: '+31 20 123 4567',
    target_span: '+31 20 123 4576',
    suggested_fix: 'Restore the original entity exactly as written in the source.',
    repair_trigger: true,
    requires_human_review: true,
  });
  const titleFinding = finding({
    finding_id: 'en-NL-f-002',
    locale: L,
    segment_id: 'meta-title',
    rule_or_category: 'SEO-TITLE-LEN',
    severity: 'minor',
    evidence: EVIDENCE('SEO-TITLE-LEN'),
    explanation: `${EVIDENCE('SEO-TITLE-LEN')} The title has 65 characters; the limit is 60.`,
    target_span: title,
    repair_trigger: true,
  });

  return buildLocale({
    code: L,
    outcomes: {
      'meta-title': { translation: title, localized: title, final: title, validation: validation('meta-title', L, title, { findings: [titleFinding] }) },
      'meta-description': same('Centrifugal pumps for industry and water management. Request a non-binding quotation today.'),
      'meta-slug': { translation: 'centrifugal pumps industry', localized: 'centrifugal pumps industry', final: 'centrifugal-pumps-industry' },
      'meta-keyword': same('centrifugal pump'),
      'h-001': same('Centrifugal pumps for industry'),
      'h-002': same('Why choose our pumps?'),
      'p-003': {
        translation:
          'Our centrifugal pumps deliver a flow of up to 450 m³/h at a head of 80 metres. Request a non-binding offer today – delivery within 5 working days across the Netherlands.',
        localized:
          'Our centrifugal pumps deliver a flow of up to 450 m³/h at a head of 80 metres. Request a non-binding quotation today – delivery within 5 working days across the Netherlands.',
        final:
          'Our centrifugal pumps deliver a flow of up to 450 m³/h at a head of 80 metres. Request a non-binding quotation today – delivery within 5 working days across the Netherlands.',
        changes: [{ from: 'offer', to: 'quotation', rule: 'ENNL-FF-OFFERTE', reason: `${EVIDENCE('ENNL-FF-OFFERTE')} "quotation" is the correct rendering of Dutch "offerte".`, origin: 'llm' }],
        validation: validation('p-003', L, 'Our centrifugal pumps deliver a flow of up to 450 m³/h'),
      },
      'li-004': same('Browse our <a1>pump range</a1> for every application'),
      'li-005': same('Advice from <strong1>experienced</strong1> fitters'),
      'li-006': same('Also available at weekends'),
      'p-007': {
        translation: 'From € 1.250,00 excl. VAT, depending on size.<br1/>Call us on +31 20 123 4567.',
        localized: priced,
        final: priced,
        changes: [{ from: 'excl. VAT', to: 'excl. VAT (BTW)', rule: 'ENNL-BTW-01', reason: `${EVIDENCE('ENNL-BTW-01')} First mention of BTW keeps the Dutch term in brackets.`, origin: 'deterministic' }],
        format_changes: [
          { type: 'FORMAT_CHANGE', segment_id: 'p-007', locale: L, aspect: 'number', from: '1.250,00', to: '1,250.00', rule: 'ENNL-NUM-01', origin: 'deterministic' },
          { type: 'FORMAT_CHANGE', segment_id: 'p-007', locale: L, aspect: 'currency', from: '€ 1.250,00', to: '€1,250.00', rule: 'ENNL-CUR-01', origin: 'deterministic' },
        ],
        reasons: ['INTEGRITY-ENTITY: phone number altered and not repaired after 2 loops'],
        validation: validation('p-007', L, priced, {
          deterministic_checks: [{ rule: 'INTEGRITY-ENTITY', result: 'FAIL', note: `${EVIDENCE('INTEGRITY-ENTITY')} +31 20 123 4567 is missing from the target.`, severity: 'critical' }],
          quality_score: 75,
          penalty: 25,
          verdict: 'FAIL',
          verdict_reasons: [`FAIL: critical finding unresolved after 2 repair loops ${EVIDENCE('INTEGRITY-ENTITY')}`],
          findings: [entityFinding],
        }),
      },
      'td-008': same('Model'),
      'td-009': { translation: 'Flow rate', localized: 'Flow rate', final: 'Flow rate' },
      'td-010': { translation: 'Head', localized: 'Head', final: 'Head' },
      'td-011': same('CP-100'),
      'td-012': { translation: 'Flow rate: 450 m³/h', localized: 'Flow rate: 450 m³/h', final: 'Flow rate: 450 m³/h', operation: 'ADAPT_ONLY' },
      'td-013': same('80 m'),
      'td-014': same('CP-200'),
      'td-015': same('900 m³/h'),
      'td-016': same('95 m'),
      'alt-017': same('Centrifugal pump CP-100 in a factory hall'),
      'a-018': same('Request a quotation'),
      'p-019': {
        translation: null,
        localized: null,
        final: null,
        status: 'PROVIDER_ERROR',
        reasons: ['PROVIDER_ERROR: retries exhausted'],
        notes: [`${EVIDENCE('p-019')} Provider error after 3 attempts: response failed schema validation.`],
      },
    },
    documentFindings: [],
    recommendations: [
      { id: 'ENNL-MARKET-PHONE', locale: L, text: '[HYPOTHESIS] Show Dutch phone numbers in international format (+31 …) and state opening hours in CET/CEST.', source: 'market_check', segment_id: null },
    ],
    verdict: 'FAIL',
    verdictReasons: [`FAIL: critical finding unresolved after 2 repair loops ${EVIDENCE('INTEGRITY-ENTITY')}`],
    penalty: 26,
    providers: {
      translation: { provider: 'anthropic', model: 'fixture-model-a' },
      localization: { provider: 'anthropic', model: 'fixture-model-a' },
      validation: { provider: 'openai', model: 'fixture-model-b' },
      backtranslation: { provider: 'openai', model: 'fixture-model-b' },
    },
    usage: { calls: 4, input_tokens: 5840, output_tokens: 1910, cost_usd: 0.0171, unpriced_calls: 1, latency_ms: 9250 },
    primaryKeywordNote: '[HYPOTHESIS] Translated head term, not a measured search term; verify with keyword research for NL.',
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------

export function sampleReport(): RunReport {
  const locales = [deCh(), enNl()];
  return RunReportSchema.parse({
    schema_version: 1,
    run_id: 'run-20260930-a1b2c3',
    tool_version: '0.1.0',
    status: 'COMPLETE',
    started_at: '2026-09-30T10:00:00.000Z',
    finished_at: '2026-09-30T10:00:21.500Z',
    duration_ms: 21500,
    source: {
      doc_id: 'doc-7f3a9c1e',
      origin_kind: 'url',
      origin_ref: 'https://www.example.nl/producten/centrifugaalpompen',
      source_locale: 'nl-NL',
      source_language: 'nl',
      page_type: 'CONTENT',
      page_type_evidence: 'no legal marker in the URL path or the title',
      segments: SOURCE.length,
      words: 90,
      languages: { nl: SOURCE.length - 1, en: 1 },
    },
    options: {
      targets: ['de-CH', 'en-NL'],
      pass_threshold: 90,
      max_repair_loops: 2,
      cost_ceiling_usd: 5,
      stages: { translate: true, localize: true, validate: true, repair: true, backtranslate: true },
    },
    routing: {
      translation: { provider: 'anthropic', model: 'fixture-model-a' },
      localization: { provider: 'anthropic', model: 'fixture-model-a' },
      validation: { provider: 'openai', model: 'fixture-model-b' },
      backtranslation: { provider: 'openai', model: 'fixture-model-b' },
      repair: { provider: 'anthropic', model: 'fixture-model-a' },
    },
    locales,
    totals: { calls: 9, input_tokens: 12840, output_tokens: 4310, cost_usd: 0.0421, unpriced_calls: 1, latency_ms: 18250 },
    calls: [
      { call_id: 'call-001', ts: '2026-09-30T10:00:02.000Z', stage: 'translation', locale: 'de-CH', provider: 'anthropic', model: 'fixture-model-a', input_tokens: 2100, output_tokens: 700, cost_usd: 0.0081, latency_ms: 1800, attempts: 1, ok: true, segments: 23, warnings: [] },
      { call_id: 'call-002', ts: '2026-09-30T10:00:09.000Z', stage: 'validation', locale: 'en-NL', provider: 'openai', model: 'fixture-model-b', input_tokens: 1900, output_tokens: 500, cost_usd: null, latency_ms: 2100, attempts: 2, ok: true, segments: 22, warnings: ['PARAM_UNSUPPORTED temperature'] },
      { call_id: 'call-003', ts: '2026-09-30T10:00:15.000Z', stage: 'localization', locale: 'en-NL', provider: 'anthropic', model: 'fixture-model-a', input_tokens: 800, output_tokens: 0, cost_usd: 0.0012, latency_ms: 900, attempts: 3, ok: false, segments: 1, warnings: [] },
    ],
    run_log: [
      { ts: '2026-09-30T10:00:00.100Z', level: 'info', code: 'STAGE_START', message: 'translation started for 2 locales', stage: 'translation' },
      { ts: '2026-09-30T10:00:04.250Z', level: 'warn', code: 'PARAM_UNSUPPORTED', message: 'model fixture-model-b ignores temperature; parameter dropped', stage: 'validation', provider: 'openai', data: { param: 'temperature', requested: 0 } },
      { ts: '2026-09-30T10:00:05.000Z', level: 'warn', code: 'PROVIDER_FALLBACK', message: 'google has no credentials; stage backtranslation falls back to openai', stage: 'backtranslation', provider: 'google', data: { fallback: 'openai' } },
      { ts: '2026-09-30T10:00:06.000Z', level: 'warn', code: 'JUDGE_NOT_INDEPENDENT', message: 'de-CH validation runs on the translation provider (anthropic); the judge is not independent', stage: 'validation', provider: 'anthropic', locale: 'de-CH' },
      { ts: '2026-09-30T10:00:12.000Z', level: 'warn', code: 'RETRY', message: 'attempt 1 failed with HTTP 429; retrying', stage: 'localization', provider: 'anthropic', locale: 'en-NL', segment_id: 'p-019', data: { attempt: 1, delay_ms: 500 } },
      { ts: '2026-09-30T10:00:15.500Z', level: 'error', code: 'PROVIDER_ERROR', message: 'p-019 failed after 3 attempts: response failed schema validation', stage: 'localization', provider: 'anthropic', locale: 'en-NL', segment_id: 'p-019', data: { attempts: 3 } },
      { ts: '2026-09-30T10:00:21.500Z', level: 'info', code: 'STAGE_END', message: 'run finished' },
    ],
    output_dir: null,
    artifacts: [],
  });
}

/** The same run for a legal page: translation only, every segment flagged for review, counsel pointers in the recommendations. */
export function legalReport(): RunReport {
  const report = sampleReport();
  report.source.page_type = 'LEGAL';
  report.source.page_type_evidence = 'url path contains "privacyverklaring"';
  report.source.origin_ref = 'https://www.example.nl/privacyverklaring';
  for (const locale of report.locales) {
    locale.verdict = 'HUMAN_REVIEW';
    locale.verdict_reasons = ['HUMAN_REVIEW: legal page; translation only [EVIDENCE: page_type LEGAL]'];
    for (const seg of locale.segments) {
      seg.operation = 'TRANSLATE_ONLY';
      seg.requires_human_review = true;
      if (!seg.review_reasons.some((r) => r.startsWith('LEGAL'))) seg.review_reasons.push('LEGAL: legal page, counsel review required');
    }
    locale.counts.human_review_segments = locale.segments.length;
    locale.operations = { TRANSLATE_ONLY: locale.segments.length };
    locale.recommendations.push({
      id: `${locale.target_locale}-LEGAL`,
      locale: locale.target_locale,
      text: '[HYPOTHESIS] — verify with counsel: the imprint and privacy requirements of this market apply to the translated page.',
      source: 'market_check',
      segment_id: null,
    });
  }
  return RunReportSchema.parse(report);
}

export function localeOf(report: RunReport, code: LocaleCode): LocaleResult {
  const found = report.locales.find((l) => l.target_locale === code);
  if (!found) throw new Error(`fixture has no ${code} locale`);
  return found;
}

export function segmentOf(locale: LocaleResult, id: string): SegmentResult {
  const found = locale.segments.find((s) => s.segment_id === id);
  if (!found) throw new Error(`fixture locale ${locale.target_locale} has no segment ${id}`);
  return found;
}
