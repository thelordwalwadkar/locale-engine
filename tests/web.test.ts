/** The browser app end to end: real engine on the offline mock provider, real SQLite file, real HTTP handling through Fastify. */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { createEngine } from '../src/pipeline/engine.js';
import type { Engine } from '../src/pipeline/types.js';
import { createProviderRegistry } from '../src/providers/registry.js';
import { ProvidersConfigSchema } from '../src/schemas/index.js';
import { EngineError } from '../src/util/errors.js';
import { Store, checkPassword, hashPassword } from '../src/web/db.js';
import { JobRunner } from '../src/web/jobs.js';
import { buildWeb, ensureAdmin } from '../src/web/server.js';
import { zipStored } from '../src/web/zip.js';

const config = loadConfig();
const providers = ProvidersConfigSchema.parse({
  version: 1,
  providers: { mock: { kind: 'mock', default_model: 'm', models: { m: { id: 'm', structured_output: 'native', pricing: { input_per_mtok: 0, output_per_mtok: 0 }, pricing_verified: true } } } },
  routing: { default_provider: 'mock', stages: {} },
});
const realEngine = createEngine({ config, env: {}, registryFactory: async () => createProviderRegistry({ config: providers, env: {} }) });

const dirs: string[] = [];
const stores: Store[] = [];
afterAll(() => {
  for (const s of stores) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function setup(engine: Engine = realEngine, over: Partial<Parameters<typeof buildWeb>[0]> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'locale-web-'));
  dirs.push(dir);
  const store = new Store(path.join(dir, 'test.db'));
  stores.push(store);
  const { app, runner } = buildWeb({ store, getEngine: async () => engine, dataDir: dir, ...over });
  return { dir, store, app, runner };
}

async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
  expect(res.statusCode).toBe(200);
  const cookie = String(res.headers['set-cookie']);
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Strict/);
  return cookie.split(';')[0] as string;
}

