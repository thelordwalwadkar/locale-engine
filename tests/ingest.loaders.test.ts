import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseHtml } from '../src/ingest/html_parser.js';
import { loadFile, loadText } from '../src/ingest/text_loader.js';
import { plainText, renderInlineHtml } from '../src/util/inline.js';
import { fixturePath, readFixture } from './fixtures/ingest/helpers.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'locale-engine-ingest-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tmp = (name: string, content: string | Uint8Array): string => {
  const file = path.join(dir, name);
  writeFileSync(file, content);
  return file;
};
const shape = (p: Awaited<ReturnType<typeof loadFile>>) => p.blocks.map((b) => [b.block_type, b.level, b.text]);

describe('loadFile: html', () => {
  it('parses .html and .htm like parseHtml', async () => {
    const loaded = await loadFile(fixturePath('pumps-nl.html'));
    expect(loaded).toEqual(parseHtml(readFixture('pumps-nl.html')));
    expect(loaded.blocks).toHaveLength(24);
    const htm = await loadFile(tmp('kopie.HTM', readFixture('pumps-en.html')));
    expect(htm.title).toBe('Submersible pumps for wastewater');
  });

  it('decodes a windows-1252 file through its <meta charset>', async () => {
    const html = '<html><head><meta charset="windows-1252"><title>Café</title></head><body><main><p>Crème brûlée voor één persoon</p></main></body></html>';
    const loaded = await loadFile(tmp('latin.html', Buffer.from(html, 'latin1')));
    expect(loaded.title).toBe('Café');
    expect(loaded.blocks.map((b) => b.text)).toEqual(['Crème brûlée voor één persoon']);
  });
});

describe('loadFile: markdown', () => {
  it('uses front matter as meta and converts the body', async () => {
    const md = await loadFile(fixturePath('dompelpompen.md'));
    expect(md).toMatchObject({
      title: 'Dompelpompen voor industrie',
      meta_description: 'Advies, levering en onderhoud van dompelpompen voor de industrie.',
      slug: 'dompelpompen-industrie',
      meta_keywords: 'dompelpomp, industriepomp',
      html_lang: 'nl',
      h1: 'Dompelpompen voor de industrie',
      warnings: [],
    });
    expect(shape(md).slice(0, 3)).toEqual([
      ['heading', 1, 'Dompelpompen voor de industrie'],
      ['paragraph', undefined, 'Onze <strong1>dompelpompen</strong1> zijn ontworpen voor continu bedrijf. Bekijk ook onze <a2>centrifugaalpompen</a2> of bel ons op 020 123 4567.'],
      ['heading', 2, 'Voordelen'],
    ]);
    const p = md.blocks[1];
    expect(renderInlineHtml(p?.text ?? '', p?.inline)).toContain('<a href="/producten/centrifugaalpompen">centrifugaalpompen</a>');
    expect(md.blocks.filter((b) => b.block_type === 'list_item').map((b) => [b.text, b.group?.depth])).toEqual([
      ['Hoog rendement bij lage kosten', 0],
      ['Eenvoudig onderhoud', 0],
      ['Inspectie zonder demontage', 1],
      ['Reserveonderdelen uit voorraad', 1],
    ]);
    expect(md.blocks.filter((b) => b.block_type === 'table_cell').map((b) => [b.text, b.group?.header])).toEqual([
      ['Type', true], ['Debiet', true], ['DP-50', false], ['450 m³/h', false], ['DP-75', false], ['620 m³/h', false],
    ]);
    expect(md.blocks.find((b) => b.block_type === 'alt')).toMatchObject({ text: 'Dompelpomp in een put', src: '/img/put.jpg' });
    expect(md.blocks.at(-1)).toEqual({ block_type: 'anchor', text: 'Vraag een offerte aan', inline: {}, href: '/offerte' });
  });

  it('works without front matter, and tolerates the odd front matter', async () => {
    const plain = await loadFile(tmp('a.md', '# Kop\n\nTekst met *nadruk*.\n'));
    expect(plain.title).toBeUndefined();
    expect(shape(plain)).toEqual([['heading', 1, 'Kop'], ['paragraph', undefined, 'Tekst met <em1>nadruk</em1>.']]);

    // a leading thematic break is not front matter unless it fences a YAML mapping
    const hr = await loadFile(tmp('b.md', '---\nGewoon een regel\n---\n\nTekst erna.\n'));
    expect(hr.title).toBeUndefined();
    expect(hr.blocks.map((b) => b.text)).toContain('Gewoon een regel');
    const broken = await loadFile(tmp('c.md', '---\ntitle: [onvolledig\n---\n\n# Kop\n'));
    expect(broken.title).toBeUndefined();
    expect(broken.blocks.length).toBeGreaterThan(0);
  });

  it('coerces scalar front matter, accepts keywords as a string and lang under several keys', async () => {
    const a = await loadFile(tmp('d.md', '---\ntitle: 2026\nkeywords: pomp, pompen\nlanguage: de-AT\n---\n\nText hier.\n'));
    expect(a).toMatchObject({ title: '2026', meta_keywords: 'pomp, pompen', html_lang: 'de-AT' });
    const b = await loadFile(tmp('e.md', '﻿---\nlocale: it\ntitle:   \n---\n\nTesto qui.\n'));
    expect(b.html_lang).toBe('it');
    expect(b.title).toBeUndefined();
  });

  it('passes raw html in markdown through the same sanitising parser', async () => {
    const md = await loadFile(tmp('f.md', '# Kop\n\n<script>alert(1)</script>\n\n<div hidden>geheim</div>\n\nZichtbaar <a href="javascript:x()">tekst</a>.\n'));
    expect(md.blocks.map((b) => b.text)).toEqual(['Kop', 'Zichtbaar tekst.']);
  });
});

