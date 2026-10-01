import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CompareReport } from '../schemas/index.js';
import { buildComparisonWorkbook } from './workbook.js';

const WORKBOOK_FILE = 'model_comparison.xlsx';
const REPORT_FILE = 'compare_report.json';

/**
 * Writes `model_comparison.xlsx` and `compare_report.json` into `dir` (created if needed) and returns their paths relative to it.
 * The JSON is the full report with `output_dir` set to the absolute folder and `artifacts` to the list returned here, so the file
 * describes itself. The workbook does not depend on those two fields.
 */
export async function writeComparisonArtifacts(report: CompareReport, dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const artifacts = [WORKBOOK_FILE, REPORT_FILE];
  await buildComparisonWorkbook(report).xlsx.writeFile(path.join(dir, WORKBOOK_FILE));
  const written: CompareReport = { ...report, output_dir: path.resolve(dir), artifacts: [...artifacts] };
  await writeFile(path.join(dir, REPORT_FILE), `${JSON.stringify(written, null, 2)}\n`, 'utf8');
  return artifacts;
}
