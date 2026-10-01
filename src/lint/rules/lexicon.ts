/** `lexicon`: every match of a term pattern in the target is a finding (forbidden characters, variants, quotes, tone). */
import { matchAll } from '../../util/regex.js';
import { matchCase } from '../../util/text.js';
import { joinList, quote, ruleTag, violation, type RuleOutcome, type Violation } from '../draft.js';
import { expandTemplate, rulePattern } from '../patterns.js';
import type { RuleOf, SegmentView } from '../segment.js';

const REGEX_SYNTAX = /[\\^$.|?*+()[\]{}]/u;

/** The PASS note names the forbidden forms when they are plain literals, case-folded (`ß` and `ẞ` are one letter to a reader). */
function passNote(rule: RuleOf<'lexicon'>): string {
  const patterns = rule.terms.map((t) => t.pattern);
  const literal = patterns.length > 0 && patterns.every((p) => !REGEX_SYNTAX.test(p));
  const named = literal ? [...new Set(patterns.map((p) => p.toLowerCase()))] : [];
  return `${ruleTag(rule)} ${named.length > 0 ? `No ${joinList(named)} present.` : 'No listed form present.'}`;
}

export function evaluateLexicon(rule: RuleOf<'lexicon'>, seg: SegmentView): RuleOutcome {
  const plain = seg.tgt.plain;
  const taken = new Set<string>();
  const violations: Violation[] = [];
  for (const term of rule.terms) {
    for (const m of matchAll(rulePattern(term.pattern, rule.flags), plain)) {
      const key = `${m.start}:${m.end}`;
      if (taken.has(key)) continue; // one finding per matched text, the first term wins
      let replacement: string | undefined;
      if (term.prefer !== undefined) {
        const expanded = expandTemplate(term.prefer, m.groups);
        replacement = term.preserve_case === false ? expanded : matchCase(m.text, expanded);
        if (replacement === m.text) continue; // a no-op is not a violation (ß upper-cases to SS)
      }
      taken.add(key);
      const span = seg.span(m.start, m.end);
      const note = term.note ? ` (${term.note})` : '';
      violations.push(
        violation(rule, {
          detail: replacement !== undefined ? `Found ${quote(m.text)}${note}; write ${quote(replacement)}.` : `Found ${quote(m.text)}${note}.`,
          segmentId: seg.input.segment_id,
          span,
          targetSpan: m.text,
          fix: replacement !== undefined ? `Replace ${quote(m.text)} with ${quote(replacement)}.` : undefined,
          replacement: replacement !== undefined ? seg.safeReplacement(span, replacement) : undefined,
        }),
      );
    }
  }
  return { violations, passNote: passNote(rule) };
}
