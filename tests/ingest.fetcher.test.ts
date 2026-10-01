import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFetchableUrl, assertPublicUrl, blockedReason, fetchPage, userAgentFor, type FetchOptions, type HostLookup } from '../src/ingest/url_fetcher.js';
import { EngineError } from '../src/util/errors.js';
import { stages } from './fixtures/ingest/deps.js';
import { fakeFetch, publicLookup } from './fixtures/ingest/fake-fetch.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const routes = new Map<string, Handler>();
const hits: Array<{ path: string; headers: IncomingMessage['headers'] }> = [];
const sleeps: number[] = [];
const sleep = async (ms: number): Promise<void> => void sleeps.push(ms);
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    hits.push({ path: url, headers: req.headers });
    const handler = routes.get(url.split('?')[0] ?? '/');
    if (handler) handler(req, res);
    else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  routes.clear();
  hits.length = 0;
  sleeps.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

const html = (body: string, type = 'text/html; charset=utf-8'): Handler => (_req, res) => {
  res.writeHead(200, { 'content-type': type });
  res.end(body);
};
const setRobots = (txt: string): void => void routes.set('/robots.txt', html(txt, 'text/plain'));
const pageHits = (): string[] => hits.filter((h) => h.path !== '/robots.txt').map((h) => h.path);
const config = (over: Partial<typeof stages.ingest> = {}): typeof stages.ingest => ({
  ...stages.ingest,
  block_private_networks: false,
  max_retries: 2,
  backoff_ms: 1,
  timeout_ms: 3000,
  ...over,
});
const get = (path: string, over: Partial<typeof stages.ingest> = {}, extra: Partial<FetchOptions> = {}) =>
  fetchPage(`${base}${path}`, { ingest: config(over), sleep, ...extra });
async function failure(p: Promise<unknown>): Promise<EngineError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EngineError);
  return err as EngineError;
}

describe('fetchPage: basics', () => {
  it('returns the decoded page with status, content type, time and robots state', async () => {
    setRobots('User-agent: *\nDisallow: /private/');
    routes.set('/page', html('<html><body><p>Hallo wereld</p></body></html>'));
    const now = () => new Date('2026-09-30T12:34:56.000Z');
    const page = await get('/page', {}, { now });
    expect(page).toEqual({
      url: `${base}/page`,
      final_url: `${base}/page`,
      chain: [`${base}/page`],
      status: 200,
      content_type: 'text/html; charset=utf-8',
      format: 'html',
      body: '<html><body><p>Hallo wereld</p></body></html>',
      fetched_at: '2026-09-30T12:34:56.000Z',
      robots: 'allowed',
      warnings: [],
    });
    expect(hits.map((h) => h.path)).toEqual(['/robots.txt', '/page']);
  });

  it('refuses invalid URLs and non-http schemes even with the private-network guard off', async () => {
    expect((await failure(fetchPage('not a url', { ingest: config() }))).code).toBe('INPUT_INVALID');
    for (const url of ['ftp://example.com/x', 'file:///etc/passwd', 'gopher://example.com/', 'javascript:alert(1)']) {
      expect((await failure(fetchPage(url, { ingest: config(), sleep }))).code).toBe('URL_BLOCKED');
    }
  });

  it('accepts an empty body (ingestion decides whether that is content)', async () => {
    routes.set('/empty', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end();
    });
    expect((await get('/empty', { respect_robots: false })).body).toBe('');
  });
});

