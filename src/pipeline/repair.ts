/**
 * REPAIR stage (spec §7 Phase 5, ARCHITECTURE P9): "Repair receives only flagged spans plus findings."
 * Each loop: (A) deterministic autofix of safe rules → (B) span-scoped model repair for what remains → (C) re-validation of every changed
 * segment. At most `max_repair_loops` loops; what is still open afterwards decides the verdict (majors → HUMAN_REVIEW, criticals → FAIL).
 * Business-claim findings are never "repaired away": they carry `requires_human_review`.
 */
import { applyAutofix } from '../lint/index.js';
import type { Finding } from '../schemas/findings.js';
import { RepairBatchWireSchema } from '../schemas/llm.js';
import type { RepairRecord } from '../schemas/report.js';
import { mapLimitSettled } from '../util/concurrency.js';
import { EngineError, errorMessage } from '../util/errors.js';
import { verifyInline } from '../util/inline.js';
import { makeBatches } from './batching.js';
import { ensureTagged } from './evidence.js';
import { openFindings, segmentMetrics } from './finalize.js';
import type { RepairPayload, RepairSpanPayload } from './payloads.js';
import {
  languageName,
  loadGolden,
  loadTemplate,
  renderEdgeExemplars,
  renderGolden,
  renderLocaleProfile,
  renderOutputContract,
  renderTemplate,
} from './prompt.js';
import type { OutputMode } from './prompt.js';
import type { LocaleContext, SegState } from './state.js';
import { isValidatable, validateStates } from './validate.js';

function belowThreshold(lc: LocaleContext, s: SegState): boolean {
  return segmentMetrics(lc, s).score < lc.run.scoring.passThreshold;
}

function repairable(lc: LocaleContext, s: SegState): Finding[] {
  const open = openFindings(s).filter((f) => !f.requires_human_review);
  if (open.some((f) => f.repair_trigger)) return open.filter((f) => f.repair_trigger || belowThreshold(lc, s));
  return belowThreshold(lc, s) ? open : [];
}

function wantsRepair(lc: LocaleContext, s: SegState): boolean {
  return isValidatable(s) && s.validation !== null && s.repairLoops < lc.run.settings.maxRepairLoops && repairable(lc, s).length > 0;
}

/**
 * A deterministic autofix costs nothing and cannot change meaning, so it is applied to every segment that has one, whether or not
 * the segment is bad enough to start a model repair (a lone minor finding such as "30 September" -> "30. September" is not).
 */
function hasAutofix(lc: LocaleContext, s: SegState): boolean {
  return (
    isValidatable(s) &&
    s.validation !== null &&
    s.text !== null &&
    s.repairLoops < lc.run.settings.maxRepairLoops &&
    openFindings(s).some((f) => f.autofix !== null && f.span !== null && f.origin === 'deterministic' && !f.requires_human_review)
  );
}

// ---------------------------------------------------------------------------------------------------------------
// A. deterministic autofix
// ---------------------------------------------------------------------------------------------------------------

