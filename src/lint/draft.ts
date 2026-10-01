/** Finding drafts and rule outcomes: the single place that decides how a deterministic finding is worded and tagged. */
import { evidenceTag, HYPOTHESIS_TAG, type FindingDraft, type Rule, type Span } from '../schemas/index.js';

/** A finding plus the concrete detail it was built from (reused for the check note). */
export interface Violation {
  finding: FindingDraft;
  detail: string;
}

export interface RuleOutcome {
  violations: Violation[];
  /** Set when the rule had something to verify and passed; becomes the PASS check of a critical rule. Carries its own tag. */
  passNote?: string;
  reviewReasons?: string[];
}

export const NO_OUTCOME: RuleOutcome = { violations: [] };

/** `[EVIDENCE: <rule id>]`, or `[HYPOTHESIS]` for heuristic rules. */
export function ruleTag(rule: Rule): string {
  return rule.hypothesis ? HYPOTHESIS_TAG : evidenceTag(rule.id);
}

interface ViolationSpec {
  /** Concrete, human-readable detail of this violation (inserted between the rule message and the tag). */
  detail: string;
  segmentId: string | null;
  span?: Span | null;
  targetSpan?: string | null;
  sourceSpan?: string | null;
  /** Concrete instruction placed in front of `rule.fix` in `suggested_fix`. */
  fix?: string;
  /** Exact replacement for `span`, already encoded for the placeholder-bearing text; used only when the rule has `autofix: true`. */
  replacement?: string;
  humanReview?: boolean;
}

export function violation(rule: Rule, spec: ViolationSpec): Violation {
  const tag = ruleTag(rule);
  const span = spec.span ?? null;
  const finding: FindingDraft = {
    segment_id: spec.segmentId,
    origin: 'deterministic',
    rule_or_category: rule.id,
    severity: rule.severity,
    evidence: tag,
    explanation: `${rule.message} ${spec.detail} ${tag}`,
    source_span: spec.sourceSpan ?? null,
    target_span: spec.targetSpan ?? null,
    span,
    suggested_fix: [spec.fix, rule.fix].filter((s) => s !== undefined && s !== '').join(' ') || null,
    autofix: rule.autofix && span !== null && spec.replacement !== undefined ? { replacement: spec.replacement } : null,
    requires_human_review: spec.humanReview ?? false,
    repair_trigger: rule.repair_trigger ?? rule.severity !== 'minor',
  };
  return { finding, detail: spec.detail };
}

export function quote(s: string): string {
  return `"${s}"`;
}

/** `a`, `a and b`, `a, b and c`. */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