describe('fetchPage: robots.txt (RFC 9309)', () => {
  it('refuses a disallowed path before requesting it, and names the rule', async () => {
    setRobots('User-agent: *\nDisallow: /private/');
    routes.set('/private/secret', html('<p>geheim</p>'));
    const err = await failure(get('/private/secret'));
    expect(err.code).toBe('ROBOTS_DISALLOWED');
    expect(err.message).toContain('/private/secret');
    expect(err.message).toContain('(line 2)');
    expect(pageHits()).toEqual([]);
  });

  it('obeys rules addressed to our product token and ignores other bots', async () => {
    routes.set('/page', html('<p>ok</p>'));
    setRobots('User-agent: somebot\nDisallow: /\n');
    expect((await get('/page')).robots).toBe('allowed');
    setRobots('User-agent: locale-engine\nDisallow: /\n\nUser-agent: *\nAllow: /\n');
    expect((await failure(get('/page'))).code).toBe('ROBOTS_DISALLOWED');
    setRobots('User-agent: *\nDisallow: /\nAllow: /page\n');
    expect((await get('/page')).robots).toBe('allowed');
  });

  it.each([404, 403, 410])('treats HTTP %i for robots.txt as "no restrictions", reported as unknown with a warning', async (status) => {
    routes.set('/robots.txt', (_req, res) => {
      res.writeHead(status);
      res.end();
    });
    routes.set('/page', html('<p>ok</p>'));
    const page = await get('/page');
    expect(page.robots).toBe('unknown');
    expect(page.warnings).toEqual([`robots.txt of ${base} is not available (HTTP ${status}); fetching is allowed when no robots.txt exists (RFC 9309)`]);
    expect(page.body).toBe('<p>ok</p>');
  });

  it('treats a server error for robots.txt as "disallow everything", after retrying', async () => {
    routes.set('/robots.txt', (_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    routes.set('/page', html('<p>ok</p>'));
    const err = await failure(get('/page'));
    expect(err.code).toBe('ROBOTS_DISALLOWED');
    expect(err.message).toContain('robots.txt');
    expect(err.message).toContain('could not be read');
    expect(err.message).toContain('RFC 9309');
    expect(hits.filter((h) => h.path === '/robots.txt')).toHaveLength(3);
    expect(pageHits()).toEqual([]);
  });

  it('also disallows when robots.txt is unreachable', async () => {
    routes.set('/robots.txt', (req) => req.socket.destroy());
    routes.set('/page', html('<p>ok</p>'));
    expect((await failure(get('/page', { max_retries: 0 }))).code).toBe('ROBOTS_DISALLOWED');
    expect(pageHits()).toEqual([]);
  });

  it('retries a transient robots.txt failure', async () => {
    let n = 0;
    routes.set('/robots.txt', (_req, res) => {
      res.writeHead(++n === 1 ? 503 : 200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nAllow: /');
    });
    routes.set('/page', html('<p>ok</p>'));
    expect((await get('/page')).robots).toBe('allowed');
    expect(sleeps).toHaveLength(1);
  });

  it('follows a redirect of robots.txt', async () => {
    routes.set('/robots.txt', (_req, res) => {
      res.writeHead(301, { location: '/real-robots.txt' });
      res.end();
    });
    routes.set('/real-robots.txt', html('User-agent: *\nDisallow: /blocked', 'text/plain'));
    routes.set('/blocked', html('<p>x</p>'));
    expect((await failure(get('/blocked'))).code).toBe('ROBOTS_DISALLOWED');
  });

  it('reads robots.txt once per origin per call, across redirects', async () => {
    setRobots('User-agent: *\nAllow: /');
    routes.set('/a', (_req, res) => {
      res.writeHead(302, { location: '/b' });
      res.end();
    });
    routes.set('/b', html('<p>b</p>'));
    await get('/a');
    expect(hits.filter((h) => h.path === '/robots.txt')).toHaveLength(1);
  });

  it('skips the check entirely when ingest.respect_robots is false', async () => {
    setRobots('User-agent: *\nDisallow: /');
    routes.set('/page', html('<p>ok</p>'));
    const page = await get('/page', { respect_robots: false });
    expect(page.robots).toBe('not_applicable');
    expect(hits.map((h) => h.path)).toEqual(['/page']);
  });

  it('parses at most 512 KiB of robots.txt (the rest is ignored, not an error)', async () => {
    const filler = '#'.repeat(1023) + '\n';
    setRobots(`User-agent: *\nDisallow: /early\n${filler.repeat(520)}Disallow: /late\n`);
    routes.set('/early', html('<p>x</p>'));
    routes.set('/late', html('<p>x</p>'));
    expect((await failure(get('/early'))).code).toBe('ROBOTS_DISALLOWED');
    expect((await get('/late')).robots).toBe('allowed');
  });
});

describe('fetchPage: retry and backoff', () => {
  it('retries a 503 and succeeds', async () => {
    let n = 0;
    routes.set('/page', (_req, res) => {
      if (++n === 1) {
        res.writeHead(503);
        return void res.end('busy');
      }
      html('<p>ok</p>')(_req, res);
    });
    const page = await get('/page', { respect_robots: false });
    expect(page.body).toBe('<p>ok</p>');
    expect(pageHits()).toEqual(['/page', '/page']);
    expect(sleeps).toHaveLength(1);
  });

  it('honours Retry-After on 429', async () => {
    let n = 0;
    routes.set('/page', (req, res) => {
      if (++n === 1) {
        res.writeHead(429, { 'retry-after': '2' });
        return void res.end();
      }
      html('<p>ok</p>')(req, res);
    });
    await get('/page', { respect_robots: false });
    expect(sleeps).toEqual([2000]);
  });

  it('backs off exponentially (with jitter) between attempts', async () => {
    routes.set('/page', (_req, res) => {
      res.writeHead(502);
      res.end();
    });
    await failure(get('/page', { respect_robots: false, max_retries: 3, backoff_ms: 100 }));
    expect(sleeps).toHaveLength(3);
    [100, 200, 400].forEach((cap, i) => expect(sleeps[i]).toBeLessThanOrEqual(cap));
  });

  it('gives up after max_retries and says how often it tried', async () => {
    routes.set('/page', (_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const err = await failure(get('/page', { respect_robots: false }));
    expect(err.code).toBe('FETCH_FAILED');
    expect(err.message).toContain('HTTP 503');
    expect(err.message).toContain('gave up after 3 attempts');
    expect(pageHits()).toHaveLength(3);
  });

  it('does not wait for a server that asks for a very long pause', async () => {
    routes.set('/page', (_req, res) => {
      res.writeHead(429, { 'retry-after': '3600' });
      res.end();
    });
    const err = await failure(get('/page', { respect_robots: false }));
    expect(err.message).toContain('too long to wait');
    expect(pageHits()).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it.each([404, 401, 403, 410])('does not retry HTTP %i', async (status) => {
    routes.set('/page', (_req, res) => {
      res.writeHead(status);
      res.end();
    });
    const err = await failure(get('/page', { respect_robots: false }));
    expect(err.code).toBe('FETCH_FAILED');
    expect(err.message).toContain(`HTTP ${status}`);
    expect(pageHits()).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('retries network errors', async () => {
    let n = 0;
    routes.set('/page', (req, res) => {
      if (++n === 1) return void req.socket.destroy();
      html('<p>ok</p>')(req, res);
    });
    expect((await get('/page', { respect_robots: false })).body).toBe('<p>ok</p>');
    expect(pageHits()).toHaveLength(2);
  });

  it('makes a single attempt when max_retries is 0', async () => {
    routes.set('/page', (_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const err = await failure(get('/page', { respect_robots: false, max_retries: 0 }));
    expect(err.message).toContain('gave up after 1 attempt)');
  });
});

describe('fetchPage: timeouts', () => {
  it('gives up on a server that never answers', async () => {
    routes.set('/hang', () => undefined);
    const started = Date.now();
    const err = await failure(get('/hang', { respect_robots: false, timeout_ms: 60, max_retries: 0 }));
    expect(err.code).toBe('FETCH_FAILED');
    expect(err.message).toContain('timed out after 60 ms');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('also times out while the body is stalled, and retries timeouts', async () => {
    routes.set('/stall', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html><body><p>half');
    });
    const err = await failure(get('/stall', { respect_robots: false, timeout_ms: 60, max_retries: 1 }));
    expect(err.message).toContain('timed out');
    expect(err.message).toContain('gave up after 2 attempts');
    expect(pageHits()).toHaveLength(2);
  });
});

describe('fetchPage: redirects', () => {
  const redirect = (status: number, location: string): Handler => (_req, res) => {
    res.writeHead(status, { location });
    res.end();
  };

  it('follows a chain (relative and absolute Location) and reports the final URL', async () => {
    setRobots('User-agent: *\nAllow: /');
    routes.set('/a', redirect(302, '/b'));
    routes.set('/b', redirect(301, `${base}/c`));
    routes.set('/c', html('<p>c</p>'));
    const page = await get('/a');
    expect(page.final_url).toBe(`${base}/c`);
    expect(page.chain).toEqual([`${base}/a`, `${base}/b`, `${base}/c`]);
    expect(page.url).toBe(`${base}/a`);
    for (const status of [303, 307, 308]) {
      routes.set('/s', redirect(status, '/c'));
      expect((await get('/s')).final_url).toBe(`${base}/c`);
    }
  });

  it('re-checks robots.txt on every hop: a redirect into a disallowed path is refused before it is requested', async () => {
    setRobots('User-agent: *\nDisallow: /private/');
    routes.set('/a', redirect(302, '/private/x'));
    routes.set('/private/x', html('<p>geheim</p>'));
    const err = await failure(get('/a'));
    expect(err.code).toBe('ROBOTS_DISALLOWED');
    expect(pageHits()).toEqual(['/a']);
  });

  it('stops after five redirects', async () => {
    routes.set('/loop', redirect(302, '/loop'));
    const err = await failure(get('/loop', { respect_robots: false }));
    expect(err.code).toBe('FETCH_FAILED');
    expect(err.message).toContain('too many redirects');
    expect(pageHits()).toHaveLength(6);
    routes.set('/five', redirect(302, '/four'));
    routes.set('/four', redirect(302, '/three'));
    routes.set('/three', redirect(302, '/two'));
    routes.set('/two', redirect(302, '/one'));
    routes.set('/one', redirect(302, '/end'));
    routes.set('/end', html('<p>end</p>'));
    expect((await get('/five', { respect_robots: false })).final_url).toBe(`${base}/end`);
  });

  it('rejects a redirect without Location, to an invalid Location or to another scheme', async () => {
    routes.set('/nolocation', (_req, res) => {
      res.writeHead(302);
      res.end();
    });
    expect((await failure(get('/nolocation', { respect_robots: false }))).message).toContain('without a Location header');
    routes.set('/ftp', redirect(302, 'ftp://example.com/file'));
    expect((await failure(get('/ftp', { respect_robots: false }))).code).toBe('URL_BLOCKED');
    routes.set('/file', redirect(302, 'file:///etc/passwd'));
    expect((await failure(get('/file', { respect_robots: false }))).code).toBe('URL_BLOCKED');
  });

  it('checks robots.txt of the other host after a cross-origin redirect (fake network)', async () => {
    const { fetch, calls } = fakeFetch({
      'https://a.example/robots.txt': { body: 'User-agent: *\nAllow: /' },
      'https://a.example/start': { status: 302, headers: { location: 'https://b.example/landing' } },
      'https://b.example/robots.txt': { body: 'User-agent: *\nDisallow: /landing' },
      'https://b.example/landing': { body: '<p>landing</p>' },
    });
    const err = await failure(fetchPage('https://a.example/start', { ingest: config(), fetch, lookup: publicLookup, sleep }));
    expect(err.code).toBe('ROBOTS_DISALLOWED');
    expect(calls.map((c) => c.url)).toEqual(['https://a.example/robots.txt', 'https://a.example/start', 'https://b.example/robots.txt']);
  });
});

describe('fetchPage: size cap', () => {
  it('fails when Content-Length already exceeds ingest.max_bytes', async () => {
    routes.set('/big', html('x'.repeat(2000)));
    const err = await failure(get('/big', { respect_robots: false, max_bytes: 1000 }));
    expect(err.code).toBe('FETCH_FAILED');
    expect(err.message).toContain('ingest.max_bytes limit of 1000 bytes');
    expect(pageHits()).toHaveLength(1);
  });

  it('aborts a chunked body that grows beyond the cap', async () => {
    routes.set('/stream', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      const timer = setInterval(() => res.write('y'.repeat(400)), 5);
      res.on('close', () => clearInterval(timer));
    });
    const err = await failure(get('/stream', { respect_robots: false, max_bytes: 1000 }));
    expect(err.message).toContain('limit of 1000 bytes');
  });

  it('applies the cap to the decompressed size', async () => {
    routes.set('/bomb', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.alloc(200_000, 'a')));
    });
    const err = await failure(get('/bomb', { respect_robots: false, max_bytes: 10_000 }));
    expect(err.message).toContain('limit of 10000 bytes');
  });

  it('accepts a body of exactly the cap, and decodes gzip', async () => {
    routes.set('/exact', html('z'.repeat(1000)));
    expect((await get('/exact', { respect_robots: false, max_bytes: 1000 })).body).toHaveLength(1000);
    routes.set('/gz', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(gzipSync('<p>gecomprimeerd</p>'));
    });
    expect((await get('/gz', { respect_robots: false })).body).toBe('<p>gecomprimeerd</p>');
  });
});

describe('fetchPage: content types', () => {
  const serve = (type: string | undefined, body: string | Buffer): Handler => (_req, res) => {
    res.writeHead(200, type === undefined ? {} : { 'content-type': type });
    res.end(body);
  };
  const opts = { respect_robots: false } as const;

  it.each([
    ['text/html', 'html'],
    ['TEXT/HTML; Charset=UTF-8', 'html'],
    ['application/xhtml+xml', 'html'],
    ['text/plain', 'text'],
    ['text/plain; charset=utf-8', 'text'],
    ['text/markdown', 'markdown'],
    ['text/x-markdown', 'markdown'],
  ])('accepts %s as %s', async (type, format) => {
    routes.set('/x', serve(type, 'inhoud'));
    const page = await get('/x', opts);
    expect(page.format).toBe(format);
    expect(page.content_type).toBe(type);
  });

  it.each(['application/pdf', 'image/png', 'application/json', 'application/octet-stream', 'video/mp4'])('refuses %s', async (type) => {
    routes.set('/x', serve(type, 'bytes'));
    const err = await failure(get('/x', opts));
    expect(err.code).toBe('UNSUPPORTED_FORMAT');
    expect(err.message).toContain(type);
  });

  it('sniffs a missing Content-Type: markup is html, other text is plain, binary is refused', async () => {
    routes.set('/x', serve(undefined, '<!DOCTYPE html><html><body><p>x</p></body></html>'));
    expect((await get('/x', opts)).format).toBe('html');
    routes.set('/x', serve(undefined, 'Gewoon tekst zonder opmaak.'));
    const plain = await get('/x', opts);
    expect(plain.format).toBe('text');
    expect(plain.content_type).toBeUndefined();
    routes.set('/x', serve(undefined, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02])));
    expect((await failure(get('/x', opts))).code).toBe('UNSUPPORTED_FORMAT');
  });
});

describe('fetchPage: charset decoding', () => {
  const cafe = '<html><head>%META%</head><body><p>Crème brûlée voor één persoon</p></body></html>';
  const serve = (type: string, bytes: Buffer): Handler => (_req, res) => {
    res.writeHead(200, { 'content-type': type });
    res.end(bytes);
  };
  const opts = { respect_robots: false } as const;

  it('uses the charset of the Content-Type header (windows-1252, iso-8859-1)', async () => {
    routes.set('/w', serve('text/html; charset=windows-1252', Buffer.from(cafe.replace('%META%', ''), 'latin1')));
    expect((await get('/w', opts)).body).toContain('Crème brûlée voor één persoon');
    routes.set('/i', serve('text/html; charset=ISO-8859-1', Buffer.from(cafe.replace('%META%', ''), 'latin1')));
    expect((await get('/i', opts)).body).toContain('Crème brûlée voor één persoon');
  });

  it('falls back to <meta charset> and to the http-equiv form', async () => {
    routes.set('/m', serve('text/html', Buffer.from(cafe.replace('%META%', '<meta charset="iso-8859-1">'), 'latin1')));
    expect((await get('/m', opts)).body).toContain('één persoon');
    routes.set('/h', serve('text/html', Buffer.from(cafe.replace('%META%', '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">'), 'latin1')));
    expect((await get('/h', opts)).body).toContain('één persoon');
  });

  it('prefers the header over <meta>, and a byte-order mark over both', async () => {
    routes.set('/u', serve('text/html; charset=utf-8', Buffer.from(cafe.replace('%META%', '<meta charset="windows-1252">'), 'utf8')));
    expect((await get('/u', opts)).body).toContain('Crème brûlée voor één persoon');
    routes.set('/bom', serve('text/html; charset=iso-8859-1', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(cafe.replace('%META%', ''), 'utf8')])));
    const page = await get('/bom', opts);
    expect(page.body).toContain('Crème brûlée voor één persoon');
    expect(page.body.startsWith('<html>')).toBe(true);
    routes.set('/16', serve('text/html', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<p>Één</p>', 'utf16le')])));
    expect((await get('/16', opts)).body).toBe('<p>Één</p>');
  });

  it('defaults to UTF-8 and warns about a charset it does not know', async () => {
    routes.set('/d', serve('text/html', Buffer.from(cafe.replace('%META%', ''), 'utf8')));
    expect((await get('/d', opts)).body).toContain('Crème brûlée voor één persoon');
    routes.set('/k', serve('text/html; charset=klingon', Buffer.from(cafe.replace('%META%', ''), 'utf8')));
    const page = await get('/k', opts);
    expect(page.body).toContain('één persoon');
    expect(page.warnings).toEqual(['unknown charset "klingon" declared in the Content-Type header; decoded as UTF-8']);
  });
});

describe('fetchPage: identification', () => {
  const agent = (i = 0): string => String(hits[i]?.headers['user-agent']);

  it('sends a descriptive User-Agent with the contact, and the Accept header, on every request', async () => {
    setRobots('User-agent: *\nAllow: /');
    routes.set('/page', html('<p>ok</p>'));
    await get('/page', {}, { contact: 'ops@example.com' });
    expect(agent(0)).toBe(`${stages.ingest.user_agent}; contact: ops@example.com`);
    expect(agent(0)).toContain('locale-engine/');
    expect(agent(1)).toBe(agent(0)); // robots.txt and the page
    expect(hits[1]?.headers['accept']).toBe('text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,*/*;q=0.1');
    expect(hits[1]?.headers['accept-encoding']).toBeDefined();
  });

  it('takes the contact from LOCALE_CONTACT when none is passed, and lets an explicit contact win', async () => {
    routes.set('/page', html('<p>ok</p>'));
    vi.stubEnv('LOCALE_CONTACT', 'env@example.com');
    await get('/page', { respect_robots: false });
    expect(agent(0)).toBe(`${stages.ingest.user_agent}; contact: env@example.com`);
    await get('/page', { respect_robots: false }, { contact: 'explicit@example.com' });
    expect(agent(1)).toBe(`${stages.ingest.user_agent}; contact: explicit@example.com`);
  });

  it('sends the bare configured User-Agent without a contact', async () => {
    routes.set('/page', html('<p>ok</p>'));
    vi.stubEnv('LOCALE_CONTACT', '');
    await get('/page', { respect_robots: false });
    expect(agent(0)).toBe(stages.ingest.user_agent);
    expect(userAgentFor({ user_agent: 'bot/1' }, 'a\r\nb@example.com')).toBe('bot/1; contact: a b@example.com');
  });
});

describe('SSRF guard: assertPublicUrl', () => {
  const noDns: HostLookup = async () => {
    throw new Error('DNS must not be consulted for literal IP addresses');
  };

  it.each([
    'http://127.0.0.1/', 'http://127.1.2.3:8080/x', 'http://0.0.0.0/', 'http://10.0.0.5/', 'http://10.255.255.255/', 'http://172.16.0.1/',
    'http://172.31.255.255/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/',
    'http://100.127.255.254/', 'http://224.0.0.1/', 'http://239.255.255.250/', 'http://240.0.0.1/', 'http://255.255.255.255/',
    'http://198.18.0.1/', 'http://192.0.0.192/',
    // numeric spellings are canonicalised by the URL parser before the check
    'http://2130706433/', 'http://0x7f.0.0.1/', 'http://127.1/', 'http://0177.0.0.1/',
    'http://[::1]/', 'http://[::]/', 'http://[fe80::1]/', 'http://[febf::1]/', 'http://[fc00::1]/', 'http://[fd12:3456:789a::1]/',
    'http://[ff02::1]/', 'http://[fec0::1]/', 'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/',
    // IPv4 hidden inside IPv6
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:10.1.2.3]/', 'http://[::ffff:a9fe:a9fe]/',
    'http://[::ffff:192.168.0.1]/', 'http://[64:ff9b::7f00:1]/', 'http://[64:ff9b::a00:1]/', 'http://[2002:7f00:1::]/', 'http://[2002:c0a8:101::1]/',
    'http://[::127.0.0.1]/',
  ])('blocks the literal address in %s without any DNS lookup', async (url) => {
    const err = await failure(assertPublicUrl(url, noDns));
    expect(err.code).toBe('URL_BLOCKED');
    expect(err.message).toContain('SSRF guard');
  });

  it.each([
    'http://8.8.8.8/', 'http://93.184.216.34/', 'https://1.1.1.1:8443/x', 'http://172.15.255.255/', 'http://172.32.0.1/', 'http://100.63.255.255/',
    'http://100.128.0.1/', 'http://11.0.0.1/', 'http://169.253.1.1/', 'http://[2606:4700:4700::1111]/', 'http://[2a00:1450:4001:81b::200e]/',
    'http://[::ffff:8.8.8.8]/', 'http://[64:ff9b::808:808]/', 'http://[2002:808:808::1]/',
  ])('lets the public literal address in %s through', async (url) => {
    await expect(assertPublicUrl(url, noDns)).resolves.toBeUndefined();
  });

  const table: Record<string, string[]> = {
    'internal.example': ['10.0.0.7'],
    'metadata.example': ['169.254.169.254'],
    'loop.example': ['::1'],
    'ula.example': ['fd00:ec2::254'],
    'cgnat.example': ['100.100.100.200'],
    'mapped.example': ['::ffff:10.0.0.1'],
    'mixed.example': ['93.184.216.34', '192.168.0.10'],
    'mixed6.example': ['2606:4700:4700::1111', 'fe80::1%eth0'],
    'public.example': ['93.184.216.34', '2606:4700:4700::1111'],
  };
  const lookup: HostLookup = async (host) => (table[host] ?? []).map((address) => ({ address }));

  it.each(Object.keys(table).filter((h) => h !== 'public.example'))('blocks %s when any address it resolves to is not public', async (host) => {
    const err = await failure(assertPublicUrl(`https://${host}/path`, lookup));
    expect(err.code).toBe('URL_BLOCKED');
    expect(err.message).toContain(`"${host}" resolves to`);
  });

  it('lets a host through when every address is public, and names the offending address otherwise', async () => {
    await expect(assertPublicUrl('https://public.example/', lookup)).resolves.toBeUndefined();
    const err = await failure(assertPublicUrl('https://mixed.example/', lookup));
    expect(err.message).toContain('192.168.0.10');
    expect(err.message).toContain('private address (192.168.0.0/16)');
    expect(err.details).toMatchObject({ address: '192.168.0.10' });
  });

  it('blocks localhost with the real resolver', async () => {
    expect((await failure(assertPublicUrl('http://localhost:8080/'))).code).toBe('URL_BLOCKED');
  });

  it('reports unresolvable hosts as FETCH_FAILED, not as a block', async () => {
    const err = await failure(assertPublicUrl('https://nx.example/', async () => { throw new Error('ENOTFOUND nx.example'); }));
    expect(err.code).toBe('FETCH_FAILED');
    expect(err.message).toContain('could not resolve host "nx.example"');
    expect((await failure(assertPublicUrl('https://empty.example/', async () => []))).code).toBe('FETCH_FAILED');
  });

  it('only allows http and https, and no credentials in the URL', async () => {
    for (const url of ['ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/', 'javascript:alert(1)']) {
      expect((await failure(assertPublicUrl(url, lookup))).code).toBe('URL_BLOCKED');
    }
    const err = await failure(assertPublicUrl('https://user:secret-pw@public.example/', lookup));
    expect(err.code).toBe('URL_BLOCKED');
    expect(err.message).not.toContain('secret-pw');
    expect(JSON.stringify(err.details)).not.toContain('secret-pw');
    expect(() => assertFetchableUrl('not a url')).toThrowError(expect.objectContaining({ code: 'INPUT_INVALID' }));
    expect(assertFetchableUrl('https://example.com/a').href).toBe('https://example.com/a');
  });

  it('refuses addresses it cannot parse', () => {
    expect(blockedReason('not-an-ip')).toBe('not a valid IP address');
    expect(blockedReason('1.2.3')).toBe('not a valid IP address');
    expect(blockedReason('8.8.8.8')).toBeUndefined();
    expect(blockedReason('fe80::1%en0')).toContain('link-local');
  });
});

describe('SSRF guard: fetchPage', () => {
  it('blocks loopback targets by default, before any request is made', async () => {
    routes.set('/page', html('<p>ok</p>'));
    const err = await failure(fetchPage(`${base}/page`, { ingest: { ...stages.ingest, max_retries: 0 }, sleep }));
    expect(err.code).toBe('URL_BLOCKED');
    expect(err.message).toContain('127.0.0.1');
    expect(hits).toEqual([]);
  });

  it('lets loopback through with allowPrivateNetworks or with ingest.block_private_networks: false', async () => {
    routes.set('/page', html('<p>ok</p>'));
    const viaOption = await fetchPage(`${base}/page`, { ingest: { ...stages.ingest, respect_robots: false }, allowPrivateNetworks: true });
    expect(viaOption.body).toBe('<p>ok</p>');
    const viaConfig = await fetchPage(`${base}/page`, { ingest: { ...stages.ingest, respect_robots: false, block_private_networks: false } });
    expect(viaConfig.body).toBe('<p>ok</p>');
  });

  it('re-checks every redirect hop: a public host cannot bounce the fetch to an internal address', async () => {
    const { fetch, calls } = fakeFetch({
      'http://public.example/': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
    });
    const err = await failure(fetchPage('http://public.example/', { ingest: { ...stages.ingest, respect_robots: false }, fetch, lookup: publicLookup }));
    expect(err.code).toBe('URL_BLOCKED');
    expect(calls.map((c) => c.url)).toEqual(['http://public.example/']);
  });

  it('checks the resolved address of every hop, not just literal IPs', async () => {
    const { fetch, calls } = fakeFetch({
      'http://public.example/start': { status: 302, headers: { location: 'http://rebind.example/admin' } },
    });
    const lookup: HostLookup = async (host) => [{ address: host === 'rebind.example' ? '10.1.2.3' : '93.184.216.34' }];
    const err = await failure(fetchPage('http://public.example/start', { ingest: { ...stages.ingest, respect_robots: false }, fetch, lookup }));
    expect(err.code).toBe('URL_BLOCKED');
    expect(err.message).toContain('"rebind.example" resolves to 10.1.2.3');
    expect(calls).toHaveLength(1);
  });

  it('refuses a host that resolves to a private address before sending anything', async () => {
    const { fetch, calls } = fakeFetch({ 'https://intranet.example/': { body: '<p>geheim</p>' } });
    const err = await failure(fetchPage('https://intranet.example/', { ingest: stages.ingest, fetch, lookup: async () => [{ address: '192.168.1.20' }] }));
    expect(err.code).toBe('URL_BLOCKED');
    expect(calls).toEqual([]);
  });

  it('also guards robots.txt requests', async () => {
    const { fetch, calls } = fakeFetch({
      'https://a.example/robots.txt': { status: 302, headers: { location: 'http://10.0.0.1/robots.txt' } },
    });
    const err = await failure(fetchPage('https://a.example/page', { ingest: stages.ingest, fetch, lookup: publicLookup }));
    expect(err.code).toBe('URL_BLOCKED');
    expect(calls.map((c) => c.url)).toEqual(['https://a.example/robots.txt']);
  });
});
