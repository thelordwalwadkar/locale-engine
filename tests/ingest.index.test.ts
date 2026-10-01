import { describe, expect, it } from 'vitest';
import { ingestInput } from '../src/ingest/index.js';
import { InputSpecSchema, SourceDocumentSchema, type InputSpec } from '../src/schemas/index.js';
import { EngineError } from '../src/util/errors.js';
import { ingestDeps } from './fixtures/ingest/deps.js';
import { fakeFetch, publicLookup } from './fixtures/ingest/fake-fetch.js';
import { fixturePath, readFixture } from './fixtures/ingest/helpers.js';

const fileSpec = (name: string): InputSpec => ({ kind: 'file', path: fixturePath(name) });
const textSpec = (text: string, extra: Partial<Extract<InputSpec, { kind: 'text' }>> = {}): InputSpec => InputSpecSchema.parse({ kind: 'text', text, ...extra });
const noRetry = { ingest: { ...ingestDeps().ingest, max_retries: 0 } };

describe('ingestInput: files', () => {
  it('turns the Dutch pump page into a complete source document', async () => {
    const doc = await ingestInput(fileSpec('pumps-nl.html'), ingestDeps());
    expect(() => SourceDocumentSchema.parse(doc)).not.toThrow();
    expect(doc.origin).toEqual({ kind: 'file', ref: fixturePath('pumps-nl.html') });
    expect(doc).toMatchObject({
      page_type: 'CONTENT',
      source_locale: 'nl-NL',
      source_locale_evidence: '<html lang> "nl" declares nl-NL',
      source_language: 'nl',
      head: { html_lang: 'nl', canonical: 'https://www.vandijkpompen.example/producten/dompelpompen' },
      // a saved page names its own address: the slug words come from the canonical link, not from the title
      seo: { primary_keyword: { text: 'dompelpomp', origin: 'meta_keywords' }, source_slug: 'dompelpompen' },
      warnings: [],
    });
    expect(doc.segments.map((s) => s.segment_id).slice(0, 9)).toEqual([
      'meta-title', 'meta-description', 'meta-slug', 'meta-keyword', 'meta-og_title', 'meta-og_description', 'h-001', 'p-002', 'a-003',
    ]);
    expect(doc.segments.some((s) => s.lang !== undefined)).toBe(false); // detection is a later step
    expect(doc.segments.at(-1)?.order).toBe(doc.segments.length);
  });

  it('reads markdown (front matter slug and language), plain text and docx files', async () => {
    const md = await ingestInput(fileSpec('dompelpompen.md'), ingestDeps());
    expect(md).toMatchObject({ source_locale: 'nl-NL', source_language: 'nl', page_type: 'CONTENT' });
    expect(md.seo).toEqual({ primary_keyword: { text: 'dompelpomp', origin: 'meta_keywords' }, source_slug: 'dompelpompen industrie' });
    expect(md.segments.find((s) => s.segment_id === 'meta-title')?.text).toBe('Dompelpompen voor industrie');

    const txt = await ingestInput(fileSpec('offerte.txt'), ingestDeps());
    expect(txt).toMatchObject({ source_locale: 'und', source_language: 'und', head: {} });
    expect(txt.seo).toEqual({ primary_keyword: { text: 'Offerte aanvragen', origin: 'derived_h1' }, source_slug: 'offerte aanvragen' });
    expect(txt.segments[0]).toMatchObject({ segment_id: 'meta-title', text: 'Offerte aanvragen' });

    const docx = await ingestInput(fileSpec('pompen.docx'), ingestDeps());
    expect(docx.segments.some((s) => s.segment_id.startsWith('alt-'))).toBe(true);
    expect(docx.segments.find((s) => s.block_type === 'alt')?.src).toBeUndefined();
  });

  it('classifies a legal file by its name and keeps the evidence', async () => {
    const doc = await ingestInput(fileSpec('privacyverklaring.html'), ingestDeps());
    expect(doc.page_type).toBe('LEGAL');
    expect(doc.page_type_evidence).toBe('file name "privacyverklaring.html" matches legal pattern "privacyverklaring"');
  });

  it('is deterministic', async () => {
    const a = await ingestInput(fileSpec('pumps-nl.html'), ingestDeps());
    const b = await ingestInput(fileSpec('pumps-nl.html'), ingestDeps());
    expect(b).toEqual(a);
  });
});

