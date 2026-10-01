import { describe, expect, it } from 'vitest';
import { parseHtml, type ParsedHtml, type RawBlock } from '../src/ingest/html_parser.js';
import { buildDocument, type BuildDocumentArgs } from '../src/ingest/segmenter.js';
import { SourceDocumentSchema } from '../src/schemas/index.js';
import { plainText } from '../src/util/inline.js';
import { hashText } from '../src/util/text.js';
import { symbolUnits } from './fixtures/ingest/deps.js';
import { readFixture } from './fixtures/ingest/helpers.js';

function args(parsed: ParsedHtml, extra: Partial<BuildDocumentArgs> = {}): BuildDocumentArgs {
  return {
    origin: { kind: 'file', ref: 'pumps.html' },
    parsed,
    symbolUnits,
    page_type: 'CONTENT',
    page_type_evidence: 'test',
    source_locale: 'nl-NL',
    source_locale_evidence: 'test',
    source_language: 'nl',
    ...extra,
  };
}

const para = (text: string): RawBlock => ({ block_type: 'paragraph', text, inline: {} });
const parsed = (extra: Partial<ParsedHtml> = {}, blocks: RawBlock[] = [para('Onze pompen leveren een hoog rendement.')]): ParsedHtml => ({
  blocks,
  warnings: [],
  ...extra,
});

describe('buildDocument: ids, order and body blocks', () => {
  const doc = buildDocument(args(parseHtml(readFixture('pumps-nl.html')), { slugSource: { url: 'https://www.vandijkpompen.example/producten/dompelpompen-voor-afvalwater' } }));

  it('numbers meta segments first, then body blocks by document order with type prefixes', () => {
    expect(doc.segments.slice(0, 6).map((s) => [s.segment_id, s.order])).toEqual([
      ['meta-title', 1],
      ['meta-description', 2],
      ['meta-slug', 3],
      ['meta-keyword', 4],
      ['meta-og_title', 5],
      ['meta-og_description', 6],
    ]);
    const body = doc.segments.slice(6);
    expect(body.slice(0, 7).map((s) => [s.segment_id, s.block_type, s.order])).toEqual([
      ['h-001', 'heading', 7],
      ['p-002', 'paragraph', 8],
      ['a-003', 'anchor', 9],
      ['alt-004', 'alt', 10],
      ['h-005', 'heading', 11],
      ['p-006', 'paragraph', 12],
      ['li-007', 'list_item', 13],
    ]);
    expect(body.find((s) => s.block_type === 'table_cell')?.segment_id).toBe('td-016');
    expect(body.at(-1)?.order).toBe(doc.segments.length);
    expect(new Set(doc.segments.map((s) => s.segment_id)).size).toBe(doc.segments.length);
  });

  it('pads the body number to three digits and lets it grow beyond 999', () => {
    const many = buildDocument(args(parsed({}, Array.from({ length: 1002 }, (_, i) => para(`Alinea ${i}`)))));
    const ids = many.segments.map((s) => s.segment_id);
    expect(ids[0]).toBe('p-001');
    expect(ids[998]).toBe('p-999');
    expect(ids[999]).toBe('p-1000');
    expect(many.segments[1001]?.order).toBe(1002);
  });

  it('carries level, group, href, src and the inline side table over from the blocks', () => {
    const byId = (id: string) => doc.segments.find((s) => s.segment_id === id);
    expect(byId('h-001')).toMatchObject({ level: 1 });
    expect(byId('a-003')).toMatchObject({ href: '/offerte', inline: {} });
    expect(byId('alt-004')).toMatchObject({ src: '/img/dompelpomp-hero.jpg' });
    expect(byId('li-009')?.group).toEqual({ kind: 'list', id: 'ul-1', ordered: false, index: 2, depth: 1 });
    expect(byId('td-017')?.group).toEqual({ kind: 'table', id: 'tbl-1', row: 0, col: 1, header: true });
    expect(Object.keys(byId('p-006')?.inline ?? {})).toEqual(['a1', 'em2', 'strong3', 'br4']);
  });

  it('computes hash (12 hex of sha1) and translatable (units, codes and numbers are not)', () => {
    for (const s of doc.segments) {
      expect(s.hash).toBe(hashText(s.text));
      expect(s.hash).toMatch(/^[0-9a-f]{12}$/);
    }
    const text = (t: string) => doc.segments.find((s) => s.text === t);
    expect(text('DP-50')?.translatable).toBe(false);
    expect(text('450 m³/h')?.translatable).toBe(false);
    expect(text('80 m')?.translatable).toBe(false);
    expect(text('Debiet')?.translatable).toBe(true);
    expect(text('Waarom kiezen voor onze pompen?')?.translatable).toBe(true);
  });

  it('validates against SourceDocumentSchema', () => {
    expect(() => SourceDocumentSchema.parse(doc)).not.toThrow();
    expect(doc.head).toEqual({ html_lang: 'nl', canonical: 'https://www.vandijkpompen.example/producten/dompelpompen' });
  });
});

