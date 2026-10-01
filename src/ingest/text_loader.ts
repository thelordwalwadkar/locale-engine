/**
 * Local content -> `ParsedHtml` (the same shape `parseHtml` produces, so the segmenter treats every input alike).
 *   .html/.htm       -> parseHtml
 *   .md/.markdown    -> YAML front matter (title, description, slug, keywords, lang) + marked -> HTML -> parseHtml
 *   .txt             -> blank-line separated paragraphs; a short unpunctuated first line is the heading
 *   .docx            -> mammoth -> HTML -> parseHtml (headings, lists and tables survive; images only when they carry alt text)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import { marked } from 'marked';
import { parse as parseYaml } from 'yaml';
import { EngineError, errorMessage } from '../util/errors.js';
import { escapeLiteral } from '../util/inline.js';
import { decodeBytes } from './charset.js';
import { collapseSpace, parseHtml, type ParsedHtml, type RawBlock } from './html_parser.js';

export type TextFormat = 'html' | 'markdown' | 'text';

const SUPPORTED_EXTENSIONS = ['.html', '.htm', '.md', '.markdown', '.txt', '.docx'];
/** A first line at most this long (and not ending in punctuation) is a title rather than a sentence. */
const MAX_TEXT_HEADING_CHARS = 80;

function absoluteHttpUrl(name: string | undefined): string | undefined {
  return name !== undefined && /^https?:\/\//i.test(name) ? name : undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
}

/** Only a YAML *mapping* between `---` fences counts; anything else (a thematic break, prose) stays in the document. */
function splitFrontMatter(md: string): FrontMatter | undefined {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(md);
  if (!m) return undefined;
  let data: unknown;
  try {
    data = parseYaml(m[1] ?? '');
  } catch {
    return undefined;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  return { data: data as Record<string, unknown>, body: md.slice(m[0].length) };
}

function parseMarkdown(md: string, name: string | undefined): ParsedHtml {
  const fm = splitFrontMatter(md);
  const html = marked.parse(fm ? fm.body : md, { async: false, gfm: true });
  const baseUrl = absoluteHttpUrl(name);
  const parsed = parseHtml(html, { fragment: true, ...(baseUrl ? { baseUrl } : {}) });
  if (!fm) return parsed;
  const title = str(fm.data['title']);
  const description = str(fm.data['description']);
  const slug = str(fm.data['slug']);
  const keywords = Array.isArray(fm.data['keywords'])
    ? fm.data['keywords'].map(str).filter((k): k is string => k !== undefined).join(', ')
    : str(fm.data['keywords']);
  const lang = str(fm.data['lang']) ?? str(fm.data['language']) ?? str(fm.data['locale']);
  if (title) parsed.title = title;
  if (description) parsed.meta_description = description;
  if (slug) parsed.slug = slug;
  if (keywords) parsed.meta_keywords = keywords;
  if (lang) parsed.html_lang = lang;
  return parsed;
}

function parseText(text: string): ParsedHtml {
  const chunks = text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((chunk) => chunk.split('\n').map((line) => collapseSpace(line).trim()).filter((line) => line !== ''))
    .filter((lines) => lines.length > 0);
  const out: ParsedHtml = { blocks: [], warnings: [] };
  chunks.forEach((lines, i) => {
    const joined = lines.join(' ');
    const isHeading = i === 0 && chunks.length > 1 && lines.length === 1 && joined.length <= MAX_TEXT_HEADING_CHARS && !/[.!?:;,…]$/.test(joined);
    const block: RawBlock = isHeading
      ? { block_type: 'heading', level: 1, text: escapeLiteral(joined), inline: {} }
      : { block_type: 'paragraph', text: escapeLiteral(joined), inline: {} };
    out.blocks.push(block);
    if (isHeading) out.h1 = joined;
  });
  return out;
}

/**
 * Content of a `kind: 'text'` input. `name` is the caller's label; it only matters here as the base for a relative canonical
 * link when it happens to be an absolute URL.
 */
export function loadText(text: string, format: TextFormat, name?: string): ParsedHtml {
  switch (format) {
    case 'html': {
      const baseUrl = absoluteHttpUrl(name);
      return parseHtml(text, baseUrl ? { baseUrl } : {});
    }
    case 'markdown':
      return parseMarkdown(text, name);
    case 'text':
      return parseText(text);
  }
}

async function readBytes(filePath: string): Promise<Uint8Array> {
  try {
    return await readFile(filePath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const why = code === 'ENOENT' ? 'file not found' : code === 'EISDIR' ? 'is a directory' : errorMessage(e);
    throw new EngineError('INPUT_INVALID', `cannot read ${filePath}: ${why}`, { path: filePath }, e);
  }
}

async function loadDocx(filePath: string): Promise<ParsedHtml> {
  await readBytes(filePath);
  try {
    // Embedded images have no URL; only their alt text matters, so the (large) image data is never read.
    const result = await mammoth.convertToHtml({ path: filePath }, { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) });
    return parseHtml(result.value, { fragment: true });
  } catch (e) {
    throw new EngineError('INPUT_INVALID', `cannot read ${filePath} as a .docx document: ${errorMessage(e)}`, { path: filePath }, e);
  }
}

export async function loadFile(filePath: string): Promise<ParsedHtml> {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new EngineError(
      'UNSUPPORTED_FORMAT',
      `unsupported file type "${ext === '' ? '(none)' : ext}" for ${filePath}; supported: ${SUPPORTED_EXTENSIONS.join(', ')}`,
      { path: filePath },
    );
  }
  if (ext === '.docx') return loadDocx(filePath);
  const bytes = await readBytes(filePath);
  if (ext === '.html' || ext === '.htm') return parseHtml(decodeBytes(bytes, { sniffMeta: true }).text);
  const text = decodeBytes(bytes, { sniffMeta: false }).text;
  return ext === '.txt' ? parseText(text) : parseMarkdown(text, undefined);
}