describe('ingestInput: text', () => {
  it('ingests html, markdown and plain text and labels the origin', async () => {
    const html = await ingestInput(textSpec('<main><h1>Kop</h1><p>Een alinea over pompen.</p></main>', { format: 'html' }), ingestDeps());
    expect(html.origin).toEqual({ kind: 'text', ref: 'inline text' });
    expect(html.segments.filter((s) => s.block_type !== 'meta').map((s) => s.segment_id)).toEqual(['h-001', 'p-002']);
    const md = await ingestInput(textSpec('# Kop\n\nEen alinea over pompen.', { format: 'markdown', name: 'pompen.md' }), ingestDeps());
    expect(md.origin.ref).toBe('pompen.md');
    const plain = await ingestInput(textSpec('Gewoon een regel tekst over pompen.'), ingestDeps());
    expect(plain.segments.some((s) => s.segment_id === 'p-001')).toBe(true);
  });

  it('uses the caller name for legal-page detection and, when path-like, for the slug', async () => {
    const doc = await ingestInput(textSpec('<main><h1>Voorwaarden</h1><p>Hier staan de voorwaarden van onze dienstverlening.</p></main>', { format: 'html', name: '/privacyverklaring' }), ingestDeps());
    expect(doc.page_type).toBe('LEGAL');
    expect(doc.page_type_evidence).toContain('url path "/privacyverklaring"');
    expect(doc.seo.source_slug).toBe('privacyverklaring');
  });

  it('applies the caller overrides: source locale, primary keyword and page type', async () => {
    const doc = await ingestInput(
      textSpec('<main><h1>Pumps</h1><p>Our pumps are built for continuous duty.</p></main>', { format: 'html' }),
      ingestDeps({ sourceLocale: 'en-GB', primaryKeyword: 'industrial pump', pageType: 'LEGAL' }),
    );
    expect(doc).toMatchObject({
      source_locale: 'en-GB',
      source_locale_evidence: 'declared by the caller: en-GB',
      source_language: 'en',
      page_type: 'LEGAL',
      page_type_evidence: 'page type set by the caller: LEGAL',
      seo: { primary_keyword: { text: 'industrial pump', origin: 'provided' } },
    });
  });

  it('rejects page_json inputs (the pipeline loads those)', async () => {
    await expect(ingestInput({ kind: 'page_json', page: undefined }, ingestDeps())).rejects.toMatchObject({ code: 'INPUT_INVALID' });
  });
});