describe('loadFile: text', () => {
  it('reads blank-line separated paragraphs and a short unpunctuated first line as the heading', async () => {
    const txt = await loadFile(fixturePath('offerte.txt'));
    expect(shape(txt)).toEqual([
      ['heading', 1, 'Offerte aanvragen'],
      ['paragraph', undefined, 'Wilt u een vrijblijvende offerte voor een dompelpomp? Vul uw gegevens in en wij nemen binnen twee werkdagen contact met u op.'],
      ['paragraph', undefined, 'Bel ons voor advies op 020 123 4567 of stuur een e-mail naar info@vandijkpompen.example.'],
    ]);
    expect(txt.h1).toBe('Offerte aanvragen');
  });

  it.each([
    ['a long first line', `${'Een heel lange eerste regel zonder punt '.repeat(3)}\n\nTweede alinea.`],
    ['a first line that ends with punctuation', 'Is dit een titel?\n\nTweede alinea.'],
    ['a first line that is not followed by a blank line', 'Titel\nTweede regel van dezelfde alinea\n\nDerde.'],
    ['a document that is only one line', 'Alleen een titel'],
  ])('does not make a heading of %s', async (_name, content) => {
    const r = await loadFile(tmp('t.txt', content));
    expect(r.blocks.every((b) => b.block_type === 'paragraph')).toBe(true);
    expect(r.h1).toBeUndefined();
  });

  it('joins wrapped lines, survives CRLF, BOM and several blank lines, and escapes < and >', async () => {
    const r = await loadFile(tmp('u.txt', '﻿Titel\r\n\r\n\r\nEerste regel\r\n  tweede regel\r\n\r\nMaat < 5 en > 3 <a1>x</a1>\r\n'));
    expect(shape(r)).toEqual([
      ['heading', 1, 'Titel'],
      ['paragraph', undefined, 'Eerste regel tweede regel'],
      ['paragraph', undefined, 'Maat &lt; 5 en &gt; 3 &lt;a1&gt;x&lt;/a1&gt;'],
    ]);
    expect(plainText(r.blocks[2]?.text ?? '')).toBe('Maat < 5 en > 3 <a1>x</a1>');
  });
});

