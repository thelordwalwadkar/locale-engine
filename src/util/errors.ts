/** Engine-level error with a stable machine-readable code (interfaces map it to exit codes / HTTP status / MCP errors). */
export type EngineErrorCode =
  | 'CONFIG_INVALID'
  | 'INPUT_INVALID'
  | 'FETCH_FAILED'
  | 'ROBOTS_DISALLOWED'
  | 'URL_BLOCKED'
  | 'UNSUPPORTED_FORMAT'
  | 'UNSUPPORTED_ROUTE'
  | 'COST_CEILING'
  | 'PROVIDER_UNAVAILABLE'
  | 'RUN_NOT_FOUND'
  | 'INTERNAL';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: EngineErrorCode, message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'EngineError';
    this.code = code;
    if (details) this.details = details;
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
