/**
 * CONTRACT of the service layer. The CLI, the REST API and the MCP server are thin adapters over `Engine` (R6: interface parity):
 * they validate input with the schemas in `src/schemas/api.ts`, call exactly one Engine method, and return its result unchanged.
 */
import type { LoadedConfig } from '../config/load.js';
import type {
  CompareReport,
  CompareRequest,
  GetRunReportRequest,
  InputSpec,
  ListLocalesResponse,
  LocalizeRequest,
  PipelineRequest,
  ProviderRegistry,
  ProviderTestResult,
  RunReport,
  SourceDocument,
  Stage,
  TranslateRequest,
  ValidateRequest,
} from '../schemas/index.js';

export interface RegistryFactoryArgs {
  config: LoadedConfig;
  /** Per-run routing overrides: stage -> `provider` or `provider:model-key`. */
  overrides?: Partial<Record<Stage, string>>;
  env: NodeJS.ProcessEnv;
}

export interface EngineOptions {
  /** Pre-loaded configuration (tests). Default: `loadConfig({configDir, promptsDir})`. */
  config?: LoadedConfig;
  configDir?: string;
  promptsDir?: string;
  /** Builds the provider registry for one run. Default: `createProviderRegistry` from `providers/registry.ts`. Tests inject mock providers here. */
  registryFactory?: (args: RegistryFactoryArgs) => ProviderRegistry | Promise<ProviderRegistry>;
  /** Tests: replaces URL/file/text ingestion AND language detection; the returned document is used as is. */
  documentLoader?: (spec: InputSpec) => Promise<SourceDocument>;
  /** HTTP client for URL ingestion (tests). Default: global fetch. */
  fetch?: typeof fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** Parent folder of `<run_id>/` output folders when a request gives no `output_dir`. Default: `LOCALE_OUTPUT_DIR` or `./output`. */
  outputRoot?: string;
  /** Tests only: lets URL ingestion reach loopback servers (overrides `ingest.block_private_networks`). */
  allowPrivateNetworks?: boolean;
}

export interface Engine {
  readonly config: LoadedConfig;
  /** ingest → detect → translate → localize → validate → repair → export. */
  runPipeline(req: PipelineRequest): Promise<RunReport>;
  /** ingest → detect → translate only. */
  translateContent(req: TranslateRequest): Promise<RunReport>;
  /** translate (when needed) + localize; accepts raw content or a page.json from `translate`. */
  localizeContent(req: LocalizeRequest): Promise<RunReport>;
  /** lint + back-translation + judge (+ repair when enabled) on an existing translation. */
  validateContent(req: ValidateRequest): Promise<RunReport>;
  compareModels(req: CompareRequest): Promise<CompareReport>;
  listLocales(): ListLocalesResponse;
  /** Reads `run.json` from `output_dir` (the run folder itself) or, without it, from `<outputRoot>/<run_id>/`. Throws EngineError('RUN_NOT_FOUND'). */
  getRunReport(req: GetRunReportRequest): Promise<RunReport>;
  /** Sends a trivial schema-bound request to each provider (all configured ones when `names` is empty). */
  testProviders(names?: string[]): Promise<ProviderTestResult[]>;
}
