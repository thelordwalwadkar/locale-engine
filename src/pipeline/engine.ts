/**
 * The service layer. The CLI, the REST API and the MCP server are thin adapters over this object (R6): they validate input with the
 * schemas in `src/schemas/api.ts`, call exactly one method and return its result unchanged.
 */
import path from 'node:path';
import type { ZodType } from 'zod';
import { loadConfig } from '../config/load.js';
import { readRunReport } from '../export/index.js';
import {
  CompareRequestSchema,
  GetRunReportRequestSchema,
  LOCALES,
  PipelineRequestSchema,
  ValidateRequestSchema,
} from '../schemas/index.js';
import type { CompareReport, ListLocalesResponse, LocaleSummary, ProviderRegistry, ProviderTestResult, RunReport } from '../schemas/index.js';
import { ProviderError } from '../schemas/provider.js';
import { EngineError } from '../util/errors.js';
import { RUN_ID_RE, runContent, runValidation } from './orchestrator.js';
import type { OrchestratorDeps } from './orchestrator.js';
import type { Engine, EngineOptions, RegistryFactoryArgs } from './types.js';

function parse<T>(schema: ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new EngineError('INPUT_INVALID', `${what} is invalid — ${issues.join('; ')}`, { issues: r.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })) });
}

async function defaultRegistryFactory(args: RegistryFactoryArgs): Promise<ProviderRegistry> {
  const { createProviderRegistryAsync } = await import('../providers/registry.js');
  return createProviderRegistryAsync({ config: args.config.providers, env: args.env, ...(args.overrides ? { overrides: args.overrides } : {}) });
}

export function createEngine(opts: EngineOptions = {}): Engine {
  const config =
    opts.config ?? loadConfig({ ...(opts.configDir ? { configDir: opts.configDir } : {}), ...(opts.promptsDir ? { promptsDir: opts.promptsDir } : {}) });
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const outputRoot = path.resolve(opts.outputRoot ?? env['LOCALE_OUTPUT_DIR'] ?? 'output');
  const registryFactory = opts.registryFactory ?? defaultRegistryFactory;
  const deps: OrchestratorDeps = {
    config,
    env,
    now,
    outputRoot,
    registryFactory,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.allowPrivateNetworks ? { allowPrivateNetworks: true } : {}),
    ...(opts.documentLoader ? { documentLoader: opts.documentLoader } : {}),
  };

  const engine: Engine = {
    config,

    // async on purpose: invalid input must surface as a rejected promise, never as a synchronous throw
    runPipeline: async (req) => runContent(deps, 'pipeline', parse(PipelineRequestSchema, req, 'run_pipeline request')),
    translateContent: async (req) => runContent(deps, 'translate', parse(PipelineRequestSchema, req, 'translate_content request')),
    localizeContent: async (req) => runContent(deps, 'localize', parse(PipelineRequestSchema, req, 'localize_content request')),
    validateContent: async (req) => runValidation(deps, parse(ValidateRequestSchema, req, 'validate_content request')),

    async compareModels(req): Promise<CompareReport> {
      const r = parse(CompareRequestSchema, req, 'compare_models request');
      const { runComparison } = await import('../compare/index.js');
      const registry = await registryFactory({ config, env });
      return runComparison(r, {
        config,
        runPipeline: (x) => engine.runPipeline(x),
        now,
        describeProvider: (ref) => {
          try {
            const info = registry.get(ref).info;
            return { provider: info.name, model: info.model_id };
          } catch (e) {
            if (e instanceof ProviderError) throw new EngineError('PROVIDER_UNAVAILABLE', e.message);
            throw e;
          }
        },
        defaultJudgeRef: () => config.providers.routing.stages.validation ?? config.providers.routing.default_provider,
        outputRoot,
      });
    },

    listLocales(): ListLocalesResponse {
      const locales: LocaleSummary[] = LOCALES.map((code) => {
        const p = config.locales[code];
        return {
          locale: code,
          language: p.language,
          region: p.region,
          display_name: p.display_name,
          hreflang: p.hreflang,
          description: p.description.replace(/\s+/g, ' ').trim(),
          rule_count: p.effective_rules.length,
          rules: p.effective_rules.map((r) => ({ id: r.id, severity: r.severity, type: r.type, message: r.message })),
          market_checks: p.market_checks.map((m) => ({ id: m.id, text: m.text, applies: m.applies })),
        };
      });
      return { locales };
    },

    async getRunReport(req): Promise<RunReport> {
      const { run_id, output_dir } = parse(GetRunReportRequestSchema, req, 'get_run_report request');
      if (!RUN_ID_RE.test(run_id)) throw new EngineError('INPUT_INVALID', `run_id "${run_id}" is not a valid run id`);
      const dir = output_dir ? path.resolve(output_dir) : path.join(outputRoot, run_id);
      const report = await readRunReport(dir);
      if (report.run_id !== run_id) throw new EngineError('RUN_NOT_FOUND', `${dir} holds run ${report.run_id}, not ${run_id}`);
      return report;
    },

    async testProviders(names): Promise<ProviderTestResult[]> {
      const { testProviders } = await import('../providers/test.js');
      const registry = await registryFactory({ config, env });
      return testProviders(registry, names);
    },
  };
  return engine;
}
