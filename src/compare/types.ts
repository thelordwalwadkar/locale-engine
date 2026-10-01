/** CONTRACT between the comparison harness and the engine. The harness never imports the pipeline; it is handed these functions. */
import type { LoadedConfig } from '../config/load.js';
import type { PipelineRequest, RunReport } from '../schemas/index.js';

export interface CompareDeps {
  config: LoadedConfig;
  /**
   * Runs one full pipeline. The harness sets `options.providers` to route translation/localization/repair to the candidate and
   * validation/backtranslation to the fixed judge, and `options.write_outputs` to false (the harness writes its own artifacts).
   */
  runPipeline(req: PipelineRequest): Promise<RunReport>;
  now(): Date;
  /** `provider[:model-key]` -> the provider name and the provider-side model id that would serve it. Throws for an unknown provider. */
  describeProvider(ref: string): { provider: string; model: string };
  /** The provider ref the routing table assigns to the validation stage (the default judge). */
  defaultJudgeRef(): string;
  /** Folder under which `<compare_id>/` is written when the request gives no output_dir. */
  outputRoot: string;
}
