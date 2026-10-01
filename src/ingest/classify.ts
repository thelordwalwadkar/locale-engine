/**
 * CONTENT vs LEGAL (spec §5.2 `edge_legal_page`). The patterns live in `config/stages.yaml -> page_classification`; legal pages
 * are translated but never localised and always go to human review, so a false LEGAL is cheap and a false CONTENT is not.
 */
import type { PageType, StagesConfig } from '../schemas/index.js';
import { compilePattern, matchAll } from '../util/regex.js';

export interface ClassifyInput {
  /** The page URL, or a file name / caller-supplied label (a path such as `/privacyverklaring`). */
  urlOrPath?: string;
  title?: string;
  h1?: string;
  /** A caller-supplied page type always wins. */
  override?: PageType;
}

export interface Classification {
  page_type: PageType;
  evidence: string;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function describeLocation(urlOrPath: string): { label: string; value: string } {
  if (/^https?:\/\//i.test(urlOrPath)) {
    try {
      return { label: 'url path', value: safeDecode(new URL(urlOrPath).pathname) };
    } catch {
      /* fall through: treat it as a plain label */
    }
  }
  const label = urlOrPath.startsWith('/') ? 'url path' : /\.[a-z0-9]{1,5}$/i.test(urlOrPath) ? 'file name' : 'name';
  return { label, value: safeDecode(urlOrPath) };
}

/** The matched fragment of the first pattern that hits `text`, without the path delimiters the URL patterns include. */
function firstHit(patterns: readonly string[], text: string): string | undefined {
  for (const source of patterns) {
    const hit = matchAll(compilePattern(source, 'i'), text)[0];
    if (hit) return hit.text.replace(/^[/_.-]+|[/_.-]+$/g, '');
  }
  return undefined;
}

export function classifyPage(input: ClassifyInput, cfg: StagesConfig['page_classification']): Classification {
  if (input.override !== undefined) {
    return { page_type: input.override, evidence: `page type set by the caller: ${input.override}` };
  }
  const tested: string[] = [];
  if (input.urlOrPath) {
    const { label, value } = describeLocation(input.urlOrPath);
    const hit = firstHit(cfg.legal_url_patterns, value);
    if (hit !== undefined) return { page_type: 'LEGAL', evidence: `${label} "${value}" matches legal pattern "${hit}"` };
    tested.push(`${label} "${value}"`);
  }
  for (const [label, text] of [['title', input.title], ['first heading', input.h1]] as const) {
    if (!text) continue;
    const hit = firstHit(cfg.legal_title_patterns, text);
    if (hit !== undefined) return { page_type: 'LEGAL', evidence: `${label} "${text}" matches legal title pattern "${hit}"` };
    tested.push(`${label} "${text}"`);
  }
  return {
    page_type: 'CONTENT',
    evidence: tested.length > 0 ? `no legal pattern matched the ${tested.join(' or the ')}` : 'no url, title or heading to test; treated as content',
  };
}