describe('buildDocument: meta segments', () => {
  const meta = (d: ReturnType<typeof buildDocument>) => d.segments.filter((s) => s.block_type === 'meta').map((s) => [s.meta_kind, s.text]);

  it('builds title, description, slug words (from the URL), keyword and differing og tags', () => {
    const doc = buildDocument(
      args(parsed({ title: 'Pompen | Merk', meta_description: 'Alle pompen.', og_title: 'Pompen voor u', og_description: 'Alle pompen.', meta_keywords: 'pomp, pompen' }), {
        slugSource: { url: 'https://x.nl/producten/Centrifugaal-Pompen/?a=1' },
      }),
    );
    expect(meta(doc)).toEqual([
      ['title', 'Pompen | Merk'],
      ['description', 'Alle pompen.'],
      ['slug', 'centrifugaal pompen'],
      ['keyword', 'pomp'],
      ['og_title', 'Pompen voor u'],
    ]);
    expect(doc.seo).toEqual({ primary_keyword: { text: 'pomp', origin: 'meta_keywords' }, source_slug: 'centrifugaal pompen' });
  });

  it('omits og tags that repeat the title / description (ignoring case and punctuation)', () => {
    const doc = buildDocument(args(parsed({ title: 'Pompen, voor u!', og_title: 'pompen voor u', meta_description: 'Kort.', og_description: 'KORT' })));
    expect(meta(doc).map(([k]) => k)).toEqual(['title', 'description', 'slug', 'keyword']);
  });

  it('picks the primary keyword: provided > first meta keyword > H1 > title head', () => {
    const p = (extra: Partial<ParsedHtml>) => buildDocument(args(parsed({ title: 'Dompelpompen | Van Dijk', ...extra }), { slugSource: {} })).seo.primary_keyword;
    expect(p({ meta_keywords: 'a, b', h1: 'Kop' })).toEqual({ text: 'a', origin: 'meta_keywords' });
    expect(p({ meta_keywords: ' ; ,', h1: 'Kop' })).toEqual({ text: 'Kop', origin: 'derived_h1' });
    expect(p({})).toEqual({ text: 'Dompelpompen', origin: 'derived_title' });
    const provided = buildDocument(args(parsed({ meta_keywords: 'a' }), { primaryKeyword: '  centrifugaalpomp ' })).seo.primary_keyword;
    expect(provided).toEqual({ text: 'centrifugaalpomp', origin: 'provided' });
    expect(buildDocument(args(parsed({}))).seo.primary_keyword).toBeUndefined();
  });

  it('derives the slug words for files and text from the title head, the front-matter slug or a path-like name', () => {
    const slug = (extra: Partial<ParsedHtml>, slugSource?: BuildDocumentArgs['slugSource']) =>
      buildDocument(args(parsed(extra), slugSource ? { slugSource } : {})).seo.source_slug;
    expect(slug({ title: 'Dompelpompen voor afvalwater | Van Dijk Pompen' })).toBe('dompelpompen voor afvalwater');
    expect(slug({ h1: 'Dompelpompen: een overzicht' })).toBe('dompelpompen een overzicht');
    expect(slug({ title: 'Titel', slug: 'dompelpompen-industrie' })).toBe('dompelpompen industrie');
    // a saved page's canonical link beats a path-like label and the title, but not a front-matter slug or a fetched URL
    const canonical = 'https://x.nl/pompen/pomptypen/centrifugaalpompen/centrifugaalpompen-werking';
    expect(slug({ title: 'Werking centrifugaalpompen | IPG', canonical })).toBe('centrifugaalpompen werking');
    expect(slug({ title: 'Titel', canonical }, { name: '/producten/andere-pagina' })).toBe('centrifugaalpompen werking');
    expect(slug({ title: 'Titel', canonical, slug: 'eigen-slug' })).toBe('eigen slug');
    expect(slug({ title: 'Titel', canonical }, { url: 'https://x.nl/producten/gehaald-adres' })).toBe('gehaald adres');
    expect(slug({ title: 'Titel van de home', canonical: 'https://x.nl/' })).toBe('titel van de home'); // a home-page canonical says nothing
    expect(slug({ title: 'Titel' }, { name: '/producten/dompelpompen-industrie' })).toBe('dompelpompen industrie');
    expect(slug({ title: 'Titel' }, { name: 'Offerte' })).toBe('titel');
    expect(slug({ title: 'Een zeer lange titel met veel meer dan acht woorden erin om af te kappen' })).toBe('een zeer lange titel met veel meer dan');
  });

  it('omits the slug when there is none: home page URL, index files, numeric ids, no title', () => {
    const slug = (u: string) => buildDocument(args(parsed({ title: 'Titel' }), { slugSource: { url: u } })).segments.some((s) => s.meta_kind === 'slug');
    expect(slug('https://x.nl/')).toBe(false);
    expect(slug('https://x.nl/index.html')).toBe(false);
    expect(slug('https://x.nl/producten/12345')).toBe(false);
    expect(slug('https://x.nl/100%-pure')).toBe(false); // malformed percent-escape: nothing usable
    expect(buildDocument(args(parsed({}))).segments.map((s) => s.segment_id)).toEqual(['p-001']);
  });

  it('uses the H1 as the title when there is no <title>, and escapes literal < and > in meta text', () => {
    const doc = buildDocument(args(parsed({ h1: 'Druk < 5 bar', meta_description: 'Waarden > 10' })));
    expect(doc.segments[0]).toMatchObject({ segment_id: 'meta-title', text: 'Druk &lt; 5 bar' });
    expect(doc.segments[1]).toMatchObject({ segment_id: 'meta-description', text: 'Waarden &gt; 10' });
    expect(plainText(doc.segments[0]?.text ?? '')).toBe('Druk < 5 bar');
  });
});

