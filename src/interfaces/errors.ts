/**
 * Error handling shared by the CLI, the REST API and the MCP server: engine error -> HTTP status / public payload,
 * request-validation issues, secret redaction, process exit codes.
 */
import { z } from 'zod';
import { secretValues } from '../config/env.js';
import { EngineError } from '../util/errors.js';
import type { EngineErrorCode } from '../util/errors.js';

/** Process exit codes of the bins (CLI spec: 0 ok, 1 runtime error, 2 usage error, 3 cost ceiling, 4 `--strict` FAIL). */
export const EXIT = { OK: 0, FAILURE: 1, USAGE: 2, COST_CEILING: 3, STRICT: 4 } as const;

/** A failure that ends the process with a chosen exit code; `message` goes to stderr. */
export class ExitError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'ExitError';
    this.exitCode = exitCode;
  }
}

export const usageError = (message: string): ExitError => new ExitError(message, EXIT.USAGE);

/** HTTP status of the engine errors a caller can cause or fix; every other code is a 500 (see `toPublicError`). */
const HTTP_STATUS: Partial<Record<EngineErrorCode, number>> = {
  INPUT_INVALID: 400,
  RUN_NOT_FOUND: 404,
  UNSUPPORTED_FORMAT: 415,
  URL_BLOCKED: 422,
  ROBOTS_DISALLOWED: 422,
  COST_CEILING: 422,
  UNSUPPORTED_ROUTE: 422,
  FETCH_FAILED: 502,
  PROVIDER_UNAVAILABLE: 503,
};

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface PublicError {
  status: number;
  payload: ErrorPayload;
}

const INTERNAL_MESSAGE = 'internal error; the server log has the details';

/** Replaces the value of every credential-looking environment variable (`*_KEY`, `*_TOKEN`, …) in `text`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of secretValues()) out = out.split(secret).join('[REDACTED]');
  return out;
}

/** Everything known about an error (stack included) for a server log or `LOCALE_DEBUG=1`; never for a caller. */
export function errorDetail(error: unknown): string {
  const text = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  return redactSecrets(text);
}

/**
 * What a remote caller (REST client, MCP client) may learn about a failure: the engine's own message for errors the caller
 * can act on; a generic message for everything else (no stack, no internals, no secrets).
 */
export function toPublicError(error: unknown): PublicError {
  if (error instanceof EngineError) {
    const status = HTTP_STATUS[error.code];
    if (status !== undefined) return { status, payload: { code: error.code, message: redactSecrets(error.message) } };
  }
  return { status: 500, payload: { code: 'INTERNAL', message: INTERNAL_MESSAGE } };
}

// ---------------------------------------------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------------------------------------------

export interface RequestIssue {
  path: string;
  message: string;
}

type ZodIssue = z.ZodError['issues'][number];

const depth = (issues: readonly ZodIssue[]): number => Math.max(0, ...issues.map((i) => i.path.length));

/** Of the branches of a failed union, the one that matched furthest into the value: its errors are the useful ones. */
const furthestBranch = (branches: readonly (readonly ZodIssue[])[]): readonly ZodIssue[] =>
  branches.reduce((best, branch) => (depth(branch) > depth(best) ? branch : best));

/** Flattens Zod issues into `{path, message}`; `path` is dotted (`options.pass_threshold`, `targets.0`), `(root)` for the body itself. */
export function requestIssues(error: z.ZodError): RequestIssue[] {
  const out: RequestIssue[] = [];
  const visit = (issues: readonly ZodIssue[], prefix: readonly PropertyKey[]): void => {
    for (const issue of issues) {
      const path = [...prefix, ...issue.path];
      if (issue.code === 'invalid_union' && issue.errors.length > 0) visit(furthestBranch(issue.errors), path);
      else out.push({ path: path.map(String).join('.') || '(root)', message: issue.message });
    }
  };
  visit(error.issues, []);
  return out;
}

/** Body of every REST error response (also the shape documented in `/openapi.json`). */
export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string().describe('Stable machine-readable code, e.g. INVALID_REQUEST, INPUT_INVALID, RUN_NOT_FOUND, INTERNAL.'),
    message: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional().describe('INVALID_REQUEST only: one entry per invalid field.'),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
