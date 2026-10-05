#!/usr/bin/env node
/**
 * `locale-web` — the browser app: a login, a form to start a translation, a job list with live status, side-by-side results and
 * downloads, and an admin page for users and spending limits. Everything runs in this one process: Fastify for HTTP, SQLite for
 * data, the existing Engine for the work. It only ever reads URLs and pasted text (never local files), and spend is capped per
 * job and per user per day.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadDotEnv } from '../config/env.js';
import { toPublicError } from '../interfaces/errors.js';
import { allowedHostnamesFor, guardRejects, GUARD_MESSAGE } from '../interfaces/host-guard.js';
import { createLazyEngine, exitOnFatal, getDefaultEngine, isEntryPoint, parsePort, urlHost } from '../interfaces/runtime.js';
import type { RunningServer } from '../interfaces/runtime.js';
import type { Engine } from '../pipeline/types.js';
import { LOCALES, PipelineRequestSchema } from '../schemas/index.js';
import { projectRoot, toolVersion } from '../util/paths.js';
import { Store } from './db.js';
import type { JobRow, UserRow } from './db.js';
import { JobRunner } from './jobs.js';
import { zipStored } from './zip.js';

export interface WebOptions {
  store: Store;
  getEngine: () => Promise<Engine>;
  dataDir: string;
  concurrency?: number;
  /** Most a single job may spend, USD. */
  jobCeilingUsd?: number;
  /** Daily limit given to users created without one, USD. */
  defaultDailyLimitUsd?: number;
  /** Queued + running jobs allowed at once. */
  maxQueue?: number;
  /** Add `Secure` to the session cookie (set when served over HTTPS). */
  secureCookies?: boolean;
  allowedHosts?: readonly string[];
  /** Demo mode: every stage runs on the offline test model, so the output is placeholder text. */
  demo?: boolean;
  /** Folder with index.html, app.js, style.css. */
  publicDir?: string;
}

const COOKIE = 'locale_session';
const FILE_NAME = /^(?:[a-z]{2}-[A-Z]{2}\/page\.(?:html|md|json)|localization_report\.xlsx|executive_summary\.md|run\.json)$/;
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

const Login = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) });
const NewJob = z.object({
  input: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('url'), url: z.string().url().max(2000) }),
    z.object({ kind: z.literal('text'), text: z.string().min(1).max(400_000), format: z.enum(['html', 'markdown', 'text']).default('text'), name: z.string().max(200).optional() }),
  ]),
  targets: z.array(z.enum(LOCALES)).min(1).max(7),
  keyword: z.string().trim().max(200).optional(),
});
const NewUser = z.object({
  username: z.string().trim().regex(/^[A-Za-z0-9._@-]{3,60}$/, 'use 3-60 letters, digits, . _ @ -'),
  password: z.string().min(10, 'at least 10 characters').max(200),
  role: z.enum(['admin', 'user']).default('user'),
  daily_limit_usd: z.number().min(0).max(1000).optional(),
});
const PatchUser = z.object({
  disabled: z.boolean().optional(),
  daily_limit_usd: z.number().min(0).max(1000).optional(),
  password: z.string().min(10).max(200).optional(),
  role: z.enum(['admin', 'user']).optional(),
});

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const body = (code: string, message: string, extra: object = {}) => ({ error: { code, message, ...extra } });

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const publicUser = (u: UserRow, spent: number) => ({ id: u.id, username: u.username, role: u.role, daily_limit_usd: u.daily_limit_usd, spent_today_usd: Math.round(spent * 10000) / 10000 });
const publicJob = (j: JobRow) => ({
  id: j.id, status: j.status, input_kind: j.input_kind, input_ref: j.input_ref, targets: j.targets, created_at: j.created_at,
  started_at: j.started_at, finished_at: j.finished_at, cost_usd: j.cost_usd, error: j.error, summary: j.summary,
});

