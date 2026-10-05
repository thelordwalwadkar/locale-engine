/** Runs translation jobs one (or a few) at a time in this process and records the outcome in the database. */
import path from 'node:path';
import { toPublicError } from '../interfaces/errors.js';
import type { Engine } from '../pipeline/types.js';
import type { PipelineRequest, RunReport } from '../schemas/index.js';
import type { Store } from './db.js';

export interface JobSummary {
  status: RunReport['status'];
  source: { locale: string; page_type: string; segments: number; words: number };
  locales: Array<{
    locale: string;
    verdict: string;
    score: number;
    open_critical: number;
    open_major: number;
    open_minor: number;
    human_review: number;
    changes: number;
  }>;
  warnings: string[];
  artifacts: string[];
  providers: string[];
}

export function summarize(report: RunReport): JobSummary {
  return {
    status: report.status,
    source: { locale: report.source.source_locale, page_type: report.source.page_type, segments: report.source.segments, words: report.source.words },
    locales: report.locales.map((l) => ({
      locale: l.target_locale,
      verdict: l.verdict,
      score: l.quality_score,
      open_critical: l.counts.findings_critical,
      open_major: l.counts.findings_major,
      open_minor: l.counts.findings_minor,
      human_review: l.counts.human_review_segments,
      changes: l.counts.changes,
    })),
    warnings: [...new Set(report.run_log.filter((e) => e.level !== 'info' && e.level !== 'debug' && e.code !== 'PROVIDER_OVERRIDE').map((e) => `${e.code}${e.locale ? ` (${e.locale})` : ''}: ${e.message}`))].slice(0, 20),
    artifacts: report.artifacts,
    providers: [...new Set(Object.values(report.routing).map((b) => `${b?.provider}:${b?.model}`))],
  };
}

export class JobRunner {
  private readonly pending: Array<{ id: string; request: PipelineRequest }> = [];
  private active = 0;
  private idle: Array<() => void> = [];

  constructor(
    private readonly store: Store,
    private readonly getEngine: () => Promise<Engine>,
    private readonly opts: { dataDir: string; concurrency: number },
  ) {}

  jobDir(id: string): string {
    return path.join(this.opts.dataDir, 'jobs', id);
  }

  enqueue(id: string, request: PipelineRequest): void {
    this.pending.push({ id, request });
    this.pump();
  }

  /** Resolves when nothing is queued or running (tests, graceful shutdown). */
  whenIdle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  private pump(): void {
    while (this.active < this.opts.concurrency && this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) break;
      this.active++;
      void this.run(next.id, next.request).finally(() => {
        this.active--;
        this.pump();
        if (this.active === 0 && this.pending.length === 0) for (const r of this.idle.splice(0)) r();
      });
    }
  }

  private async run(id: string, request: PipelineRequest): Promise<void> {
    const job = this.store.getJob(id);
    if (!job) return;
    this.store.markRunning(id);
    try {
      const engine = await this.getEngine();
      const report = await engine.runPipeline({
        ...request,
        options: { ...request.options, output_dir: this.jobDir(id), cost_ceiling_usd: job.ceiling_usd },
      });
      this.store.markDone(id, { run_id: report.run_id, output_dir: report.output_dir, cost_usd: report.totals.cost_usd, summary: summarize(report) });
    } catch (e) {
      const { payload } = toPublicError(e);
      this.store.markFailed(id, `${payload.code}: ${payload.message}`);
    }
  }
}
