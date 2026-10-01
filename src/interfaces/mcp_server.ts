#!/usr/bin/env node
/**
 * `locale-mcp` — the MCP server (spec §6.4): stdio by default, streamable HTTP with `--http`. A thin adapter over `Engine`:
 * every tool takes the shared request schema, calls exactly one Engine method and returns its result as `structuredContent`
 * plus a text block (short summary + the JSON). Failures are tool results with `isError: true`, never protocol errors.
 *
 * STDIO HYGIENE: in stdio mode stdout carries only protocol frames. Nothing here writes to stdout; logs go to stderr.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadDotEnv } from '../config/env.js';
import type { Engine } from '../pipeline/types.js';
import { errorMessage } from '../util/errors.js';
import { toolVersion } from '../util/paths.js';
import { ALL_CAPABILITIES, inputJsonSchema, outputJsonSchema } from './capabilities.js';
import type { AnyCapability, JsonObject, JsonSchema } from './capabilities.js';
import { errorDetail, toPublicError, usageError } from './errors.js';
import { GUARD_MESSAGE, allowedHostnamesFor, guardRejects } from './host-guard.js';
import { DEFAULT_BODY_LIMIT_BYTES, exitOnFatal, getDefaultEngine, isEntryPoint, parsePort, urlHost } from './runtime.js';
import type { RunningServer } from './runtime.js';

export interface McpServerOptions {
  /** Where unexpected errors are logged (never shown to the caller). Default: stderr. */
  log?: (line: string) => void;
}

const logToStderr = (line: string): void => void process.stderr.write(`${line}\n`);

function toolResult(cap: AnyCapability, result: JsonObject): CallToolResult {
  return { content: [{ type: 'text', text: `${cap.summarize(result)}\n\n${JSON.stringify(result)}` }], structuredContent: result };
}

