import { existsSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../util/paths.js';

let loaded = false;

/**
 * Load `.env` (current directory first, then the project root) into `process.env` without overriding variables that are
 * already set. Idempotent. Keys live ONLY here / in the environment (spec §4.5).
 */
export function loadDotEnv(): string | null {
  if (loaded) return null;
  loaded = true;
  const candidates = [path.resolve(process.cwd(), '.env'), path.join(projectRoot(), '.env')];
  for (const file of candidates) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return file;
    }
  }
  return null;
}

export function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/** Names and values of every environment variable that looks like a credential (used by the log redactor). */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 8 && /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(k)) out.push(v);
  }
  return out;
}
