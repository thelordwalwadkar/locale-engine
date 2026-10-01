/** Shared setup for the `tests/ingest.*.test.ts` and `tests/detect.*.test.ts` suites. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fixturesDir } from '../../../src/util/paths.js';

export const fixturePath = (name: string): string => path.join(fixturesDir(), 'ingest', name);
export const readFixture = (name: string): string => readFileSync(fixturePath(name), 'utf8');