function autofix(s: SegState, loop: number): boolean {
  const text = s.text;
  if (text === null) return false;
  const fixable = openFindings(s).filter((f) => f.autofix !== null && f.span !== null && f.origin === 'deterministic');
  if (!fixable.length) return false;
  const res = applyAutofix(text, fixable);
  if (res.text === text) return false;
  res.applied.forEach((a, i) => {
    s.repairs.push({
      loop,
      segment_id: s.seg.segment_id,
      span_id: `a${s.repairs.filter((r) => r.loop === loop).length + i + 1}`,
      span: a.span,
      before: a.before,
      after: a.after,
      rule: a.rule,
      reason: `[EVIDENCE: ${a.rule}] Deterministic fix applied by the linter.`,
      origin: 'autofix',
    });
  });
  s.text = res.text;
  s.dirty = true;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// B. span-scoped model repair
// ---------------------------------------------------------------------------------------------------------------

interface FindingAt {
  f: Finding;
  start: number;
  end: number;
}

/** Merge findings into non-overlapping spans. Findings without a usable span fall back to the whole text when nothing else is located. */
export function spansFor(text: string, findings: Finding[]): RepairSpanPayload[] {
  const located: FindingAt[] = findings
    .filter((f) => f.span !== null && f.span.end > f.span.start && f.span.end <= text.length)
    .map((f) => ({ f, start: (f.span as { start: number }).start, end: (f.span as { end: number }).end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const groups: Array<{ start: number; end: number; fs: Finding[] }> = [];
  for (const it of located) {
    const last = groups[groups.length - 1];
    if (last && it.start < last.end) {
      last.end = Math.max(last.end, it.end);
      last.fs.push(it.f);
    } else groups.push({ start: it.start, end: it.end, fs: [it.f] });
  }
  if (!groups.length && findings.some((f) => f.severity !== 'minor')) groups.push({ start: 0, end: text.length, fs: findings });
  return groups.map((g, i) => ({
    span_id: `s${i + 1}`,
    start: g.start,
    end: g.end,
    text: text.slice(g.start, g.end),
    findings: g.fs.map((f) => ({ rule: f.rule_or_category, severity: f.severity, explanation: f.explanation, suggested_fix: f.suggested_fix })),
  }));
}

export function repairSystem(lc: LocaleContext, mode: OutputMode): string {
  const dir = lc.run.kit.promptsDir;
  return renderTemplate(loadTemplate(dir, 'repair'), {
    source_locale: lc.doc.source_locale,
    target_locale: lc.target,
    target_language_name: languageName(lc.target),
    locale_profile: renderLocaleProfile(lc.profile, 'repair'),
    brand_voice_section: lc.run.kit.brandVoice,
    golden_exemplar: renderGolden(loadGolden(dir, 'repair'), mode),
    edge_exemplars: renderEdgeExemplars(lc.run.kit.edge, 'repair', lc.profile),
    output_contract: renderOutputContract(dir, mode, RepairBatchWireSchema),
  });
}

async function modelRepair(lc: LocaleContext, todo: SegState[], loop: number, changed: Set<SegState>): Promise<void> {
  const prepared = todo
    .map((s) => ({ s, spans: spansFor(s.text as string, repairable(lc, s)) }))
    .filter((p) => p.spans.length > 0);
  if (!prepared.length || lc.halted) return;
  const { batching, concurrency } = lc.run.config.stages;
  const jobs = makeBatches(prepared, { maxSegments: batching.max_segments, maxChars: batching.max_input_chars }, (p) => (p.s.text ?? '').length + p.s.seg.text.length + 400);

  await mapLimitSettled(jobs, concurrency.calls_per_locale, async (job) => {
    if (lc.halted) return;
    const payload: RepairPayload = {
      stage: 'repair',
      source_locale: lc.doc.source_locale,
      target_locale: lc.target,
      segments: job.map(({ s, spans }) => ({
        segment_id: s.seg.segment_id,
        block_type: s.seg.block_type,
        source_text: s.seg.text,
        current_text: s.text as string,
        spans,
      })),
    };
    try {
      const out = await lc.run.runner.call({
        stage: 'repair',
        locale: lc.target,
        segments: job.length,
        segmentIds: job.map((p) => p.s.seg.segment_id),
        system: (mode) => repairSystem(lc, mode),
        payload,
        schema: RepairBatchWireSchema,
      });
      const byId = new Map(out.results.map((r) => [r.segment_id, r]));
      for (const { s, spans } of job) applyRepairs(lc, s, spans, byId.get(s.seg.segment_id)?.repairs ?? [], loop, changed);
    } catch (e) {
      if (e instanceof EngineError && e.code === 'COST_CEILING') lc.halted = true;
      else lc.run.log.warn({ code: 'REPAIR_FAILED', message: `repair call failed: ${errorMessage(e)}`, stage: 'repair', locale: lc.target });
    }
  });
}

function applyRepairs(
  lc: LocaleContext,
  s: SegState,
  spans: RepairSpanPayload[],
  repairs: Array<{ span_id: string; replacement: string; rule: string; reason: string }>,
  loop: number,
  changed: Set<SegState>,
): void {
  let text = s.text as string;
  const byId = new Map(repairs.map((r) => [r.span_id, r]));
  const records: RepairRecord[] = [];
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    const r = byId.get(span.span_id);
    if (!r) continue;
    if (r.replacement === span.text) continue;
    const check = verifyInline(span.text, r.replacement);
    if (!check.ok) {
      lc.run.log.warn({ code: 'REPAIR_REJECTED', message: `replacement for ${span.span_id} changes inline markup; kept the original`, stage: 'repair', locale: lc.target, segment_id: s.seg.segment_id });
      continue;
    }
    const tagged = ensureTagged(r.reason);
    if (tagged.amended) lc.run.log.warn({ code: 'EVIDENCE_TAG_ADDED', message: 'repair reason without evidence tag marked [HYPOTHESIS]', stage: 'repair', locale: lc.target, segment_id: s.seg.segment_id });
    text = text.slice(0, span.start) + r.replacement + text.slice(span.end);
    records.push({
      loop,
      segment_id: s.seg.segment_id,
      span_id: span.span_id,
      span: { start: span.start, end: span.end },
      before: span.text,
      after: r.replacement,
      rule: r.rule.trim() || span.findings[0]?.rule || 'UNSPECIFIED',
      reason: tagged.text,
      origin: 'llm',
    });
  }
  if (!records.length) return;
  s.repairs.push(...records.reverse());
  s.text = text;
  s.dirty = true;
  changed.add(s);
}

// ---------------------------------------------------------------------------------------------------------------
// C. history and driver
// ---------------------------------------------------------------------------------------------------------------

function sameIssue(a: Finding, b: Finding): boolean {
  return a.rule_or_category === b.rule_or_category && (a.target_span ?? '') === (b.target_span ?? '');
}

function markFixed(s: SegState, before: Finding[]): void {
  if (!s.validation) return;
  const after = openFindings(s);
  for (const b of before) {
    if (after.some((a) => sameIssue(a, b))) continue;
    b.status = 'fixed';
    s.validation.history.push(b);
  }
}

export async function runRepair(lc: LocaleContext, states: SegState[]): Promise<void> {
  const max = lc.run.settings.maxRepairLoops;
  for (let loop = 1; loop <= max && !lc.halted; loop++) {
    const wanting = states.filter((s) => wantsRepair(lc, s));
    const cand = [...wanting, ...states.filter((s) => !wanting.includes(s) && hasAutofix(lc, s))];
    if (!cand.length) break;
    lc.run.log.info({ code: 'STAGE_START', message: `repair loop ${loop}: ${cand.length} segment(s)`, stage: 'repair', locale: lc.target });
    const before = new Map(cand.map((s) => [s.seg.segment_id, openFindings(s)]));
    const changed = new Set<SegState>();

    for (const s of cand) if (autofix(s, loop)) changed.add(s);
    await modelRepair(lc, wanting.filter((s) => !changed.has(s)), loop, changed); // only segments that earned a model repair

    for (const s of cand) {
      s.repairLoops++;
      if (!changed.has(s)) s.repairLoops = max; // nothing left that a repair could change
    }
    if (!changed.size) break;
    await validateStates(lc, [...changed]);
    for (const s of changed) markFixed(s, before.get(s.seg.segment_id) ?? []);
  }
}