const jobBody = { input: { kind: 'text', format: 'html', text: '<main><h1>Dompelpompen</h1><p>Onze pompen leveren een hoog rendement bij lage kosten.</p></main>' }, targets: ['de-CH', 'it-IT'] };
const call = (app: FastifyInstance, cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe('passwords and the database', () => {
  it('stores scrypt hashes, never the password, and verifies them', () => {
    const h = hashPassword('correct horse battery');
    expect(h).toMatch(/^scrypt\$/);
    expect(h).not.toContain('correct');
    expect(checkPassword('correct horse battery', h)).toBe(true);
    expect(checkPassword('wrong', h)).toBe(false);
    expect(checkPassword('x', 'garbage')).toBe(false);
  });

  it('creates the first administrator once, from the environment or with a generated password', () => {
    const { store } = setup();
    const first = ensureAdmin(store, { LOCALE_ADMIN_USER: 'boss', LOCALE_ADMIN_PASSWORD: 'a-long-enough-pass' });
    expect(first).toMatchObject({ username: 'boss', generated: false });
    expect(ensureAdmin(store, {})).toBeUndefined();
    const other = setup();
    const gen = ensureAdmin(other.store, {});
    expect(gen?.generated).toBe(true);
    expect(gen?.password.length).toBeGreaterThanOrEqual(12);
    expect(other.store.authenticate('admin', gen?.password ?? '')?.role).toBe('admin');
  });

  it('marks jobs that were queued or running when the server stopped as failed', () => {
    const { store } = setup();
    const u = store.createUser({ username: 'a', password: 'longenoughpassword', role: 'user', daily_limit_usd: 5 });
    store.createJob({ id: 'j1', user_id: u.id, input_kind: 'url', input_ref: 'https://x.nl', targets: ['de-DE'], ceiling_usd: 1 });
    expect(store.failInterrupted()).toBe(1);
    expect(store.getJob('j1')).toMatchObject({ status: 'failed', cost_usd: 0 });
  });
});

describe('the zip writer', () => {
  it('writes a valid archive (end record, entry count, names)', () => {
    const z = zipStored([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'de-CH/page.md', data: Buffer.from('x') }]);
    expect(z.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(z.readUInt16LE(z.length - 22 + 10)).toBe(2);
    expect(z.includes(Buffer.from('de-CH/page.md'))).toBe(true);
  });
});

describe('the web app', () => {
  let ctx: ReturnType<typeof setup>;
  let admin = '';
  let alice = '';
  let jobId = '';

  beforeAll(async () => {
    ctx = setup(realEngine, { defaultDailyLimitUsd: 10 });
    ensureAdmin(ctx.store, { LOCALE_ADMIN_USER: 'boss', LOCALE_ADMIN_PASSWORD: 'a-long-enough-pass' });
    admin = await login(ctx.app, 'boss', 'a-long-enough-pass');
    const created = await call(ctx.app, admin, 'POST', '/api/admin/users', { username: 'alice', password: 'alice-password-1', daily_limit_usd: 5 });
    expect(created.statusCode).toBe(201);
    alice = await login(ctx.app, 'alice', 'alice-password-1');
  });

  it('serves the page with a strict content security policy, and refuses the API without a login', async () => {
    const page = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect(page.body).toContain('<div id="app">');
    expect((await ctx.app.inject({ method: 'GET', url: '/app.js' })).statusCode).toBe(200);
    for (const url of ['/api/me', '/api/jobs', '/api/locales', '/api/admin/users']) expect((await ctx.app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/jobs', payload: jobBody })).statusCode).toBe(401);
  });

  it('rejects wrong passwords, and a cross-site POST', async () => {
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/login', payload: { username: 'alice', password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('BAD_LOGIN');
    const cross = await ctx.app.inject({ method: 'POST', url: '/api/jobs', headers: { cookie: alice, origin: 'https://evil.example', host: 'localhost' }, payload: jobBody });
    expect(cross.statusCode).toBe(403);
  });

  it('runs a translation job to the end and stores the result', async () => {
    const res = await call(ctx.app, alice, 'POST', '/api/jobs', jobBody);
    expect(res.statusCode).toBe(202);
    jobId = res.json().id;
    await ctx.runner.whenIdle();
    const job = (await call(ctx.app, alice, 'GET', `/api/jobs/${jobId}`)).json();
    expect(job.status).toBe('done');
    expect(job.summary.locales.map((l: { locale: string }) => l.locale)).toEqual(['de-CH', 'it-IT']);
    expect(job.summary.providers).toEqual(['mock:m']);
    const me = (await call(ctx.app, alice, 'GET', '/api/me')).json();
    expect(me).toMatchObject({ username: 'alice', role: 'user', daily_limit_usd: 5 });
    const list = (await call(ctx.app, alice, 'GET', '/api/jobs')).json();
    expect(list.jobs.map((j: { id: string }) => j.id)).toContain(jobId);
  });

  it('returns the side-by-side report and only whitelisted files', async () => {
    const report = (await call(ctx.app, alice, 'GET', `/api/jobs/${jobId}/report`)).json();
    expect(report.locales).toHaveLength(2);
    expect(report.locales[0].segments.length).toBeGreaterThan(0);
    expect(report.locales[0].segments[0]).toHaveProperty('source');
    const html = await call(ctx.app, alice, 'GET', `/api/jobs/${jobId}/file?name=${encodeURIComponent('de-CH/page.html')}`);
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-disposition']).toContain('attachment');
    expect(html.headers['content-security-policy']).toContain('sandbox');
    for (const name of ['../../test.db', '../run.json', 'de-CH/../../x', 'nl-NL/page.html', 'run.json%00.html', '/etc/passwd']) {
      expect((await call(ctx.app, alice, 'GET', `/api/jobs/${jobId}/file?name=${encodeURIComponent(name)}`)).statusCode, name).toBe(404);
    }
    const zip = await call(ctx.app, alice, 'GET', `/api/jobs/${jobId}/download.zip`);
    expect(zip.statusCode).toBe(200);
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(zip.rawPayload.includes(Buffer.from('executive_summary.md'))).toBe(true);
  });

  it('keeps one user\'s jobs from another, but lets the administrator see them', async () => {
    const bob = await (async () => {
      await call(ctx.app, admin, 'POST', '/api/admin/users', { username: 'bob', password: 'bob-password-12' });
      return login(ctx.app, 'bob', 'bob-password-12');
    })();
    expect((await call(ctx.app, bob, 'GET', `/api/jobs/${jobId}`)).statusCode).toBe(404);
    expect((await call(ctx.app, bob, 'GET', `/api/jobs/${jobId}/report`)).statusCode).toBe(404);
    expect((await call(ctx.app, bob, 'GET', '/api/jobs')).json().jobs).toEqual([]);
    expect((await call(ctx.app, bob, 'DELETE', `/api/jobs/${jobId}`)).statusCode).toBe(404);
    expect((await call(ctx.app, admin, 'GET', `/api/jobs/${jobId}`)).statusCode).toBe(200);
    expect((await call(ctx.app, admin, 'GET', '/api/jobs?all=1')).json().jobs.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps administration for administrators, and validates what it is given', async () => {
    expect((await call(ctx.app, alice, 'GET', '/api/admin/users')).statusCode).toBe(403);
    expect((await call(ctx.app, alice, 'POST', '/api/admin/users', { username: 'x', password: 'longenoughpassword' })).statusCode).toBe(403);
    expect((await call(ctx.app, admin, 'POST', '/api/admin/users', { username: 'alice', password: 'another-password-1' })).statusCode).toBe(409);
    expect((await call(ctx.app, admin, 'POST', '/api/admin/users', { username: 'ok-name', password: 'short' })).statusCode).toBe(400);
    expect((await call(ctx.app, admin, 'POST', '/api/admin/users', { username: 'bad name!', password: 'longenoughpassword' })).statusCode).toBe(400);
    const adminId = (await call(ctx.app, admin, 'GET', '/api/admin/users')).json().users.find((u: { username: string }) => u.username === 'boss').id;
    expect((await call(ctx.app, admin, 'PATCH', `/api/admin/users/${adminId}`, { disabled: true })).statusCode).toBe(400);
  });

  it('refuses nonsense job requests', async () => {
    for (const payload of [{}, { ...jobBody, targets: [] }, { ...jobBody, targets: ['fr-FR'] }, { input: { kind: 'file', path: '/etc/passwd' }, targets: ['de-DE'] }, { input: { kind: 'url', url: 'not a url' }, targets: ['de-DE'] }]) {
      expect((await call(ctx.app, alice, 'POST', '/api/jobs', payload)).statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
    }
  });

  it('a disabled user is signed out at once; a password reset ends their sessions', async () => {
    const carol = await call(ctx.app, admin, 'POST', '/api/admin/users', { username: 'carol', password: 'carol-password-1' });
    const id = carol.json().id;
    const cookie = await login(ctx.app, 'carol', 'carol-password-1');
    expect((await call(ctx.app, cookie, 'GET', '/api/me')).statusCode).toBe(200);
    await call(ctx.app, admin, 'PATCH', `/api/admin/users/${id}`, { disabled: true });
    expect((await call(ctx.app, cookie, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/login', payload: { username: 'carol', password: 'carol-password-1' } })).statusCode).toBe(401);
    await call(ctx.app, admin, 'PATCH', `/api/admin/users/${id}`, { disabled: false, password: 'carol-new-password' });
    await login(ctx.app, 'carol', 'carol-new-password');
  });

  it('deletes a finished job together with its files', async () => {
    const dir = ctx.runner.jobDir(jobId);
    expect(existsSync(dir)).toBe(true);
    expect((await call(ctx.app, alice, 'DELETE', `/api/jobs/${jobId}`)).statusCode).toBe(200);
    expect(existsSync(dir)).toBe(false);
    expect((await call(ctx.app, alice, 'GET', `/api/jobs/${jobId}`)).statusCode).toBe(404);
  });

  it('logs out', async () => {
    const dave = await (async () => {
      await call(ctx.app, admin, 'POST', '/api/admin/users', { username: 'dave', password: 'dave-password-12' });
      return login(ctx.app, 'dave', 'dave-password-12');
    })();
    await call(ctx.app, dave, 'POST', '/api/logout');
    expect((await call(ctx.app, dave, 'GET', '/api/me')).statusCode).toBe(401);
  });
});

describe('limits and failures', () => {
  it('stops a user whose daily limit is used up, and caps a job at what is left', async () => {
    const c = setup(realEngine, { jobCeilingUsd: 2 });
    ensureAdmin(c.store, { LOCALE_ADMIN_USER: 'boss', LOCALE_ADMIN_PASSWORD: 'a-long-enough-pass' });
    const admin = await login(c.app, 'boss', 'a-long-enough-pass');
    await call(c.app, admin, 'POST', '/api/admin/users', { username: 'zero', password: 'zero-password-12', daily_limit_usd: 0 });
    await call(c.app, admin, 'POST', '/api/admin/users', { username: 'small', password: 'small-password-12', daily_limit_usd: 0.5 });
    const zero = await login(c.app, 'zero', 'zero-password-12');
    const denied = await call(c.app, zero, 'POST', '/api/jobs', jobBody);
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error.code).toBe('DAILY_LIMIT');
    const small = await login(c.app, 'small', 'small-password-12');
    const ok = await call(c.app, small, 'POST', '/api/jobs', jobBody);
    expect(ok.statusCode).toBe(202);
    expect(c.store.getJob(ok.json().id)?.ceiling_usd).toBe(0.5); // min(job ceiling 2, what is left 0.5)
    await c.runner.whenIdle();
  });

  it('shows a failed job with a readable reason, and releases its reserved spend', async () => {
    const failing = { ...realEngine, runPipeline: async () => { throw new EngineError('PROVIDER_UNAVAILABLE', 'no provider has credentials: set ANTHROPIC_API_KEY'); } } as unknown as Engine;
    const c = setup(failing);
    ensureAdmin(c.store, { LOCALE_ADMIN_USER: 'boss', LOCALE_ADMIN_PASSWORD: 'a-long-enough-pass' });
    const admin = await login(c.app, 'boss', 'a-long-enough-pass');
    const res = await call(c.app, admin, 'POST', '/api/jobs', jobBody);
    await c.runner.whenIdle();
    const job = (await call(c.app, admin, 'GET', `/api/jobs/${res.json().id}`)).json();
    expect(job.status).toBe('failed');
    expect(job.error).toContain('ANTHROPIC_API_KEY');
    expect(job.cost_usd).toBe(0);
    expect((await call(c.app, admin, 'GET', '/api/me')).json().spent_today_usd).toBe(0);
  });

  it('refuses a new job when the queue is full', async () => {
    const never = { ...realEngine, runPipeline: () => new Promise(() => undefined) } as unknown as Engine;
    const c = setup(never, { maxQueue: 1 });
    ensureAdmin(c.store, { LOCALE_ADMIN_USER: 'boss', LOCALE_ADMIN_PASSWORD: 'a-long-enough-pass' });
    const admin = await login(c.app, 'boss', 'a-long-enough-pass');
    expect((await call(c.app, admin, 'POST', '/api/jobs', jobBody)).statusCode).toBe(202);
    expect((await call(c.app, admin, 'POST', '/api/jobs', jobBody)).statusCode).toBe(503);
  });

  it('slows down repeated failed logins', async () => {
    const c = setup();
    ensureAdmin(c.store, { LOCALE_ADMIN_USER: 'boss', LOCALE_ADMIN_PASSWORD: 'a-long-enough-pass' });
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await c.app.inject({ method: 'POST', url: '/api/login', payload: { username: 'boss', password: 'wrong' + i } })).statusCode;
    expect(last).toBe(429);
    // even the right password is refused while the lock-out lasts
    expect((await c.app.inject({ method: 'POST', url: '/api/login', payload: { username: 'boss', password: 'a-long-enough-pass' } })).statusCode).toBe(429);
  });
});

describe('JobRunner', () => {
  it('runs at most `concurrency` jobs at once', async () => {
    let running = 0;
    let peak = 0;
    const slow = {
      ...realEngine,
      runPipeline: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
        throw new EngineError('INPUT_INVALID', 'stop here');
      },
    } as unknown as Engine;
    const c = setup(slow);
    const u = c.store.createUser({ username: 'a', password: 'longenoughpassword', role: 'user', daily_limit_usd: 5 });
    const runner = new JobRunner(c.store, async () => slow, { dataDir: c.dir, concurrency: 2 });
    for (let i = 0; i < 5; i++) {
      c.store.createJob({ id: `j${i}`, user_id: u.id, input_kind: 'url', input_ref: 'https://x.nl', targets: ['de-DE'], ceiling_usd: 1 });
      runner.enqueue(`j${i}`, { input: { kind: 'url', url: 'https://x.nl' }, targets: ['de-DE'], options: {} });
    }
    await runner.whenIdle();
    expect(peak).toBe(2);
    expect(c.store.listJobs(u.id).every((j) => j.status === 'failed')).toBe(true);
  });
});