/** Creates the first admin when the database has no users. Returns the generated password when none was configured. */
export function ensureAdmin(store: Store, env: NodeJS.ProcessEnv = process.env): { username: string; password: string; generated: boolean } | undefined {
  if (store.countUsers() > 0) return undefined;
  const username = env['LOCALE_ADMIN_USER']?.trim() || 'admin';
  const given = env['LOCALE_ADMIN_PASSWORD'];
  const password = given && given.length >= 10 ? given : randomBytes(12).toString('base64url');
  store.createUser({ username, password, role: 'admin', daily_limit_usd: Number(env['LOCALE_WEB_ADMIN_DAILY_LIMIT_USD'] ?? 50) });
  return { username, password, generated: !(given && given.length >= 10) };
}

export function buildWeb(opts: WebOptions): { app: FastifyInstance; runner: JobRunner } {
  const { store } = opts;
  const publicDir = opts.publicDir ?? path.join(projectRoot(), 'src', 'web', 'public');
  const jobCeiling = opts.jobCeilingUsd ?? 2;
  const defaultLimit = opts.defaultDailyLimitUsd ?? 10;
  const maxQueue = opts.maxQueue ?? 20;
  const runner = new JobRunner(store, opts.getEngine, { dataDir: opts.dataDir, concurrency: opts.concurrency ?? 1 });
  mkdirSync(path.join(opts.dataDir, 'jobs'), { recursive: true });
  const interrupted = store.failInterrupted();
  if (interrupted > 0) process.stderr.write(`locale-web: ${interrupted} job(s) were interrupted by the last shutdown and are marked failed\n`);

  const app = Fastify({ bodyLimit: 1_000_000, logger: false, trustProxy: process.env['LOCALE_WEB_TRUST_PROXY'] === '1' });
  app.removeContentTypeParser('text/plain');
  const users = new WeakMap<FastifyRequest, UserRow>();
  const failures = new Map<string, { n: number; until: number }>();

  app.addHook('onRequest', async (request, reply) => {
    if (opts.allowedHosts && guardRejects(request.headers, opts.allowedHosts)) return reply.code(403).send(body('HOST_NOT_ALLOWED', GUARD_MESSAGE));
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.origin;
      if (origin !== undefined) {
        let same = false;
        try {
          same = new URL(origin).host === request.headers.host;
        } catch {
          same = false;
        }
        if (!same) return reply.code(403).send(body('BAD_ORIGIN', 'cross-site requests are not allowed'));
      }
    }
    const url = request.url.split('?')[0] ?? '';
    if (url.startsWith('/api/') && url !== '/api/login' && url !== '/api/health') {
      const token = parseCookies(request.headers.cookie)[COOKIE];
      const user = token ? store.userForSession(token) : undefined;
      if (!user) return reply.code(401).send(body('UNAUTHENTICATED', 'sign in first'));
      users.set(request, user);
      if (url.startsWith('/api/admin/') && user.role !== 'admin') return reply.code(403).send(body('FORBIDDEN', 'administrators only'));
    }
    return undefined;
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send(body(error.code, error.message));
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      return reply.code(400).send(body('INVALID_REQUEST', `${issue?.path.join('.') || 'request'}: ${issue?.message ?? 'invalid'}`));
    }
    const status = typeof (error as { statusCode?: number }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 0;
    if (status >= 400 && status < 500) return reply.code(status).send(body(status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST', status === 413 ? 'the request is too large' : 'invalid request'));
    const { status: s, payload } = toPublicError(error);
    return reply.code(s).send({ error: payload });
  });

  const me = (r: FastifyRequest): UserRow => users.get(r) as UserRow;
  const ownJob = (r: FastifyRequest, id: string): JobRow => {
    const job = store.getJob(id);
    const u = me(r);
    if (!job || (job.user_id !== u.id && u.role !== 'admin')) throw new HttpError(404, 'NOT_FOUND', 'no such job');
    return job;
  };
  const sendFile = (reply: FastifyReply, name: string, data: Buffer, ext: string) =>
    reply
      .header('Content-Type', MIME[ext] ?? 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .send(data);

  // ---- static page ----------------------------------------------------------------------------------------------
  const asset = (file: string, type: string) => async (_r: FastifyRequest, reply: FastifyReply) => {
    const p = path.join(publicDir, file);
    if (!existsSync(p)) throw new HttpError(404, 'NOT_FOUND', 'missing asset');
    return reply
      .header('Content-Type', type)
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
      .send(readFileSync(p));
  };
  app.get('/', asset('index.html', 'text/html; charset=utf-8'));
  app.get('/app.js', asset('app.js', 'text/javascript; charset=utf-8'));
  app.get('/style.css', asset('style.css', 'text/css; charset=utf-8'));
  app.get('/api/health', async () => ({ status: 'ok', version: toolVersion() }));

  // ---- session --------------------------------------------------------------------------------------------------
  app.post('/api/login', async (request, reply) => {
    const { username, password } = Login.parse(request.body);
    const key = `${request.ip}|${username.toLowerCase()}`;
    const f = failures.get(key);
    if (f && f.n >= 8 && f.until > Date.now()) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'too many failed attempts; wait 15 minutes');
    const user = store.authenticate(username, password);
    if (!user) {
      failures.set(key, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60_000 });
      throw new HttpError(401, 'BAD_LOGIN', 'wrong user name or password');
    }
    failures.delete(key);
    const { token, expires } = store.createSession(user.id);
    reply.header('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Expires=${expires.toUTCString()}${opts.secureCookies ? '; Secure' : ''}`);
    return publicUser(user, store.spentToday(user.id));
  });

  app.post('/api/logout', async (request, reply) => {
    const token = parseCookies(request.headers.cookie)[COOKIE];
    if (token) store.deleteSession(token);
    reply.header('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });

  app.get('/api/me', async (request) => ({ ...publicUser(me(request), store.spentToday(me(request).id)), demo: opts.demo === true }));

  app.get('/api/locales', async () => {
    const engine = await opts.getEngine();
    return engine.listLocales();
  });

  // ---- jobs -----------------------------------------------------------------------------------------------------
  app.post('/api/jobs', async (request, reply) => {
    const user = me(request);
    const req = NewJob.parse(request.body);
    if (store.queueLength() >= maxQueue) throw new HttpError(503, 'BUSY', 'the queue is full; try again in a few minutes');
    const remaining = user.daily_limit_usd - store.spentToday(user.id);
    if (remaining < 0.05) throw new HttpError(429, 'DAILY_LIMIT', `your daily spending limit of USD ${user.daily_limit_usd} is used up; it resets at 00:00 UTC`);
    const request_ = PipelineRequestSchema.parse({
      input: req.input.kind === 'url' ? { kind: 'url', url: req.input.url } : { kind: 'text', text: req.input.text, format: req.input.format, ...(req.input.name ? { name: req.input.name } : {}) },
      targets: req.targets,
      options: { ...(req.keyword ? { primary_keyword: req.keyword } : {}) },
    });
    const id = randomUUID();
    const ceiling = Math.round(Math.min(jobCeiling, remaining) * 100) / 100;
    const ref = req.input.kind === 'url' ? req.input.url : req.input.name || `pasted ${req.input.format} (${req.input.text.length} characters)`;
    const job = store.createJob({ id, user_id: user.id, input_kind: req.input.kind, input_ref: ref, targets: req.targets, ceiling_usd: ceiling });
    runner.enqueue(id, request_);
    return reply.code(202).send(publicJob(job));
  });

  app.get('/api/jobs', async (request) => {
    const user = me(request);
    const all = (request.query as { all?: string }).all === '1' && user.role === 'admin';
    return { jobs: store.listJobs(all ? null : user.id).map(publicJob) };
  });

  app.get('/api/jobs/:id', async (request) => publicJob(ownJob(request, (request.params as { id: string }).id)));

  app.get('/api/jobs/:id/report', async (request) => {
    const job = ownJob(request, (request.params as { id: string }).id);
    if (job.status !== 'done' || !job.output_dir) throw new HttpError(409, 'NOT_READY', 'this job has no result');
    const run = JSON.parse(readFileSync(path.join(job.output_dir, 'run.json'), 'utf8')) as {
      locales: Array<{ target_locale: string; verdict: string; quality_score: number; recommendations: Array<{ id: string; text: string; source: string; segment_id: string | null }>; seo_meta: unknown; segments: Array<Record<string, any>> }>;
    };
    return {
      locales: run.locales.map((l) => ({
        locale: l.target_locale,
        verdict: l.verdict,
        score: l.quality_score,
        seo: l.seo_meta,
        recommendations: l.recommendations.map((r) => ({ id: r.id, text: r.text, source: r.source, segment: r.segment_id })),
        segments: l.segments.map((s) => ({
          id: s.segment_id,
          type: s.block_type,
          source: s.source_text,
          final: s.final_text,
          human_review: s.requires_human_review === true,
          changes: (s.changes ?? []).map((c: { from: string; to: string; rule: string }) => ({ from: c.from, to: c.to, rule: c.rule })),
          notes: (s.validation?.findings ?? [])
            .filter((f: { status: string }) => f.status === 'open')
            .map((f: { severity: string; origin: string; rule_or_category: string; explanation: string }) => ({ severity: f.severity, origin: f.origin, rule: f.rule_or_category, text: f.explanation })),
        })),
      })),
    };
  });

  const artifactOf = (job: JobRow, name: string): Buffer => {
    const arts = (job.summary as { artifacts?: string[] } | null)?.artifacts ?? [];
    if (!FILE_NAME.test(name) || !arts.includes(name) || !job.output_dir) throw new HttpError(404, 'NOT_FOUND', 'no such file');
    return readFileSync(path.join(job.output_dir, ...name.split('/')));
  };

  app.get('/api/jobs/:id/file', async (request, reply) => {
    const job = ownJob(request, (request.params as { id: string }).id);
    const name = String((request.query as { name?: string }).name ?? '');
    return sendFile(reply, name.replace('/', '_'), artifactOf(job, name), path.extname(name));
  });

  app.get('/api/jobs/:id/download.zip', async (request, reply) => {
    const job = ownJob(request, (request.params as { id: string }).id);
    if (job.status !== 'done') throw new HttpError(409, 'NOT_READY', 'this job has no result');
    const arts = (job.summary as { artifacts: string[] }).artifacts.filter((a) => FILE_NAME.test(a));
    const zip = zipStored(arts.map((name) => ({ name, data: artifactOf(job, name) })));
    return reply.header('Content-Type', 'application/zip').header('Content-Disposition', 'attachment; filename="translations.zip"').send(zip);
  });

  app.delete('/api/jobs/:id', async (request) => {
    const job = ownJob(request, (request.params as { id: string }).id);
    if (job.status === 'queued' || job.status === 'running') throw new HttpError(409, 'BUSY', 'wait until the job has finished');
    rmSync(runner.jobDir(job.id), { recursive: true, force: true });
    store.deleteJob(job.id);
    return { ok: true };
  });

  // ---- admin ----------------------------------------------------------------------------------------------------
  app.get('/api/admin/users', async () => ({ users: store.listUsers().map((u) => ({ ...publicUser(u, u.spent_today_usd), disabled: u.disabled, jobs: u.jobs, created_at: u.created_at })) }));

  app.post('/api/admin/users', async (request, reply) => {
    const n = NewUser.parse(request.body);
    try {
      const u = store.createUser({ username: n.username, password: n.password, role: n.role, daily_limit_usd: n.daily_limit_usd ?? defaultLimit });
      return reply.code(201).send(publicUser(u, 0));
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) throw new HttpError(409, 'EXISTS', 'that user name is taken');
      throw e;
    }
  });

  app.patch('/api/admin/users/:id', async (request) => {
    const id = Number((request.params as { id: string }).id);
    const patch = PatchUser.parse(request.body);
    if (id === me(request).id && (patch.disabled || patch.role === 'user')) throw new HttpError(400, 'SELF', 'you cannot lock yourself out');
    const u = store.updateUser(id, patch);
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'no such user');
    return publicUser(u, store.spentToday(u.id));
  });

  return { app, runner };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------------------------------------------------------

/** An engine whose stages all run on the offline mock provider (placeholder text, no keys, no cost). */
const demoEngine = createLazyEngine(async () => {
  const { createEngine } = await import('../pipeline/engine.js');
  const { createProviderRegistryAsync } = await import('../providers/registry.js');
  const stages = ['language_detection', 'translation', 'localization', 'validation', 'backtranslation', 'repair'] as const;
  const overrides = Object.fromEntries(stages.map((s) => [s, 'mock']));
  return createEngine({ registryFactory: async (a) => createProviderRegistryAsync({ config: a.config.providers, env: a.env, overrides }) });
});

export async function startWeb(opts: { engine?: () => Promise<Engine>; demo?: boolean; host?: string; port?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunningServer & { admin?: ReturnType<typeof ensureAdmin> }> {
  const env = opts.env ?? process.env;
  const dataDir = path.resolve(env['LOCALE_DATA_DIR'] ?? 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(path.join(dataDir, 'locale.db'));
  const admin = ensureAdmin(store, env);
  const host = opts.host ?? env['LOCALE_WEB_HOST'] ?? (env['PORT'] ? '0.0.0.0' : '127.0.0.1');
  const port = opts.port ?? parsePort(env['LOCALE_WEB_PORT'] ?? env['PORT'] ?? '8080', 'LOCALE_WEB_PORT');
  const allowedHosts = allowedHostnamesFor(host, env);
  const demo = opts.demo ?? env['LOCALE_WEB_DEMO'] === '1';
  const { app, runner } = buildWeb({
    store,
    demo,
    getEngine: opts.engine ?? (demo ? demoEngine : getDefaultEngine),
    dataDir,
    concurrency: Number(env['LOCALE_WEB_CONCURRENCY'] ?? 1),
    jobCeilingUsd: Number(env['LOCALE_WEB_JOB_CEILING_USD'] ?? 2),
    defaultDailyLimitUsd: Number(env['LOCALE_WEB_DAILY_LIMIT_USD'] ?? 10),
    secureCookies: env['LOCALE_WEB_SECURE'] === '1',
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  await app.listen({ host, port });
  const address = app.server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : port;
  return {
    url: `http://${urlHost(host)}:${bound}`,
    port: bound,
    ...(admin ? { admin } : {}),
    close: async () => {
      await app.close();
      await runner.whenIdle();
      store.close();
    },
  };
}

if (isEntryPoint(import.meta.url)) {
  loadDotEnv();
  startWeb()
    .then((s) => {
      process.stdout.write(`locale-web ${toolVersion()} listening on ${s.url}\n`);
      if (s.admin) {
        process.stdout.write(
          `First start: created the administrator "${s.admin.username}"${s.admin.generated ? ` with the password ${s.admin.password} (shown once; change it under Admin)` : ' with the password from LOCALE_ADMIN_PASSWORD'}.\n`,
        );
      }
      if (!process.env['LOCALE_WEB_SECURE'] && !/^(127\.|localhost)/.test(new URL(s.url).hostname)) {
        process.stdout.write('Warning: serving beyond this computer without HTTPS. Put it behind HTTPS (your host does this) and set LOCALE_WEB_SECURE=1.\n');
      }
    })
    .catch(exitOnFatal);
}
