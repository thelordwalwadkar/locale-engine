#!/usr/bin/env node
/**
 * `locale-api` — the REST interface (spec §6.4). A thin adapter over `Engine`: the body is validated with the shared schema,
 * exactly one Engine method runs, its result is returned unchanged. `GET /openapi.json` describes all of it.
 */
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseArgs } from 'node:util';
import { loadDotEnv } from '../config/env.js';
import type { Engine } from '../pipeline/types.js';
import { errorMessage } from '../util/errors.js';
import { toolVersion } from '../util/paths.js';
import { errorDetail, requestIssues, toPublicError, usageError } from './errors.js';
import type { ErrorBody, RequestIssue } from './errors.js';
import { GUARD_MESSAGE, allowedHostnamesFor, guardRejects } from './host-guard.js';
import { REST_ROUTES, buildOpenApiDocument } from './openapi.js';
import type { RestRoute } from './openapi.js';
import { DEFAULT_BODY_LIMIT_BYTES, exitOnFatal, getDefaultEngine, isEntryPoint, parsePort, urlHost } from './runtime.js';
import type { RunningServer } from './runtime.js';

export interface ApiOptions {
  bodyLimitBytes?: number;
  /** Request log (pino, to stderr; level from `LOCALE_LOG_LEVEL`). Off by default so tests stay quiet. */
  logger?: boolean;
  /** Accept only requests whose Host/Origin hostname is listed (DNS-rebinding guard); `startApi` sets it for loopback binds. */
  allowedHosts?: readonly string[];
}

class InvalidRequestError extends Error {
  readonly issues: RequestIssue[];

  constructor(issues: RequestIssue[]) {
    super('invalid request');
    this.issues = issues;
  }
}

const errorBody = (code: string, message: string): ErrorBody => ({ error: { code, message } });

function invalidRequestBody(issues: readonly RequestIssue[]): ErrorBody {
  const shown = issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`);
  const more = issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : '';
  return { error: { code: 'INVALID_REQUEST', message: `request is invalid: ${shown.join('; ')}${more}`, issues: [...issues] } };
}

const asObject = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

/** POST routes take the JSON body; GET routes the query string, with path parameters winning. */
function rawInput(route: RestRoute, request: FastifyRequest): unknown {
  return route.method === 'POST' ? request.body : { ...asObject(request.query), ...asObject(request.params) };
}

/** Fastify's own 4xx (unparseable JSON, wrong content type, body too large) in this API's error shape. */
function parsingError(error: unknown, bodyLimitBytes: number): { status: number; body: ErrorBody } | undefined {
  const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined;
  if (status === undefined || status < 400 || status >= 500) return undefined;
  if (status === 413) return { status, body: errorBody('PAYLOAD_TOO_LARGE', `the request body is over the limit of ${bodyLimitBytes} bytes; send less content or split the page`) };
  if (status === 415) return { status, body: errorBody('UNSUPPORTED_MEDIA_TYPE', 'send the request body as JSON with Content-Type: application/json') };
  return { status, body: errorBody('INVALID_REQUEST', errorMessage(error)) };
}

export function buildApi(engine: Engine, opts: ApiOptions = {}): FastifyInstance {
  const bodyLimit = opts.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  const version = toolVersion();
  const app = Fastify({
    bodyLimit,
    logger: opts.logger ? { level: process.env['LOCALE_LOG_LEVEL'] ?? 'info', stream: process.stderr } : false,
  });

  // Fastify parses text/plain by default, a content type any web page may send cross-origin without a preflight; only JSON is accepted here.
  app.removeContentTypeParser('text/plain');

  const allowed = opts.allowedHosts;
  if (allowed) {
    app.addHook('onRequest', async (request, reply) => {
      if (guardRejects(request.headers, allowed)) return reply.code(403).send(errorBody('HOST_NOT_ALLOWED', GUARD_MESSAGE));
      return undefined;
    });
  }

  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).send(errorBody('NOT_FOUND', `no route ${request.method} ${request.url.split('?')[0]}; GET /openapi.json lists the routes`)),
  );

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof InvalidRequestError) return reply.code(400).send(invalidRequestBody(error.issues));
    const parsing = parsingError(error, bodyLimit);
    if (parsing) return reply.code(parsing.status).send(parsing.body);
    const { status, payload } = toPublicError(error);
    if (status === 500) request.log.error({ detail: errorDetail(error) }, 'request failed');
    return reply.code(status).send({ error: payload });
  });

  app.get('/health', async () => ({ status: 'ok', version }));
  const openapi = buildOpenApiDocument(version);
  app.get('/openapi.json', async () => openapi);

  for (const route of REST_ROUTES) {
    app.route({
      method: route.method,
      url: route.path,
      handler: async (request) => {
        const { cap } = route;
        if (!cap.input) return cap.run(engine, undefined);
        const parsed = cap.input.safeParse(rawInput(route, request));
        if (!parsed.success) throw new InvalidRequestError(requestIssues(parsed.error));
        return cap.run(engine, parsed.data);
      },
    });
  }
  return app;
}

/**
 * Listens on loopback by default. NO AUTHENTICATION is built in: whoever can reach the port can run pipelines with your
 * provider keys and read local files through `kind: 'file'` inputs. Exposing it beyond the machine is the operator's job
 * (reverse proxy with authentication, network policy); binding a non-loopback `host` switches the Host/Origin guard off.
 */
export async function startApi(opts: { engine: Engine; host?: string; port?: number }): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? parsePort(process.env['LOCALE_API_PORT'] ?? '8787', 'LOCALE_API_PORT');
  const allowedHosts = allowedHostnamesFor(host);
  const app = buildApi(opts.engine, { logger: true, ...(allowedHosts ? { allowedHosts } : {}) });
  await app.listen({ host, port });
  const address = app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  return { url: `http://${urlHost(host)}:${boundPort}`, port: boundPort, close: () => app.close() };
}

const USAGE = `Usage: locale-api [--host <address>] [--port <n>]

  --host   address to bind (default 127.0.0.1; no authentication is built in)
  --port   port to listen on (default LOCALE_API_PORT or 8787)

On loopback only localhost, 127.0.0.1 and [::1] are accepted as Host/Origin; LOCALE_ALLOWED_HOSTS=a.example,b.example adds hostnames
(for a reverse proxy on the same machine).
`;

export function parseApiArgs(args: readonly string[]): { help: boolean; host?: string; port?: number } {
  let values: { host?: string | undefined; port?: string | undefined; help?: boolean | undefined };
  try {
    ({ values } = parseArgs({ args: [...args], options: { host: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true }));
  } catch (error) {
    throw usageError(`${errorMessage(error)}\n${USAGE}`);
  }
  return { help: values.help === true, ...(values.host !== undefined ? { host: values.host } : {}), ...(values.port !== undefined ? { port: parsePort(values.port) } : {}) };
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const args = parseApiArgs(argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  loadDotEnv();
  const engine = await getDefaultEngine();
  const running = await startApi({ engine, ...(args.host !== undefined ? { host: args.host } : {}), ...(args.port !== undefined ? { port: args.port } : {}) });
  process.stderr.write(`locale-api listening on ${running.url} (no authentication: keep it on loopback or put a reverse proxy in front)\n`);
  const stop = (): void => void running.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (isEntryPoint(import.meta.url)) main().catch(exitOnFatal);
