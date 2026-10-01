/** Retry with exponential backoff and jitter (used by URL fetching and provider adapters). */

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  /** Number of RETRIES after the first attempt (total attempts = retries + 1). */
  retries: number;
  baseMs: number;
  factor?: number;
  maxMs?: number;
  /** Full jitter (random in [0, delay]). Default true. Tests pass false. */
  jitter?: boolean;
  /** Return false to stop retrying for this error. Default: always retry. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before sleeping. `delayMs` already includes a server-provided Retry-After if the error exposes `retryAfterMs`. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Injectable sleeper (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export function backoffDelay(attempt: number, baseMs: number, factor = 2, maxMs = 30_000, jitter = true): number {
  const raw = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt - 1));
  return jitter ? Math.round(Math.random() * raw) : raw;
}

/** Parse an HTTP `Retry-After` header (seconds or HTTP-date) into milliseconds; undefined if absent/invalid. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.max(0, when - now) : undefined;
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const wait = opts.sleep ?? sleep;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt > opts.retries || (opts.shouldRetry && !opts.shouldRetry(error, attempt))) throw error;
      const hinted = (error as { retryAfterMs?: number } | null)?.retryAfterMs;
      const delay = Math.max(hinted ?? 0, backoffDelay(attempt, opts.baseMs, opts.factor, opts.maxMs, opts.jitter ?? true));
      opts.onRetry?.(error, attempt, delay);
      await wait(delay);
    }
  }
}
