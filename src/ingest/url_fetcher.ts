/**
 * Polite, bounded page fetching (spec §7 Phase 3): robots.txt (RFC 9309), a descriptive User-Agent, per-attempt timeout,
 * retry with backoff, manual redirects with the SSRF guard and the robots check re-run on every hop, a response size cap,
 * content-type gating and charset-aware decoding.
 *
 * SSRF guard: `assertPublicUrl` resolves the host (all addresses) and refuses loopback, private, link-local, CGNAT, unique-local,
 * multicast, reserved and unspecified targets, including IPv4-mapped / NAT64 / 6to4 IPv6 forms. Known limit: the name is resolved
 * once for the check and once more by `fetch`; a hostile DNS server could answer differently the second time (DNS rebinding).
 * Closing that needs a pinned connection (a custom undici dispatcher), which is not part of the declared dependencies.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import robotsParserModule from 'robots-parser';
import { getEnv } from '../config/env.js';
import type { SourceOrigin, StagesConfig } from '../schemas/index.js';
import { EngineError, errorMessage } from '../util/errors.js';
import { parseRetryAfter, retry } from '../util/retry.js';
import { decodeBytes, parseContentType } from './charset.js';

interface RobotsRules {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  getMatchingLineNumber(url: string, userAgent?: string): number;
}

/** robots-parser's typings describe an ES default export, but the package is CommonJS (`module.exports = fn`): Node's default import IS the function. */
const robotsParser = robotsParserModule as unknown as (url: string, robotsTxt: string) => RobotsRules;

export type HostLookup = (hostname: string) => Promise<Array<{ address: string }>>;
export type RobotsState = NonNullable<SourceOrigin['robots']>;
export type FetchedFormat = 'html' | 'markdown' | 'text';

export interface FetchOptions {
  ingest: StagesConfig['ingest'];
  /** HTTP client (tests). Default: global `fetch`. */
  fetch?: typeof fetch;
  /** DNS resolver for the SSRF guard (tests). Default: `dns.lookup(host, { all: true })`. */
  lookup?: HostLookup;
  /** Appended to the User-Agent as `; contact: <contact>`. Default: `LOCALE_CONTACT` from the environment. */
  contact?: string;
  /** Backoff sleeper (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Lets loopback / private targets through even when `ingest.block_private_networks` is on (tests, intranet use). */
  allowPrivateNetworks?: boolean;
  now?: () => Date;
}

export interface FetchedPage {
  /** The URL as requested. */
  url: string;
  final_url: string;
  /** Every URL visited, first request first. */
  chain: string[];
  status: number;
  /** The `Content-Type` header as sent, when there was one. */
  content_type?: string;
  format: FetchedFormat;
  body: string;
  fetched_at: string;
  robots: RobotsState;
  warnings: string[];
}

const MAX_REDIRECTS = 5;
/** RFC 9309 asks crawlers to parse at least 500 KiB of robots.txt; the rest is ignored. */
const ROBOTS_MAX_BYTES = 512 * 1024;
/** A server asking for a longer pause than this is reported instead of waited for. */
const MAX_RETRY_AFTER_MS = 30_000;
const ACCEPT = 'text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,*/*;q=0.1';
const EMPTY = new Uint8Array(0);

// ---------------------------------------------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------------------------------------------

interface Range {
  base: number[];
  bits: number;
  label: string;
}

const v4 = (a: number, b: number, c: number, d: number, bits: number, label: string): Range => ({ base: [a, b, c, d], bits, label });
const BLOCKED_V4: Range[] = [
  v4(0, 0, 0, 0, 8, 'an unspecified or "this network" address'),
  v4(10, 0, 0, 0, 8, 'a private address (10.0.0.0/8)'),
  v4(100, 64, 0, 0, 10, 'a carrier-grade NAT address (100.64.0.0/10)'),
  v4(127, 0, 0, 0, 8, 'a loopback address'),
  v4(169, 254, 0, 0, 16, 'a link-local address (cloud metadata endpoints live here)'),
  v4(172, 16, 0, 0, 12, 'a private address (172.16.0.0/12)'),
  v4(192, 0, 0, 0, 24, 'an IETF-reserved address'),
  v4(192, 168, 0, 0, 16, 'a private address (192.168.0.0/16)'),
  v4(198, 18, 0, 0, 15, 'a benchmarking address'),
  v4(224, 0, 0, 0, 4, 'a multicast address'),
  v4(240, 0, 0, 0, 4, 'a reserved or broadcast address'),
];

