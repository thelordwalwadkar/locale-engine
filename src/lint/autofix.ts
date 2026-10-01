/** Deterministic auto-fixes (ARCHITECTURE P9): applied before any model repair, never across inline markup. */
import type { FindingDraft, Span } from '../schemas/index.js';
import { tokenizeInline } from '../util/inline.js';
import type { AutofixApplied, AutofixResult } from './types.js';

const hasPlaceholder = (s: string): boolean => tokenizeInline(s).some((t) => t.kind !== 'text');

function validSpan(span: Span | null, text: string): span is Span {
  return span !== null && Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.start <= span.end && span.end <= text.length;
}

/**
 * Apply the `autofix` replacements of `findings` to `text`: only findings with a valid span, sorted by span start; a finding that
 * overlaps an earlier applied one is dropped, no-ops are skipped, and a replacement that would add, remove or move a placeholder is
 * refused. Replacements are applied right to left, so every `applied[].span` refers to the ORIGINAL text.
 */
export function applyAutofix(text: string, findings: FindingDraft[]): AutofixResult {
  const candidates = findings
    .map((f, order) => ({ f, order }))
    .filter(({ f }) => f.autofix !== null && validSpan(f.span, text))
    .sort((a, b) => (a.f.span as Span).start - (b.f.span as Span).start || a.order - b.order);
  const applied: AutofixApplied[] = [];
  let reach = -1;
  let lastStart = -1;
  for (const { f } of candidates) {
    const span = f.span as Span;
    const after = (f.autofix as { replacement: string }).replacement;
    if (span.start < reach || span.start === lastStart) continue;
    const before = text.slice(span.start, span.end);
    if (before === after || hasPlaceholder(before) || hasPlaceholder(after)) continue;
    applied.push({ rule: f.rule_or_category, span: { start: span.start, end: span.end }, before, after });
    reach = span.end;
    lastStart = span.start;
  }
  let out = text;
  for (const a of [...applied].reverse()) out = out.slice(0, a.span.start) + a.after + out.slice(a.span.end);
  return { text: out, applied };
}
