import type { LocaleCode, RunLogEntry, Stage } from '../schemas/index.js';
import { createRedactor, redactDeep } from './redact.js';

export interface LogInput {
  code: string;
  message: string;
  stage?: Stage;
  provider?: string;
  locale?: LocaleCode;
  segment_id?: string;
  data?: Record<string, unknown>;
}

/**
 * The run log (spec §6.5 `Run_Log`: timestamps, retries, PARAM_UNSUPPORTED, PROVIDER_ERROR …). Append-only, redacted on the way in,
 * safe to share between parallel locale tasks (JS is single-threaded; entries keep insertion order).
 */
export class RunLog {
  private readonly items: RunLogEntry[] = [];
  private readonly redact: (s: string) => string;

  constructor(
    private readonly now: () => Date,
    secrets: readonly string[] = [],
  ) {
    this.redact = createRedactor(secrets);
  }

  private push(level: RunLogEntry['level'], input: LogInput): void {
    const entry: RunLogEntry = {
      ts: this.now().toISOString(),
      level,
      code: input.code,
      message: this.redact(input.message),
    };
    if (input.stage) entry.stage = input.stage;
    if (input.provider) entry.provider = input.provider;
    if (input.locale) entry.locale = input.locale;
    if (input.segment_id) entry.segment_id = input.segment_id;
    if (input.data) entry.data = redactDeep(input.data, this.redact);
    this.items.push(entry);
  }

  debug(input: LogInput): void {
    this.push('debug', input);
  }
  info(input: LogInput): void {
    this.push('info', input);
  }
  warn(input: LogInput): void {
    this.push('warn', input);
  }
  error(input: LogInput): void {
    this.push('error', input);
  }

  entries(): RunLogEntry[] {
    return this.items.slice();
  }

  /** Number of entries with this code (tests, status decisions). */
  count(code: string): number {
    return this.items.filter((e) => e.code === code).length;
  }
}