const v6 = (hex: string, bits: number, label: string): Range => ({ base: parseIPv6(hex) ?? [], bits, label });
const BLOCKED_V6: Range[] = [
  v6('::', 96, 'an unspecified, loopback or IPv4-compatible address'),
  v6('fc00::', 7, 'a unique-local address (fc00::/7)'),
  v6('fe80::', 10, 'a link-local address (fe80::/10)'),
  v6('fec0::', 10, 'a deprecated site-local address'),
  v6('ff00::', 8, 'a multicast address'),
  v6('2001::', 32, 'a Teredo tunnel address'),
  v6('64:ff9b:1::', 48, 'a local-use NAT64 address'),
];

function parseIPv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

/** 16 bytes of an IPv6 address (`::` compression, embedded dotted IPv4 and a zone id are understood). */
function parseIPv6(input: string): number[] | null {
  let s = input.includes('%') ? input.slice(0, input.indexOf('%')) : input;
  let tail: number[] | null = null;
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    tail = parseIPv4(s.slice(cut + 1));
    if (!tail) return null;
    s = `${s.slice(0, cut + 1)}0:0`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  const head = groups(halves[0] ?? '');
  const rest = halves.length === 2 ? groups(halves[1] ?? '') : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...rest];
  const bytes = all.flatMap((g) => [g >> 8, g & 0xff]);
  if (tail) bytes.splice(12, 4, ...tail);
  return bytes;
}

function inRange(bytes: readonly number[], r: Range): boolean {
  if (r.base.length === 0) return false;
  for (let bit = 0; bit < r.bits; bit += 8) {
    const n = Math.min(8, r.bits - bit);
    const mask = (0xff << (8 - n)) & 0xff;
    const i = bit / 8;
    if (((bytes[i] ?? 0) & mask) !== ((r.base[i] ?? 0) & mask)) return false;
  }
  return true;
}

function blockedV4(bytes: readonly number[]): string | undefined {
  return BLOCKED_V4.find((r) => inRange(bytes, r))?.label;
}

/** Why `address` must not be fetched, or `undefined` when it is a public address. Unparsable input is refused. */
export function blockedReason(address: string): string | undefined {
  const family = isIP(address.includes('%') ? address.slice(0, address.indexOf('%')) : address);
  if (family === 4) return blockedV4(parseIPv4(address) ?? []);
  if (family !== 6) return 'not a valid IP address';
  const bytes = parseIPv6(address);
  if (!bytes) return 'not a valid IP address';
  const embedded = (from: number, what: string): string | undefined => {
    const inner = blockedV4(bytes.slice(from, from + 4));
    return inner ? `${what} of ${inner}` : undefined;
  };
  const isMapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isMapped) return embedded(12, 'an IPv4-mapped address');
  if (bytes.slice(0, 12).join() === [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0].join()) return embedded(12, 'a NAT64 address');
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return embedded(2, 'a 6to4 address');
  return BLOCKED_V6.find((r) => inRange(bytes, r))?.label;
}

const defaultLookup: HostLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Scheme and credentials checks that apply even when the private-network guard is switched off. */
export function assertFetchableUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch (e) {
    throw new EngineError('INPUT_INVALID', `not a valid URL: ${String(raw)}`, { url: String(raw) }, e);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EngineError('URL_BLOCKED', `only http and https URLs can be fetched (got "${url.protocol}")`, { url: url.href });
  }
  if (url.username !== '' || url.password !== '') {
    throw new EngineError('URL_BLOCKED', 'URLs with embedded credentials are not fetched', { url: `${url.origin}${url.pathname}` });
  }
  return url;
}

