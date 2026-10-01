/** Secret redaction for logs, reports and error messages (spec §9.3: keep secrets in .env, redact keys from all logs). */

const KEY_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /gsk_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /(?:api[_-]?key|authorization|x-api-key)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/gi,
];

export const REDACTED = '[REDACTED]';

/** Builds a function that masks every known secret value and every common API-key shape. */
export function createRedactor(secrets: readonly string[] = []): (text: string) => string {
  const literal = [...new Set(secrets.filter((s) => s.length >= 8))].sort((a, b) => b.length - a.length);
  return (text: string): string => {
    let out = text;
    for (const s of literal) out = out.split(s).join(REDACTED);
    for (const re of KEY_PATTERNS) out = out.replace(re, REDACTED);
    return out;
  };
}

/** Deep-redacts string values of a JSON-like structure (used for run-log `data`). */
export function redactDeep<T>(value: T, redact: (s: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, redact);
    return out as T;
  }
  return value;
}
