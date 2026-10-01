import type { CallRecord, UsageTotals } from '../schemas/index.js';
import { EngineError } from '../util/errors.js';
import { round } from '../util/text.js';

/**
 * Token, cost and latency accounting with a hard ceiling ({{COST_CEILING_USD}}).
 *
 * The ceiling is checked BEFORE every call (`assertBudget`); calls already in flight when it is crossed still finish, so the overshoot is
 * bounded by `concurrency.locales × concurrency.calls_per_locale` calls. Calls with unknown pricing contribute tokens but no cost and are
 * counted in `unpriced_calls` (the ceiling cannot protect against them; the run log says so).
 */
export class CostTracker {
  private readonly records: CallRecord[] = [];
  private tripped = false;

  constructor(readonly ceilingUsd: number) {}

  record(call: CallRecord): void {
    this.records.push(call);
    if (this.spent >= this.ceilingUsd) this.tripped = true;
  }

  get spent(): number {
    return this.records.reduce((sum, c) => sum + (c.cost_usd ?? 0), 0);
  }

  get exceeded(): boolean {
    return this.tripped || this.spent >= this.ceilingUsd;
  }

  /** Throws `EngineError('COST_CEILING')` once the ceiling is reached. */
  assertBudget(): void {
    if (this.exceeded) {
      throw new EngineError('COST_CEILING', `cost ceiling of $${this.ceilingUsd.toFixed(2)} reached (spent $${this.spent.toFixed(4)}); no further model calls are made`, {
        ceiling_usd: this.ceilingUsd,
        spent_usd: round(this.spent, 6),
      });
    }
  }

  calls(): CallRecord[] {
    return this.records.slice();
  }

  totals(filter?: (c: CallRecord) => boolean): UsageTotals {
    const rows = filter ? this.records.filter(filter) : this.records;
    return totalsOf(rows);
  }
}

export function totalsOf(rows: readonly CallRecord[]): UsageTotals {
  return {
    calls: rows.length,
    input_tokens: rows.reduce((s, c) => s + c.input_tokens, 0),
    output_tokens: rows.reduce((s, c) => s + c.output_tokens, 0),
    cost_usd: round(rows.reduce((s, c) => s + (c.cost_usd ?? 0), 0), 6),
    unpriced_calls: rows.filter((c) => c.cost_usd === null).length,
    latency_ms: Math.round(rows.reduce((s, c) => s + c.latency_ms, 0)),
  };
}