/** Throws `URL_BLOCKED` unless every address the host resolves to is public. */
export async function assertPublicUrl(raw: string | URL, lookup: HostLookup = defaultLookup): Promise<void> {
  const url = assertFetchableUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host) !== 0;
  let addresses: string[];
  if (literal) addresses = [host];
  else {
    let found: Array<{ address: string }>;
    try {
      found = await lookup(host);
    } catch (e) {
      throw new EngineError('FETCH_FAILED', `could not resolve host "${host}": ${errorMessage(e)}`, { url: url.href }, e);
    }
    if (found.length === 0) throw new EngineError('FETCH_FAILED', `host "${host}" has no IP address`, { url: url.href });
    addresses = found.map((a) => a.address);
  }
  for (const address of addresses) {
    const reason = blockedReason(address);
    if (reason !== undefined) {
      const subject = literal ? `"${host}" is` : `"${host}" resolves to ${address}, which is`;
      throw new EngineError('URL_BLOCKED', `${subject} ${reason}; refusing to fetch (SSRF guard, see ingest.block_private_networks)`, {
        url: url.href,
        address,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------------------------------------------

/** Network errors, timeouts, 429 and 5xx: worth another attempt. */
class TransientFetchError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TransientFetchError';
  }
}

interface RawResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

interface FetchContext {
  cfg: StagesConfig['ingest'];
  fetchFn: typeof fetch;
  userAgent: string;
  robotsToken: string;
  sleep: ((ms: number) => Promise<void>) | undefined;
  guard: (url: URL) => Promise<void>;
  robots: Map<string, RobotsEntry>;
}

interface RobotsEntry {
  robot: RobotsRules | null;
  /** Why there are no rules (HTTP status or reason); only set when `robot` is null. */
  unavailable?: string;
}

export function userAgentFor(ingest: Pick<StagesConfig['ingest'], 'user_agent'>, contact?: string): string {
  const c = (contact ?? getEnv('LOCALE_CONTACT'))?.replace(/[\r\n]+/g, ' ').trim();
  return c ? `${ingest.user_agent}; contact: ${c}` : ingest.user_agent;
}

const isRedirect = (status: number): boolean => [301, 302, 303, 307, 308].includes(status);

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* the connection is being dropped anyway */
  }
}

/** Reads the body, stopping at `maxBytes`: a failure for pages, silent truncation for robots.txt. */
async function readCapped(res: Response, url: string, maxBytes: number, overflow: 'fail' | 'truncate'): Promise<Uint8Array> {
  const tooLarge = (): EngineError =>
    new EngineError('FETCH_FAILED', `response from ${url} is larger than the ingest.max_bytes limit of ${maxBytes} bytes`, {
      url,
      max_bytes: maxBytes,
    });
  const declared = Number(res.headers.get('content-length'));
  if (overflow === 'fail' && Number.isFinite(declared) && declared > maxBytes) {
    await discard(res);
    throw tooLarge();
  }
  if (!res.body) return EMPTY;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined);
      if (overflow === 'fail') throw tooLarge();
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return concat(chunks, total);
}

function transient(e: unknown, url: URL, timeoutMs: number): TransientFetchError {
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return new TransientFetchError(`request to ${url.href} timed out after ${timeoutMs} ms`);
  }
  const cause = (e as { cause?: { code?: string; message?: string } } | null)?.cause;
  return new TransientFetchError(`network error for ${url.href}: ${cause?.code ?? cause?.message ?? errorMessage(e)}`);
}

