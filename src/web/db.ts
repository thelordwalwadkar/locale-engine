/**
 * The web app's database: users, login sessions and translation jobs, in one SQLite file (Node's built-in `node:sqlite`,
 * nothing to install). Passwords are scrypt hashes, session tokens are stored only as SHA-256 hashes.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type Role = 'admin' | 'user';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface UserRow {
  id: number;
  username: string;
  role: Role;
  /** USD per UTC day this user may spend on model calls. */
  daily_limit_usd: number;
  disabled: boolean;
  created_at: string;
}

export interface JobRow {
  id: string;
  user_id: number;
  status: JobStatus;
  input_kind: 'url' | 'text';
  /** The URL, or a label for pasted text. Never the text itself. */
  input_ref: string;
  targets: string[];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  run_id: string | null;
  output_dir: string | null;
  /** Spend counted against the daily limit: the finished cost, or the reserved ceiling while queued / running. */
  cost_usd: number;
  ceiling_usd: number;
  error: string | null;
  summary: unknown;
}

const SCHEMA = [
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','user')),
    daily_limit_usd REAL NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    input_kind TEXT NOT NULL,
    input_ref TEXT NOT NULL,
    targets TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    run_id TEXT,
    output_dir TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    ceiling_usd REAL NOT NULL DEFAULT 0,
    error TEXT,
    summary TEXT
  )`,
  `CREATE INDEX jobs_user ON jobs(user_id, created_at DESC)`,
];

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [kind, saltHex, hashHex] = stored.split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const now = (): string => new Date().toISOString();

const toUser = (r: Record<string, unknown>): UserRow => ({
  id: Number(r['id']),
  username: String(r['username']),
  role: r['role'] as Role,
  daily_limit_usd: Number(r['daily_limit_usd']),
  disabled: Number(r['disabled']) === 1,
  created_at: String(r['created_at']),
});

const toJob = (r: Record<string, unknown>): JobRow => ({
  id: String(r['id']),
  user_id: Number(r['user_id']),
  status: r['status'] as JobStatus,
  input_kind: r['input_kind'] as 'url' | 'text',
  input_ref: String(r['input_ref']),
  targets: JSON.parse(String(r['targets'])) as string[],
  created_at: String(r['created_at']),
  started_at: (r['started_at'] as string | null) ?? null,
  finished_at: (r['finished_at'] as string | null) ?? null,
  run_id: (r['run_id'] as string | null) ?? null,
  output_dir: (r['output_dir'] as string | null) ?? null,
  cost_usd: Number(r['cost_usd']),
  ceiling_usd: Number(r['ceiling_usd']),
  error: (r['error'] as string | null) ?? null,
  summary: r['summary'] ? JSON.parse(String(r['summary'])) : null,
});

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (row.user_version >= 1) return;
    this.db.exec('BEGIN');
    try {
      for (const sql of SCHEMA) this.db.exec(sql);
      this.db.exec('PRAGMA user_version = 1');
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- users ----------------------------------------------------------------------------------------------------

  createUser(input: { username: string; password: string; role: Role; daily_limit_usd: number }): UserRow {
    const res = this.db
      .prepare('INSERT INTO users (username, password_hash, role, daily_limit_usd, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.username, hashPassword(input.password), input.role, input.daily_limit_usd, now());
    return this.getUser(Number(res.lastInsertRowid)) as UserRow;
  }

  getUser(id: number): UserRow | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return r ? toUser(r) : undefined;
  }

  countUsers(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n);
  }

  listUsers(): Array<UserRow & { spent_today_usd: number; jobs: number }> {
    return this.db
      .prepare('SELECT * FROM users ORDER BY id')
      .all()
      .map((r) => {
        const u = toUser(r);
        return { ...u, spent_today_usd: this.spentToday(u.id), jobs: Number((this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE user_id = ?').get(u.id) as { n: number }).n) };
      });
  }

  /** Returns the user when the password is right and the account is enabled. */
  authenticate(username: string, password: string): UserRow | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    // always hash once, so a wrong user name costs the same time as a wrong password
    const stored = r ? String(r['password_hash']) : hashPassword('x');
    const ok = checkPassword(password, stored);
    if (!r || !ok) return undefined;
    const u = toUser(r);
    return u.disabled ? undefined : u;
  }

  updateUser(id: number, patch: { disabled?: boolean; daily_limit_usd?: number; password?: string; role?: Role }): UserRow | undefined {
    if (patch.disabled !== undefined) this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(patch.disabled ? 1 : 0, id);
    if (patch.daily_limit_usd !== undefined) this.db.prepare('UPDATE users SET daily_limit_usd = ? WHERE id = ?').run(patch.daily_limit_usd, id);
    if (patch.role !== undefined) this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(patch.role, id);
    if (patch.password !== undefined) {
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(patch.password), id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (patch.disabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return this.getUser(id);
  }

  // ---- sessions -------------------------------------------------------------------------------------------------

  createSession(userId: number, days = 7): { token: string; expires: Date } {
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + days * 86_400_000);
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires.toISOString());
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    return { token, expires };
  }

  userForSession(token: string): UserRow | undefined {
    const r = this.db
      .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
      .get(sha256(token), now());
    if (!r) return undefined;
    const u = toUser(r);
    return u.disabled ? undefined : u;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  // ---- jobs -----------------------------------------------------------------------------------------------------

  createJob(j: { id: string; user_id: number; input_kind: 'url' | 'text'; input_ref: string; targets: string[]; ceiling_usd: number }): JobRow {
    this.db
      .prepare(
        "INSERT INTO jobs (id, user_id, status, input_kind, input_ref, targets, created_at, ceiling_usd, cost_usd) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)",
      )
      .run(j.id, j.user_id, j.input_kind, j.input_ref, JSON.stringify(j.targets), now(), j.ceiling_usd, j.ceiling_usd);
    return this.getJob(j.id) as JobRow;
  }

  getJob(id: string): JobRow | undefined {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return r ? toJob(r) : undefined;
  }

  listJobs(userId: number | null, limit = 100): JobRow[] {
    const rows = userId === null
      ? this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
    return rows.map(toJob);
  }

  markRunning(id: string): void {
    this.db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?").run(now(), id);
  }

  markDone(id: string, d: { run_id: string; output_dir: string | null; cost_usd: number; summary: unknown }): void {
    this.db
      .prepare("UPDATE jobs SET status = 'done', finished_at = ?, run_id = ?, output_dir = ?, cost_usd = ?, summary = ? WHERE id = ?")
      .run(now(), d.run_id, d.output_dir, d.cost_usd, JSON.stringify(d.summary), id);
  }

  markFailed(id: string, error: string, costUsd = 0): void {
    this.db.prepare("UPDATE jobs SET status = 'failed', finished_at = ?, error = ?, cost_usd = ? WHERE id = ?").run(now(), error, costUsd, id);
  }

  /** On start-up: a job that was queued or running when the server stopped cannot continue. */
  failInterrupted(): number {
    const r = this.db
      .prepare("UPDATE jobs SET status = 'failed', finished_at = ?, error = 'the server restarted before this job finished', cost_usd = 0 WHERE status IN ('queued','running')")
      .run(now());
    return Number(r.changes);
  }

  queuedIds(): string[] {
    return this.db.prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at").all().map((r) => String(r['id']));
  }

  deleteJob(id: string): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }

  /** Spend since 00:00 UTC, counting a queued or running job at its reserved ceiling. */
  spentToday(userId: number): number {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const r = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM jobs WHERE user_id = ? AND created_at >= ?').get(userId, start.toISOString());
    return Number((r as { s: number }).s);
  }

  queueLength(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get() as { n: number }).n);
  }
}
