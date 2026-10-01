/** Plumbing shared by the three bins: entry-point detection, the lazily created real engine, server handles, port parsing. */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Engine } from '../pipeline/types.js';
import { ExitError, errorDetail, redactSecrets, usageError } from './errors.js';

/** true when `moduleUrl` (an `import.meta.url`) is the script node was started with; symlinked bins and Windows path casing included. */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    const self = realpathSync(fileURLToPath(moduleUrl));
    const entry = realpathSync(path.resolve(argv1));
    return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

/** Creates the engine on first use, so `--help`, usage errors and `import`s never load config or pipeline code. A failed load is retried next time. */
export function createLazyEngine(load: () => Promise<Engine>): () => Promise<Engine> {
  let engine: Promise<Engine> | undefined;
  return () => {
    engine ??= load().catch((error: unknown) => {
      engine = undefined;
      throw error;
    });
    return engine;
  };
}

export const getDefaultEngine = createLazyEngine(async () => (await import('../pipeline/engine.js')).createEngine());

/** Request bodies above this are refused by both HTTP servers (REST: 413). */
export const DEFAULT_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

/** A listening HTTP server. */
export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/** `0` asks the OS for a free port (tests). */
export function parsePort(value: string, flag = '--port'): number {
  const port = Number(value);
  if (!/^\d{1,5}$/.test(value) || port > 65535) {
    throw usageError(`${flag} expects a port number between 0 and 65535, got '${value}'`);
  }
  return port;
}

/** `::1` -> `[::1]` for use inside a URL. */
export const urlHost = (host: string): string => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);

/** Sets the exit code once stdout and stderr have drained, so piped output is not cut off by an early `process.exit`. */
export function exitWhenFlushed(code: number): void {
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

/** Last resort of a server bin: print what went wrong (no stack unless `LOCALE_DEBUG=1`) and exit. */
export function exitOnFatal(error: unknown): void {
  const debug = process.env['LOCALE_DEBUG'] === '1';
  const message = error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error));
  process.stderr.write(`error: ${message}\n${debug ? `${errorDetail(error)}\n` : ''}`, () =>
    process.exit(error instanceof ExitError ? error.exitCode : 1),
  );
}