async function requestOnce(
  url: URL,
  ctx: FetchContext,
  wantBody: (status: number) => boolean,
  maxBytes: number,
  overflow: 'fail' | 'truncate',
): Promise<RawResponse> {
  const timeoutMs = ctx.cfg.timeout_ms;
  let res: Response;
  try {
    res = await ctx.fetchFn(url.href, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': ctx.userAgent, accept: ACCEPT },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw transient(e, url, timeoutMs);
  }
  try {
    const status = res.status;
    if (status === 429 || status >= 500) {
      await discard(res);
      const wait = parseRetryAfter(res.headers.get('retry-after'));
      if (wait !== undefined && wait > MAX_RETRY_AFTER_MS) {
        throw new EngineError('FETCH_FAILED', `HTTP ${status} from ${url.href}; the server asks to retry after ${Math.round(wait / 1000)} s, which is too long to wait`, {
          url: url.href,
          status,
        });
      }
      throw new TransientFetchError(`HTTP ${status} from ${url.href}`, wait);
    }
    if (!wantBody(status)) {
      await discard(res);
      return { status, headers: res.headers, body: EMPTY };
    }
    return { status, headers: res.headers, body: await readCapped(res, url.href, maxBytes, overflow) };
  } catch (e) {
    if (e instanceof EngineError || e instanceof TransientFetchError) throw e;
    throw transient(e, url, timeoutMs);
  }
}

async function requestWithRetry(
  url: URL,
  ctx: FetchContext,
  wantBody: (status: number) => boolean,
  maxBytes: number,
  overflow: 'fail' | 'truncate' = 'fail',
): Promise<RawResponse> {
  const attempts = ctx.cfg.max_retries + 1;
  try {
    return await retry(() => requestOnce(url, ctx, wantBody, maxBytes, overflow), {
      retries: ctx.cfg.max_retries,
      baseMs: ctx.cfg.backoff_ms,
      shouldRetry: (e) => e instanceof TransientFetchError,
      sleep: ctx.sleep,
    });
  } catch (e) {
    if (e instanceof TransientFetchError) {
      throw new EngineError('FETCH_FAILED', `${e.message} (gave up after ${attempts} attempt${attempts === 1 ? '' : 's'})`, { url: url.href, attempts }, e);
    }
    throw e;
  }
}

const is2xx = (status: number): boolean => status >= 200 && status < 300;

// ---------------------------------------------------------------------------------------------------------------
// robots.txt (RFC 9309)
// ---------------------------------------------------------------------------------------------------------------

/** 2xx: parse. 4xx (or an endless redirect chain): "unavailable", everything is allowed. 5xx / unreachable: disallow everything. */
async function loadRobots(page: URL, ctx: FetchContext): Promise<RobotsEntry> {
  const robotsUrl = new URL('/robots.txt', page.origin);
  let current = robotsUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await ctx.guard(current);
    let res: RawResponse;
    try {
      res = await requestWithRetry(current, ctx, is2xx, ROBOTS_MAX_BYTES, 'truncate');
    } catch (e) {
      if (e instanceof EngineError && e.code === 'FETCH_FAILED') {
        throw new EngineError(
          'ROBOTS_DISALLOWED',
          `robots.txt of ${page.origin} could not be read (${e.message}); RFC 9309 says an unreachable robots.txt means everything is disallowed (set ingest.respect_robots: false to skip the check)`,
          { origin: page.origin },
          e,
        );
      }
      throw e;
    }
    if (is2xx(res.status)) {
      return { robot: robotsParser(robotsUrl.href, new TextDecoder('utf-8').decode(res.body)) };
    }
    if (!isRedirect(res.status)) return { robot: null, unavailable: `HTTP ${res.status}` };
    const location = res.headers.get('location');
    if (!location) return { robot: null, unavailable: `HTTP ${res.status} without a Location header` };
    current = assertFetchableUrl(new URL(location, current));
  }
  return { robot: null, unavailable: 'too many redirects' };
}

async function checkRobots(url: URL, ctx: FetchContext, warnings: string[]): Promise<RobotsState> {
  let entry = ctx.robots.get(url.origin);
  if (!entry) {
    entry = await loadRobots(url, ctx);
    ctx.robots.set(url.origin, entry);
    if (!entry.robot) {
      warnings.push(`robots.txt of ${url.origin} is not available (${entry.unavailable ?? 'unknown'}); fetching is allowed when no robots.txt exists (RFC 9309)`);
    }
  }
  if (!entry.robot) return 'unknown';
  if (entry.robot.isAllowed(url.href, ctx.robotsToken) === false) {
    const line = entry.robot.getMatchingLineNumber(url.href, ctx.robotsToken);
    throw new EngineError(
      'ROBOTS_DISALLOWED',
      `robots.txt of ${url.origin} disallows fetching ${url.pathname}${url.search} for user agent "${ctx.robotsToken}"${line > 0 ? ` (line ${line})` : ''}`,
      { url: url.href, origin: url.origin },
    );
  }
  return 'allowed';
}