/** No `structuredContent` on purpose: MCP clients validate it against the tool's output schema, which a failure does not satisfy. */
function toolFailure(error: unknown, log: (line: string) => void): CallToolResult {
  const { status, payload } = toPublicError(error);
  if (status === 500) log(errorDetail(error));
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function registerCapability(server: McpServer, engine: Engine, cap: AnyCapability, log: (line: string) => void): void {
  const call = async (args: unknown): Promise<CallToolResult> => {
    try {
      return toolResult(cap, await cap.run(engine, args));
    } catch (error) {
      return toolFailure(error, log);
    }
  };
  const config = {
    title: cap.title,
    description: cap.description,
    outputSchema: cap.output,
    annotations: cap.readOnly
      ? { readOnlyHint: true, openWorldHint: false }
      : { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  };
  // A tool without arguments is registered without an input schema: the SDK then also accepts a call that omits `arguments`.
  if (cap.input) server.registerTool(cap.name, { ...config, inputSchema: cap.input }, (args) => call(args));
  else server.registerTool(cap.name, config, () => call(undefined));
}

export function buildMcpServer(engine: Engine, opts: McpServerOptions = {}): McpServer {
  const log = opts.log ?? logToStderr;
  const server = new McpServer({ name: 'locale-engine', version: toolVersion() });
  for (const cap of ALL_CAPABILITIES) registerCapability(server, engine, cap, log);
  return server;
}

export interface McpToolDescription {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

/** The tools as a client sees them in `tools/list` (the README snippet generator and the parity test use this). */
export function describeMcpTools(): McpToolDescription[] {
  return ALL_CAPABILITIES.map((cap) => ({
    name: cap.name,
    title: cap.title,
    description: cap.description,
    inputSchema: inputJsonSchema(cap),
    outputSchema: outputJsonSchema(cap),
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------------------------------------------

export async function startStdio(engine: Engine, io: { stdin?: Readable; stdout?: Writable } = {}): Promise<McpServer> {
  const server = buildMcpServer(engine);
  await server.connect(new StdioServerTransport(io.stdin, io.stdout));
  return server;
}

/** stdout is the protocol channel in stdio mode: a dependency's `console.log` would corrupt it. Returns the undo (tests). */
export function routeConsoleToStderr(): () => void {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  const toStderr = (...args: unknown[]): void => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  return () => {
    console.log = saved.log;
    console.info = saved.info;
    console.debug = saved.debug;
  };
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

export interface HttpOptions {
  engine: Engine;
  host?: string;
  port?: number;
  path?: string;
  log?: (line: string) => void;
}

/**
 * Streamable HTTP, stateless: every POST gets its own server and transport (the tools are plain request/response, so there is
 * no session to keep). Binds loopback by default and, like the REST API, has NO AUTHENTICATION: a non-loopback `host` is the
 * operator's decision and needs a reverse proxy in front.
 */
export async function startHttp(opts: HttpOptions): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? parsePort(process.env['LOCALE_MCP_PORT'] ?? '8788', 'LOCALE_MCP_PORT');
  const path = opts.path ?? '/mcp';
  const log = opts.log ?? logToStderr;
  const allowed = allowedHostnamesFor(host);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.url ?? '').split('?')[0] !== path) return sendJsonRpcError(res, 404, `no such endpoint; the MCP endpoint is ${path}`);
    if (allowed && guardRejects({ host: req.headers.host, origin: req.headers.origin }, allowed)) {
      return sendJsonRpcError(res, 403, GUARD_MESSAGE);
    }
    if (req.method !== 'POST') return sendJsonRpcError(res, 405, 'use POST: this server is stateless and has no event stream', { Allow: 'POST' });
    const server = buildMcpServer(opts.engine, { log });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, maxRequestBodySize: DEFAULT_BODY_LIMIT_BYTES });
    res.on('close', () => {
      server.close().catch((error: unknown) => log(errorDetail(error)));
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log(errorDetail(error));
      if (!res.headersSent) sendJsonRpcError(res, 500, 'internal error; the server log has the details');
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const address = http.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  return {
    url: `http://${urlHost(host)}:${boundPort}${path}`,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Bin
// ---------------------------------------------------------------------------------------------------------------

const USAGE = `Usage: locale-mcp [--http [--host <address>] [--port <n>] [--path <path>]]

  (no flags)  speak MCP over stdio (for Claude Desktop, Claude Code and other MCP clients)
  --http      speak MCP over streamable HTTP instead (default 127.0.0.1:8788/mcp; LOCALE_MCP_PORT sets the port)
  --host      address to bind (no authentication is built in: keep it on loopback or put a reverse proxy in front)
  --port      port to listen on
  --path      endpoint path (default /mcp)

On loopback only localhost, 127.0.0.1 and [::1] are accepted as Host/Origin; LOCALE_ALLOWED_HOSTS=a.example,b.example adds hostnames
(for a reverse proxy on the same machine).
`;

export type McpArgs = { mode: 'help' } | { mode: 'stdio' } | { mode: 'http'; listen: { host?: string; port?: number; path?: string } };

function parseFlags(args: readonly string[]) {
  try {
    return parseArgs({
      args: [...args],
      options: { http: { type: 'boolean' }, host: { type: 'string' }, port: { type: 'string' }, path: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
    }).values;
  } catch (error) {
    throw usageError(`${errorMessage(error)}\n${USAGE}`);
  }
}

export function parseMcpArgs(args: readonly string[]): McpArgs {
  const values = parseFlags(args);
  if (values.help) return { mode: 'help' };
  if (!values.http) {
    if (values.host !== undefined || values.port !== undefined || values.path !== undefined) {
      throw usageError(`--host, --port and --path only apply with --http\n${USAGE}`);
    }
    return { mode: 'stdio' };
  }
  if (values.path !== undefined && !values.path.startsWith('/')) throw usageError(`--path must start with '/', got '${values.path}'`);
  return {
    mode: 'http',
    listen: {
      ...(values.host !== undefined ? { host: values.host } : {}),
      ...(values.port !== undefined ? { port: parsePort(values.port) } : {}),
      ...(values.path !== undefined ? { path: values.path } : {}),
    },
  };
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const args = parseMcpArgs(argv.slice(2));
  if (args.mode === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (args.mode === 'stdio') routeConsoleToStderr();
  loadDotEnv();
  const engine = await getDefaultEngine();
  if (args.mode === 'stdio') {
    await startStdio(engine);
    return;
  }
  const running = await startHttp({ engine, ...args.listen });
  process.stderr.write(`locale-mcp listening on ${running.url} (no authentication: keep it on loopback or put a reverse proxy in front)\n`);
  const stop = (): void => void running.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (isEntryPoint(import.meta.url)) main().catch(exitOnFatal);