describe('loadFile: docx', () => {
  it('keeps headings, inline formatting, links, lists and tables; images count only with alt text', async () => {
    const docx = await loadFile(fixturePath('pompen.docx'));
    expect(docx.h1).toBe('Dompelpompen voor afvalwater');
    expect(docx.warnings).toEqual([]);
    expect(shape(docx)).toEqual([
      ['heading', 1, 'Dompelpompen voor afvalwater'],
      ['paragraph', undefined, 'Onze pompen zijn <strong1>betrouwbaar</strong1> en worden geleverd met een garantie van twee jaar. Bekijk onze <a2>brochure</a2> voor alle technische gegevens.'],
      ['heading', 2, 'Voordelen'],
      ['list_item', undefined, 'Hoog rendement bij lage kosten'],
      ['list_item', undefined, 'Eigen servicemonteurs'],
      ['table_cell', undefined, 'Type'],
      ['table_cell', undefined, 'Debiet'],
      ['table_cell', undefined, 'DP-50'],
      ['table_cell', undefined, '450 m³/h'],
      ['alt', undefined, 'Dompelpomp in een put'],
      ['paragraph', undefined, 'Neem contact met ons op voor een vrijblijvende offerte.'],
    ]);
    expect(docx.blocks[1]?.inline['a2']).toEqual({ tag: 'a', attrs: { href: 'https://www.vandijkpompen.example/brochure' } });
    expect(docx.blocks[3]?.group).toEqual({ kind: 'list', id: 'ul-1', ordered: false, index: 0, depth: 0 });
    expect(docx.blocks[5]?.group).toEqual({ kind: 'table', id: 'tbl-1', row: 0, col: 0, header: true });
    expect(docx.blocks[7]?.group).toEqual({ kind: 'table', id: 'tbl-1', row: 1, col: 0, header: false });
    // embedded images have no URL, and the image data is never inlined
    expect(docx.blocks[9]).toEqual({ block_type: 'alt', text: 'Dompelpomp in een put', inline: {} });
  });
});

describe('loadFile: errors', () => {
  it('rejects unknown extensions before touching the file', async () => {
    await expect(loadFile(path.join(dir, 'nope.pdf'))).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT', message: expect.stringContaining('.pdf') });
    await expect(loadFile(path.join(dir, 'README'))).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT', message: expect.stringContaining('(none)') });
  });

  it('reports missing files, directories and broken .docx files as INPUT_INVALID', async () => {
    await expect(loadFile(path.join(dir, 'missing.html'))).rejects.toMatchObject({ code: 'INPUT_INVALID', message: expect.stringContaining('file not found') });
    mkdirSync(path.join(dir, 'map.txt'));
    await expect(loadFile(path.join(dir, 'map.txt'))).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    await expect(loadFile(path.join(dir, 'missing.docx'))).rejects.toMatchObject({ code: 'INPUT_INVALID', message: expect.stringContaining('file not found') });
    await expect(loadFile(tmp('kapot.docx', 'this is not a zip file'))).rejects.toMatchObject({ code: 'INPUT_INVALID', message: expect.stringContaining('.docx') });
  });
});

describe('loadText', () => {
  it('handles the three formats', () => {
    expect(loadText('<main><h1>Kop</h1><p>Tekst</p></main>', 'html').blocks.map((b) => b.text)).toEqual(['Kop', 'Tekst']);
    expect(loadText('# Kop\n\nTekst', 'markdown').blocks.map((b) => b.text)).toEqual(['Kop', 'Tekst']);
    expect(loadText('Kop\n\nTekst', 'text').blocks.map((b) => [b.block_type, b.text])).toEqual([['heading', 'Kop'], ['paragraph', 'Tekst']]);
  });

  it('uses an absolute URL as the name to resolve a relative canonical', () => {
    const html = '<html><head><link rel="canonical" href="/a"></head><body><p>Tekst</p></body></html>';
    expect(loadText(html, 'html', 'https://x.nl/b/c').canonical).toBe('https://x.nl/a');
    expect(loadText(html, 'html', '/privacyverklaring').canonical).toBe('/a');
  });

  it('never lets plain text or markdown code create placeholders', () => {
    expect(loadText('Tekst <a1>x</a1>', 'text').blocks[0]).toEqual({ block_type: 'paragraph', text: 'Tekst &lt;a1&gt;x&lt;/a1&gt;', inline: {} });
    const md = loadText('Tekst `<strong2>x</strong2>` en <em>raw</em>', 'markdown').blocks[0];
    expect(md?.text).toBe('Tekst <code1>&lt;strong2&gt;x&lt;/strong2&gt;</code1> en <em2>raw</em2>');
  });
});