// ---------------------------------------------------------------------------------------------------------------
// Content negotiation
// ---------------------------------------------------------------------------------------------------------------

/** No Content-Type: text that looks like markup is HTML, other text is plain, binary is refused. */
function sniffFormat(bytes: Uint8Array, url: string): FetchedFormat {
  const head = bytes.subarray(0, 1024);
  if (head.includes(0)) throw new EngineError('UNSUPPORTED_FORMAT', `${url} sent binary content without a Content-Type`, { url });
  const text = new TextDecoder('latin1').decode(head);
  return /<(?:!doctype\s+html|html|head|body|title|h1|p|div)\b/i.test(text) ? 'html' : 'text';
}

function formatFor(mediaType: string, bytes: Uint8Array, url: string): FetchedFormat {
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') return 'html';
  if (mediaType === 'text/markdown' || mediaType === 'text/x-markdown') return 'markdown';
  if (mediaType === 'text/plain') return 'text';
  if (mediaType === '') return sniffFormat(bytes, url);
  throw new EngineError('UNSUPPORTED_FORMAT', `unsupported content type "${mediaType}" for ${url}; supported: HTML, Markdown and plain text`, {
    url,
    content_type: mediaType,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------

export async function fetchPage(rawUrl: string, opts: FetchOptions): Promise<FetchedPage> {
  const cfg = opts.ingest;
  const lookup = opts.lookup ?? defaultLookup;
  const guarded = cfg.block_private_networks && opts.allowPrivateNetworks !== true;
  const userAgent = userAgentFor(cfg, opts.contact);
  const ctx: FetchContext = {
    cfg,
    fetchFn: opts.fetch ?? fetch,
    userAgent,
    robotsToken: cfg.user_agent.split(/[\s/;(]/)[0] ?? 'locale-engine',
    sleep: opts.sleep,
    guard: guarded ? (u) => assertPublicUrl(u, lookup) : async () => undefined,
    robots: new Map(),
  };

  const warnings: string[] = [];
  let robots: RobotsState = cfg.respect_robots ? 'allowed' : 'not_applicable';
  let current = assertFetchableUrl(rawUrl);
  const chain = [current.href];

  for (let hop = 0; ; hop++) {
    await ctx.guard(current);
    if (cfg.respect_robots && (await checkRobots(current, ctx, warnings)) === 'unknown') robots = 'unknown';

    const res = await requestWithRetry(current, ctx, is2xx, cfg.max_bytes);
    if (isRedirect(res.status)) {
      if (hop >= MAX_REDIRECTS) {
        throw new EngineError('FETCH_FAILED', `too many redirects (more than ${MAX_REDIRECTS}) starting at ${rawUrl}`, { url: rawUrl, chain });
      }
      const location = res.headers.get('location');
      if (!location) throw new EngineError('FETCH_FAILED', `HTTP ${res.status} redirect without a Location header from ${current.href}`, { url: current.href });
      let next: URL;
      try {
        next = new URL(location, current);
      } catch (e) {
        throw new EngineError('FETCH_FAILED', `redirect from ${current.href} to an invalid Location "${location}"`, { url: current.href }, e);
      }
      current = assertFetchableUrl(next);
      chain.push(current.href);
      continue;
    }
    if (!is2xx(res.status)) {
      throw new EngineError('FETCH_FAILED', `HTTP ${res.status} from ${current.href}`, { url: current.href, status: res.status });
    }

    const contentType = res.headers.get('content-type') ?? undefined;
    const format = formatFor(parseContentType(contentType).mediaType, res.body, current.href);
    const decoded = decodeBytes(res.body, { contentType, sniffMeta: format === 'html' });
    warnings.push(...decoded.warnings);
    const page: FetchedPage = {
      url: rawUrl,
      final_url: current.href,
      chain,
      status: res.status,
      format,
      body: decoded.text,
      fetched_at: (opts.now ? opts.now() : new Date()).toISOString(),
      robots,
      warnings,
    };
    if (contentType !== undefined) page.content_type = contentType;
    return page;
  }
}
