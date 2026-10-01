/**
 * Everything a run hands to a human, driven purely by the report schemas (spec §6.5): `<locale>/page.json|md|html`,
 * `localization_report.xlsx`, `executive_summary.md` and `run.json`. No model calls, no network; the same report always renders
 * the same files (the workbook differs only in its zip metadata).
 */
export { renderHtml } from './html.js';
export { renderMarkdown } from './markdown.js';
export { executiveSummary } from './summary.js';
export { readRunReport, toPageJson, writeRunArtifacts } from './write.js';
export { buildReportWorkbook } from './xlsx.js';