describe('ingestInput: empty extraction', () => {
  it.each([
    ['only chrome', '<nav>Menu</nav><footer>Voet</footer>'],
    ['only numbers and codes', '<main><p>450</p><p>N-3085</p><table><tr><td>80 m</td></tr></table></main>'],
    ['nothing at all', ''],
    ['whitespace', '   \n  '],
  ])('throws INPUT_INVALID "no translatable content found" for %s', async (_name, html) => {
    const err = await ingestInput(textSpec(html || ' ', { format: 'html' }), ingestDeps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toMatchObject({ code: 'INPUT_INVALID', message: 'no translatable content found' });
  });

  it('does not count meta text as content (a page whose body renders with JavaScript)', async () => {
    const html = '<html><head><title>Webshop</title><meta name="description" content="De beste pompen van Nederland"></head><body><div id="app"></div><script src="/app.js"></script></body></html>';
    await expect(ingestInput(textSpec(html, { format: 'html' }), ingestDeps())).rejects.toMatchObject({ message: 'no translatable content found' });
  });
});

describe('ingestInput: URLs (fake fetch, no network)', () => {
  const page = readFixture('pumps-nl.html');
  const now = () => new Date('2026-09-30T12:00:00.000Z');

  it('fills the origin from the response and warns when robots.txt is missing', async () => {
    const { fetch, calls } = fakeFetch({
      'https://www.vandijkpompen.example/producten/dompelpompen': { body: page, headers: { 'content-type': 'text/html; charset=utf-8' } },
    });
    const doc = await ingestInput({ kind: 'url', url: 'https://www.vandijkpompen.example/producten/dompelpompen' }, ingestDeps({ ...noRetry, fetch, lookup: publicLookup, now }));
    expect(doc.origin).toEqual({
      kind: 'url',
      ref: 'https://www.vandijkpompen.example/producten/dompelpompen',
      final_url: 'https://www.vandijkpompen.example/producten/dompelpompen',
      fetched_at: '2026-09-30T12:00:00.000Z',
      http_status: 200,
      content_type: 'text/html; charset=utf-8',
      robots: 'unknown',
    });
    expect(doc.warnings).toEqual(['robots.txt of https://www.vandijkpompen.example is not available (HTTP 404); fetching is allowed when no robots.txt exists (RFC 9309)']);
    expect(doc.seo.source_slug).toBe('dompelpompen');
    expect(doc.page_type).toBe('CONTENT');
    expect(calls.map((c) => c.url)).toEqual(['https://www.vandijkpompen.example/robots.txt', 'https://www.vandijkpompen.example/producten/dompelpompen']);
  });

  it('records the final URL after a redirect and classifies on it', async () => {
    const { fetch } = fakeFetch({
      'https://www.vandijkpompen.example/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /', headers: { 'content-type': 'text/plain' } },
      'https://www.vandijkpompen.example/privacy': { status: 301, headers: { location: '/nl/privacyverklaring' } },
      'https://www.vandijkpompen.example/nl/privacyverklaring': { body: readFixture('privacyverklaring.html') },
    });
    const doc = await ingestInput({ kind: 'url', url: 'https://www.vandijkpompen.example/privacy' }, ingestDeps({ fetch, lookup: publicLookup, now }));
    expect(doc.origin).toMatchObject({ ref: 'https://www.vandijkpompen.example/privacy', final_url: 'https://www.vandijkpompen.example/nl/privacyverklaring', robots: 'allowed' });
    expect(doc.warnings).toEqual([]);
    expect(doc.page_type).toBe('LEGAL');
    expect(doc.page_type_evidence).toBe('url path "/nl/privacyverklaring" matches legal pattern "privacyverklaring"');
    expect(doc.source_locale).toBe('nl-NL');
  });

  it('ingests markdown and plain text served as such', async () => {
    const { fetch } = fakeFetch({
      'https://docs.example/robots.txt': { body: 'User-agent: *\nAllow: /' },
      'https://docs.example/pompen.md': { body: readFixture('dompelpompen.md'), headers: { 'content-type': 'text/markdown; charset=utf-8' } },
      'https://docs.example/offerte': { body: readFixture('offerte.txt'), headers: { 'content-type': 'text/plain; charset=utf-8' } },
    });
    const deps = ingestDeps({ fetch, lookup: publicLookup });
    const md = await ingestInput({ kind: 'url', url: 'https://docs.example/pompen.md' }, deps);
    expect(md.segments.find((s) => s.segment_id === 'meta-title')?.text).toBe('Dompelpompen voor industrie');
    expect(md.origin.content_type).toBe('text/markdown; charset=utf-8');
    const txt = await ingestInput({ kind: 'url', url: 'https://docs.example/offerte' }, deps);
    expect(txt.segments.find((s) => s.segment_id === 'h-001')?.text).toBe('Offerte aanvragen');
  });

  it('propagates fetch errors unchanged (robots, SSRF, format)', async () => {
    const { fetch } = fakeFetch({
      'https://blocked.example/robots.txt': { body: 'User-agent: *\nDisallow: /' },
      'https://files.example/robots.txt': { status: 404 },
      'https://files.example/brochure.pdf': { body: '%PDF-1.7', headers: { 'content-type': 'application/pdf' } },
    });
    const deps = ingestDeps({ fetch, lookup: publicLookup });
    await expect(ingestInput({ kind: 'url', url: 'https://blocked.example/pagina' }, deps)).rejects.toMatchObject({ code: 'ROBOTS_DISALLOWED' });
    await expect(ingestInput({ kind: 'url', url: 'https://files.example/brochure.pdf' }, deps)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    await expect(ingestInput({ kind: 'url', url: 'http://127.0.0.1/pagina' }, deps)).rejects.toMatchObject({ code: 'URL_BLOCKED' });
  });
});
