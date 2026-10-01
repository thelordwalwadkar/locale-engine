/**
 * Scoring model (spec §6.6, ASSUMPTIONS A-009/A-013, ARCHITECTURE DDR-005/006).
 *   penalty = Σ severity weights × 100 / max(words, words_floor);  quality_score = max(0, 100 − penalty)
 * Verdict precedence: FAIL > HUMAN_REVIEW > PASS_WITH_NOTES > PASS.
 */
import type { Severity, Verdict } from '../schemas/common.js';
import { VERDICT_SEVERITY_ORDER } from '../schemas/common.js';
import type { StagesConfig } from '../schemas/config.js';
import { round } from '../util/text.js';

export interface ScoringSettings {
  weights: Record<Severity, number>;
  wordsFloor: number;
  passThreshold: number;
  judgeConfidenceMin: number;
}

export function scoringSettings(stages: StagesConfig, passThreshold?: number): ScoringSettings {
  return {
    weights: stages.scoring.weights,
    wordsFloor: stages.scoring.words_floor,
    passThreshold: passThreshold ?? stages.thresholds.pass,
    judgeConfidenceMin: stages.thresholds.judge_confidence_min,
  };
}

export function rawWeight(severities: readonly Severity[], s: ScoringSettings): number {
  return severities.reduce((sum, sev) => sum + s.weights[sev], 0);
}

export function penaltyFor(rawWeightSum: number, words: number, s: ScoringSettings): number {
  return round((rawWeightSum * 100) / Math.max(words, s.wordsFloor), 2);
}

export function scoreFor(penalty: number): number {
  return round(Math.max(0, 100 - penalty), 2);
}

export interface OpenFinding {
  severity: Severity;
  requires_human_review: boolean;
  rule_or_category: string;
}

export interface VerdictInput {
  status: 'OK' | 'PROVIDER_ERROR' | 'NOT_PROCESSED';
  validated: boolean;
  score: number;
  open: OpenFinding[];
  judgeConfidence: number | null;
  reviewReasons: string[];
  legal: boolean;
  hasRecommendations: boolean;
}

export interface VerdictResult {
  verdict: Verdict;
  reasons: string[];
}

export function decideVerdict(i: VerdictInput, s: ScoringSettings): VerdictResult {
  if (i.status === 'PROVIDER_ERROR') return { verdict: 'FAIL', reasons: ['PROVIDER_ERROR: the segment could not be produced by the provider'] };
  if (i.status === 'NOT_PROCESSED') return { verdict: 'FAIL', reasons: ['NOT_PROCESSED: the run was halted (cost ceiling) before this segment was finished'] };
  if (!i.validated) {
    const reasons = ['NOT_VALIDATED: validation did not run for this segment'];
    if (i.legal) reasons.push('LEGAL_PAGE: legal content always needs human review');
    return { verdict: 'HUMAN_REVIEW', reasons };
  }

  const critical = i.open.filter((f) => f.severity === 'critical');
  if (critical.length) {
    return { verdict: 'FAIL', reasons: [`critical finding(s) unresolved: ${[...new Set(critical.map((f) => f.rule_or_category))].join(', ')}`] };
  }
  if (i.score < s.passThreshold) {
    return { verdict: 'FAIL', reasons: [`quality score ${i.score} is below the pass threshold ${s.passThreshold}`] };
  }

  const reasons: string[] = [];
  if (i.legal) reasons.push('LEGAL_PAGE: legal content is translated only and always needs human review');
  for (const r of i.reviewReasons) reasons.push(r);
  if (i.judgeConfidence !== null && i.judgeConfidence < s.judgeConfidenceMin) {
    reasons.push(`judge confidence ${i.judgeConfidence} is below ${s.judgeConfidenceMin}`);
  }
  const unresolvedMajors = i.open.filter((f) => f.severity === 'major' && !f.requires_human_review);
  if (unresolvedMajors.length) {
    reasons.push(`unresolved major finding after repair: ${[...new Set(unresolvedMajors.map((f) => f.rule_or_category))].join(', ')}`);
  }
  if (reasons.length) return { verdict: 'HUMAN_REVIEW', reasons };

  if (i.open.length > 0 || i.hasRecommendations) {
    return { verdict: 'PASS_WITH_NOTES', reasons: i.open.length ? [`${i.open.length} minor finding(s) remain`] : ['market recommendations attached'] };
  }
  return { verdict: 'PASS', reasons: [] };
}

export function worstVerdict(verdicts: readonly Verdict[]): Verdict {
  for (const v of VERDICT_SEVERITY_ORDER) if (verdicts.includes(v)) return v;
  return 'PASS';
}
