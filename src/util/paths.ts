import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | undefined;

/** Project root = nearest ancestor of this file that contains the `locale-engine` package.json (works from `src/` and `dist/`). */
export function projectRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pj = path.join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        const name = (JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name;
        if (name === 'locale-engine') return (cachedRoot = dir);
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('locale-engine project root not found (package.json with name "locale-engine")');
}

/** Config directory: explicit argument > LOCALE_CONFIG_DIR > <root>/config. */
export function configDir(override?: string): string {
  return path.resolve(override ?? process.env['LOCALE_CONFIG_DIR'] ?? path.join(projectRoot(), 'config'));
}

/** Prompt templates directory: explicit argument > LOCALE_PROMPTS_DIR > <root>/prompts. */
export function promptsDir(override?: string): string {
  return path.resolve(override ?? process.env['LOCALE_PROMPTS_DIR'] ?? path.join(projectRoot(), 'prompts'));
}

export function fixturesDir(): string {
  return path.join(projectRoot(), 'tests', 'fixtures');
}

export function toolVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.join(projectRoot(), 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
