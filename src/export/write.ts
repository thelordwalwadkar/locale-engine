/**
 * Writes the deliverables of a run to disk (spec §6.5) and reads a run back from `run.json`. Text files are UTF-8 with LF line
 * endings; `run.json` is written last, so its presence means the run was exported completely.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocaleCode, PageJson, RunReport } from '../schemas/index.js';
import { RunReportSchema, SCHEMA_VERSION } from '../schemas/index.js';
import { EngineError, errorMessage } from '../util/errors.js';
import { renderHtml } from './html.js';
import { renderMarkdown } from './markdown.js';
import { executiveSummary } from './summary.js';
import { buildReportWorkbook } from './xlsx.js';

const RUN_FILE = 'run.json';
/** The locale code becomes a folder name, so it must not be able to leave `dir`. */
const SAFE_FOLDER_NAME = /^[A-Za-z0-9_-]+$/;

/** `<locale>/page.json` content for one locale of a report. */
export function toPageJson(report: RunReport, locale: LocaleCode): PageJson {
  const result = report.locales.find((l) => l.target_locale === locale);
  if (!result) {
    const available = report.locales.map((l) => l.target_locale).join(', ') || 'none';
    throw new EngineError('INPUT_INVALID', `locale ${locale} is not part of run ${report.run_id} (available: ${available})`, {
      run_id: report.run_id,
      locale,
    });
  }
  return { schema_version: SCHEMA_VERSION, run_id: report.run_id, source: report.source, locale: result };
}

const lf = (text: string): string => text.replace(/\r\n?/g, '\n');
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Writes every deliverable of spec §6.5 into `dir` (created if needed): `<locale>/page.json|md|html`, `localization_report.xlsx`,
 * `executive_summary.md` and `run.json` (the full report with `output_dir` and `artifacts` filled in). Returns the paths written,
 * relative to `dir` with forward slashes, in a stable order. Partial and halted runs export whatever exists.
 */
export async function writeRunArtifacts(report: RunReport, dir: string): Promise<string[]> {
  const root = path.resolve(dir);
  await mkdir(root, { recursive: true });

  const written: string[] = [];
  const put = async (relative: string, content: string | Uint8Array): Promise<void> => {
    const file = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? lf(content) : content);
    written.push(relative);
  };

  const done = new Set<LocaleCode>();
  for (const { target_locale: locale } of report.locales) {
    if (done.has(locale)) continue;
    done.add(locale);
    if (!SAFE_FOLDER_NAME.test(locale)) throw new EngineError('INPUT_INVALID', `"${locale}" is not usable as a folder name`, { locale });
    const page = toPageJson(report, locale);
    await put(`${locale}/page.json`, json(page));
    await put(`${locale}/page.md`, renderMarkdown(page, { validated: report.options.stages.validate }));
    await put(`${locale}/page.html`, renderHtml(page));
  }

  const workbook = await buildReportWorkbook(report);
  await put('localization_report.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  await put('executive_summary.md', executiveSummary(report));
  await put(RUN_FILE, json({ ...report, output_dir: root, artifacts: [...written, RUN_FILE] }));
  return written;
}

/** Reads and validates `<dir>/run.json`. Throws EngineError('RUN_NOT_FOUND') when missing and ('CONFIG_INVALID') when it is not a run report. */
export async function readRunReport(dir: string): Promise<RunReport> {
  const file = path.join(path.resolve(dir), RUN_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new EngineError('RUN_NOT_FOUND', `no run report found at ${file}`, { file });
    throw new EngineError('INTERNAL', `cannot read ${file}: ${errorMessage(e)}`, { file }, e);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new EngineError('CONFIG_INVALID', `${file} is not valid JSON: ${errorMessage(e)}`, { file }, e);
  }
  const parsed = RunReportSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, 12).map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new EngineError('CONFIG_INVALID', `${file} is not a valid run report:\n${problems.join('\n')}`, { file });
  }
  return parsed.data;
}
