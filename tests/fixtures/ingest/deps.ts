/** Real configuration (stages.yaml, _common.yaml) for tests that run the whole ingest / detect flow. */
import { loadConfig } from '../../../src/config/load.js';
import type { IngestDeps } from '../../../src/ingest/index.js';

const config = loadConfig();
export const stages = config.stages;
export const symbolUnits = config.common.entities.symbol_units;

export function ingestDeps(overrides: Partial<IngestDeps> = {}): IngestDeps {
  return { ingest: stages.ingest, classification: stages.page_classification, symbolUnits, ...overrides };
}