describe('buildDocument: determinism', () => {
  it('produces identical ids, hashes and doc_id for identical input', () => {
    const html = readFixture('pumps-nl.html');
    const a = buildDocument(args(parseHtml(html)));
    const b = buildDocument(args(parseHtml(html)));
    expect(b).toEqual(a);
    expect(b.doc_id).toBe(a.doc_id);
    expect(a.doc_id).toMatch(/^doc-[0-9a-f]{12}$/);
  });

  it('changes the hash of a segment and the doc_id when its text changes, and nothing else', () => {
    const html = readFixture('pumps-nl.html');
    const a = buildDocument(args(parseHtml(html)));
    const b = buildDocument(args(parseHtml(html.replace('Preventief onderhoud', 'Preventief onderhoud en keuring'))));
    const changed = b.segments.filter((s, i) => s.hash !== a.segments[i]?.hash).map((s) => s.segment_id);
    expect(changed).toEqual(['li-010']);
    expect(b.doc_id).not.toBe(a.doc_id);
    expect(b.segments.map((s) => s.segment_id)).toEqual(a.segments.map((s) => s.segment_id));
  });

  it('merges warnings from the caller and the parser without duplicates', () => {
    const doc = buildDocument(args(parsed({ }), { warnings: ['a', 'b'] }));
    expect(doc.warnings).toEqual(['a', 'b']);
    const both = buildDocument(args({ ...parsed(), warnings: ['b', 'c'] }, { warnings: ['a', 'b'] }));
    expect(both.warnings).toEqual(['a', 'b', 'c']);
  });
});
