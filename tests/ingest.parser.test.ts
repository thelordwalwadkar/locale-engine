import { describe, expect, it } from 'vitest';
import { isUnsafeUrl, parseHtml, type RawBlock } from '../src/ingest/html_parser.js';
import { placeholderSignature, plainText, renderInlineHtml, tokenizeInline, verifyInline } from '../src/util/inline.js';
import { readFixture } from './fixtures/ingest/helpers.js';

const body = (inner: string): string => `<!doctype html><html><head><title>t</title></head><body>${inner}</body></html>`;
const texts = (blocks: RawBlock[]): string[] => blocks.map((b) => b.text);
const parse = (inner: string): RawBlock[] => parseHtml(body(inner)).blocks;

describe('parseHtml: head metadata', () => {
  const page = parseHtml(readFixture('pumps-nl.html'));

  it('reads lang, title, description, keywords, og tags, og:locale and canonical', () => {
    expect(page.html_lang).toBe('nl');
    expect(page.title).toBe('Dompelpompen voor afvalwater | Van Dijk Pompen');
    expect(page.meta_description).toMatch(/^Dompelpompen voor afvalwater en rioolwater: advies/);
    expect(page.meta_keywords).toBe('dompelpomp, afvalwaterpomp, rioolwaterpomp');
    expect(page.og_title).toBe('Dompelpompen voor afvalwater');
    expect(page.og_description).toBe('Advies, levering en onderhoud van dompelpompen.');
    expect(page.og_locale).toBe('nl_NL');
    expect(page.canonical).toBe('https://www.vandijkpompen.example/producten/dompelpompen');
    expect(page.h1).toBe('Dompelpompen voor afvalwater');
  });

  it('resolves a relative canonical only when a base URL is given', () => {
    const html = '<html><head><link rel="canonical" href="/producten/x"></head><body><p>Hallo wereld</p></body></html>';
    expect(parseHtml(html).canonical).toBe('/producten/x');
    expect(parseHtml(html, { baseUrl: 'https://www.example.nl/a/b' }).canonical).toBe('https://www.example.nl/producten/x');
  });

  it('matches meta names case-insensitively and falls back to xml:lang / content-language', () => {
    const p = parseHtml('<html xml:lang="de-AT"><head><META NAME="Description" CONTENT=" Kurz\n   und gut "><title> A &amp;\n B </title></head><body><p>x</p></body></html>');
    expect(p.meta_description).toBe('Kurz und gut');
    expect(p.title).toBe('A & B');
    expect(p.html_lang).toBe('de-AT');
    const q = parseHtml('<html><head><meta http-equiv="content-language" content="it"></head><body><p>x</p></body></html>');
    expect(q.html_lang).toBe('it');
  });

  it('ignores an <svg><title> and leaves absent fields undefined', () => {
    const p = parseHtml('<html><body><svg><title>icon</title></svg><p>Hallo wereld</p></body></html>');
    expect(p.title).toBeUndefined();
    expect(p.meta_description).toBeUndefined();
    expect(p.html_lang).toBeUndefined();
    expect(p.canonical).toBeUndefined();
  });
});

describe('parseHtml: block types, order and metadata', () => {
  const page = parseHtml(readFixture('pumps-nl.html'));

  it('emits typed blocks in document order', () => {
    expect(page.blocks.map((b) => b.block_type)).toEqual([
      'heading', 'paragraph', 'anchor', 'alt',
      'heading', 'paragraph', 'list_item', 'list_item', 'list_item', 'list_item', 'list_item', 'list_item', 'list_item',
      'heading', 'paragraph',
      'table_cell', 'table_cell', 'table_cell', 'table_cell', 'table_cell', 'table_cell', 'table_cell', 'table_cell', 'table_cell',
    ]);
    expect(page.blocks[0]).toMatchObject({ block_type: 'heading', level: 1, text: 'Dompelpompen voor afvalwater' });
    expect(page.blocks[4]).toMatchObject({ block_type: 'heading', level: 2 });
  });

  it('turns a call-to-action link into an anchor block with its href, without a placeholder', () => {
    expect(page.blocks[2]).toEqual({ block_type: 'anchor', text: 'Vraag een offerte aan', inline: {}, href: '/offerte' });
  });

  it('keeps links inside paragraphs inline', () => {
    const p = page.blocks[5] as RawBlock;
    expect(p.block_type).toBe('paragraph');
    expect(p.inline['a1']).toEqual({ tag: 'a', attrs: { href: '/producten/centrifugaalpompen' } });
  });

  it('numbers list groups across ul/ol, nests with depth and shares the group id with nested items', () => {
    const items = page.blocks.filter((b) => b.block_type === 'list_item');
    expect(items.map((b) => b.group)).toEqual([
      { kind: 'list', id: 'ul-1', ordered: false, index: 0, depth: 0 },
      { kind: 'list', id: 'ul-1', ordered: false, index: 1, depth: 0 },
      { kind: 'list', id: 'ul-1', ordered: false, index: 2, depth: 1 },
      { kind: 'list', id: 'ul-1', ordered: false, index: 3, depth: 1 },
      { kind: 'list', id: 'ul-1', ordered: false, index: 4, depth: 0 },
      { kind: 'list', id: 'ol-2', ordered: true, index: 0, depth: 0 },
      { kind: 'list', id: 'ol-2', ordered: true, index: 1, depth: 0 },
    ]);
    // a parent item carries only its own text, nested items follow it
    expect(items.map((b) => b.text).slice(0, 4)).toEqual([
      'Levering binnen 5 werkdagen in heel Nederland',
      'Eigen servicemonteurs',
      'Storingsdienst dag en nacht',
      'Preventief onderhoud',
    ]);
  });

  it('records table cells with row, column and header flag; the caption becomes a paragraph', () => {
    const cells = page.blocks.filter((b) => b.block_type === 'table_cell');
    expect(cells.map((c) => [c.text, c.group])).toEqual([
      ['Type', { kind: 'table', id: 'tbl-1', row: 0, col: 0, header: true }],
      ['Debiet', { kind: 'table', id: 'tbl-1', row: 0, col: 1, header: true }],
      ['Opvoerhoogte', { kind: 'table', id: 'tbl-1', row: 0, col: 2, header: true }],
      ['DP-50', { kind: 'table', id: 'tbl-1', row: 1, col: 0, header: false }],
      ['450 m³/h', { kind: 'table', id: 'tbl-1', row: 1, col: 1, header: false }],
      ['80 m', { kind: 'table', id: 'tbl-1', row: 1, col: 2, header: false }],
      ['DP-75', { kind: 'table', id: 'tbl-1', row: 2, col: 0, header: false }],
      ['620 m³/h', { kind: 'table', id: 'tbl-1', row: 2, col: 1, header: false }],
      ['95 m', { kind: 'table', id: 'tbl-1', row: 2, col: 2, header: false }],
    ]);
    expect(page.blocks.find((b) => b.text === 'Specificaties van de serie DP-50')?.block_type).toBe('paragraph');
  });

  it('keeps images with real alt text (src verbatim) and skips decorative or alt-less ones', () => {
    const alts = page.blocks.filter((b) => b.block_type === 'alt');
    expect(alts).toEqual([{ block_type: 'alt', text: 'Dompelpomp in een rioolgemaal', inline: {}, src: '/img/dompelpomp-hero.jpg' }]);
    // the header logo has alt text too, but it sits in dropped page chrome
    expect(texts(page.blocks).join('|')).not.toContain('logo');
  });

  it('skips alt text that is just a file name, role=presentation images, and prefers data-src over a data: placeholder', () => {
    const blocks = parse(
      '<main><img src="a.jpg" alt="IMG_0012.jpg"><img src="b.jpg" alt="Pomp" role="presentation">' +
        '<img src="data:image/gif;base64,R0lGOD" data-src="/real.jpg" alt="Pomp in bedrijf"></main>',
    );
    expect(blocks).toEqual([{ block_type: 'alt', text: 'Pomp in bedrijf', inline: {}, src: '/real.jpg' }]);
  });
});

describe('parseHtml: boilerplate removal', () => {
  const page = parseHtml(readFixture('pumps-nl.html'));
  const all = texts(page.blocks).join('\n');

  it.each([
    ['cookie banner', 'cookies'],
    ['navigation menu', 'Producten'],
    ['breadcrumb', 'Home'],
    ['sidebar / newsletter', 'Nieuwsbrief'],
    ['share buttons', 'sociale media'],
    ['footer', 'KvK'],
    ['footer link', 'Privacyverklaring'],
    ['script content', 'dataLayer'],
    ['style content', '#c00'],
  ])('drops the %s', (_what, needle) => {
    expect(all).not.toContain(needle);
  });

  it('removes hidden elements, script-like elements and comments', () => {
    const blocks = parse(
      '<main><p>Zichtbaar</p><p hidden>Verborgen één</p><div aria-hidden="true"><p>Verborgen twee</p></div>' +
        '<p style="color:red; display : none">Verborgen drie</p><p style="visibility:hidden">Verborgen vier</p>' +
        '<noscript><p>Geen script</p></noscript><template><p>Sjabloon</p></template><!-- commentaar --><iframe>frame</iframe>' +
        '<select><option>Kies</option></select><textarea>vrije tekst</textarea></main>',
    );
    expect(texts(blocks)).toEqual(['Zichtbaar']);
  });

  it('drops ARIA landmark equivalents (role=navigation, contentinfo, complementary, search, banner)', () => {
    const blocks = parse(
      '<div role="banner"><p>Bannertekst</p></div><div role="navigation"><p>Menu</p></div><main><p>Inhoud</p></main>' +
        '<div role="complementary"><p>Aanvulling</p></div><div role="search"><p>Zoek</p></div><div role="contentinfo"><p>Voet</p></div>',
    );
    expect(texts(blocks)).toEqual(['Inhoud']);
  });

  it('drops modal dialogs', () => {
    expect(texts(parse('<main><p>Inhoud</p><dialog open><p>Dialoog</p></dialog><div role="dialog"><p>Venster</p></div></main>'))).toEqual(['Inhoud']);
  });

  it('never drops a layout wrapper that only looks like junk by its class name', () => {
    const blocks = parse(
      '<div class="layout has-sidebar"><div class="content"><h2>Kop</h2><p>Hier staat de echte inhoud van de pagina, een lange tekst.</p></div>' +
        '<div class="sidebar"><p>Kort zijbalkje</p></div></div>',
    );
    expect(texts(blocks)).toContain('Hier staat de echte inhoud van de pagina, een lange tekst.');
    expect(texts(blocks)).not.toContain('Kort zijbalkje');
  });

  it('keeps an element that holds the page headline even when its class says banner', () => {
    const blocks = parse('<div class="hero-banner"><h1>Dompelpompen</h1><p>Intro van de pagina.</p></div><div class="cookie-banner"><p>Cookies</p></div>');
    expect(texts(blocks)).toEqual(['Dompelpompen', 'Intro van de pagina.']);
  });

  it('survives a page-wide <form> (ASP.NET) and body classes such as modal-open', () => {
    const html =
      '<html><body class="modal-open has-cookie-banner"><form id="form1" action="/x"><h1>Titel</h1><p>Inhoud van de pagina.</p><input type="text" name="q"></form></body></html>';
    expect(texts(parseHtml(html).blocks)).toEqual(['Titel', 'Inhoud van de pagina.']);
  });

  it('drops a real contact form', () => {
    const blocks = parse('<main><h1>Contact</h1><p>Vul het formulier in.</p><form><label>Naam</label><input name="n"><button>Verstuur</button></form></main>');
    expect(texts(blocks)).toEqual(['Contact', 'Vul het formulier in.']);
  });

  it('keeps article headers and hero headers with a heading, drops site headers with navigation', () => {
    const article = parse('<main><article><header><h1>Artikel</h1><p>Inleiding van het artikel.</p></header><p>Tekst.</p></article></main>');
    expect(texts(article)).toEqual(['Artikel', 'Inleiding van het artikel.', 'Tekst.']);
    const hero = parse('<header class="hero"><h1>Welkom</h1><p>Ondertitel</p></header><p>Verder</p>');
    expect(texts(hero)).toEqual(['Welkom', 'Ondertitel', 'Verder']);
    const site = parse('<header><nav><a href="/">Home</a></nav><span class="logo">Merk</span></header><main><h1>Pagina</h1><p>Tekst.</p></main>');
    expect(texts(site)).toEqual(['Pagina', 'Tekst.']);
  });

  it('restores the page <h1> when it was inside a dropped site header', () => {
    const blocks = parse('<header><nav><a href="/">Home</a></nav><h1>Dompelpompen</h1></header><main><p>Alleen een alinea in main.</p></main>');
    expect(blocks.map((b) => [b.block_type, b.level, b.text])).toEqual([
      ['heading', 1, 'Dompelpompen'],
      ['paragraph', undefined, 'Alleen een alinea in main.'],
    ]);
    // but not when the headline is boilerplate itself
    const cookie = parse('<div class="cookie-banner"><h1>Cookies</h1></div><main><p>Alleen een alinea.</p></main>');
    expect(texts(cookie)).toEqual(['Alleen een alinea.']);
  });
});

describe('parseHtml: main-content choice', () => {
  it('prefers <main>, then a lone <article>, then the dominant content wrapper', () => {
    expect(texts(parse('<p>Buiten</p><main><p>Binnen main</p></main>'))).toEqual(['Binnen main']);
    expect(texts(parse('<div><p>Buiten</p></div><article><p>Binnen artikel dat veel langer is dan de rest</p></article>'))).toEqual([
      'Binnen artikel dat veel langer is dan de rest',
    ]);
    const en = parseHtml(readFixture('pumps-en.html'));
    expect(texts(en.blocks)).not.toContain('Log in');
    expect(texts(en.blocks)).not.toContain('Sign up for news and offers.');
    expect(en.blocks[0]).toMatchObject({ block_type: 'heading', level: 1, text: 'Submersible pumps for wastewater' });
    expect(en.warnings).toEqual([]);
  });

  it('does not trust a <main> that holds almost none of the page text', () => {
    const blocks = parse('<main><p>Laden…</p></main><div><h2>Echte inhoud</h2><p>Dit is de werkelijke tekst van de pagina en die staat buiten main, met veel woorden.</p></div>');
    expect(texts(blocks)).toContain('Dit is de werkelijke tekst van de pagina en die staat buiten main, met veel woorden.');
  });

  it('warns when the whole body had to be used, and when almost nothing was extracted', () => {
    const flat = parseHtml(body('<h1>Kop</h1><p>Een alinea met voldoende woorden om niet als leeg te gelden, en nog wat extra tekst erbij voor de zekerheid.</p><p>Een tweede alinea.</p>'));
    expect(flat.warnings.some((w) => w.includes('could not be isolated'))).toBe(true);
    const fragment = parseHtml(body('<h1>Kop</h1><p>Een alinea met voldoende woorden om niet als leeg te gelden, en nog wat extra tekst erbij voor de zekerheid.</p><p>Een tweede alinea.</p>'), { fragment: true });
    expect(fragment.warnings).toEqual([]);
    const tiny = parseHtml(body('<main><p>Kort</p></main>'));
    expect(tiny.warnings.some((w) => w.includes('very little text'))).toBe(true);
  });

  it('returns no blocks (and does not throw) for empty or chrome-only pages', () => {
    expect(parseHtml('').blocks).toEqual([]);
    expect(parseHtml(body('<nav>Menu</nav><footer>Voet</footer>')).blocks).toEqual([]);
    expect(parseHtml('just text, no tags').blocks.map((b) => b.text)).toEqual(['just text, no tags']);
  });
});

describe('parseHtml: block structure details', () => {
  it('turns bare text in div/section into paragraphs and splits at block children', () => {
    const blocks = parse('<main><div>Losse tekst <b>vet</b><p>Alinea</p>nog meer tekst</div><section>In sectie</section></main>');
    expect(blocks.map((b) => [b.block_type, b.text])).toEqual([
      ['paragraph', 'Losse tekst <b1>vet</b1>'],
      ['paragraph', 'Alinea'],
      ['paragraph', 'nog meer tekst'],
      ['paragraph', 'In sectie'],
    ]);
  });

  it('handles every heading level', () => {
    const blocks = parse('<main><h1>a1</h1><h2>a2</h2><h3>a3</h3><h4>a4</h4><h5>a5</h5><h6>a6</h6></main>');
    expect(blocks.map((b) => b.level)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps a whole-block link an anchor when wrapped in span/button, ignores sibling images, drops buttons without a link', () => {
    const blocks = parse(
      '<main><div><a href="/a"><button>Knop met link</button></a></div><div><span><a href="/b">In span</a></span></div>' +
        '<p><a href="/c">Alinea-link</a></p><div><button>Zonder link</button></div><div><a href="/d">Link met afbeelding</a><img src="x.png" alt="Afbeelding erbij"></div></main>',
    );
    expect(blocks.map((b) => [b.block_type, b.text, b.href])).toEqual([
      ['anchor', 'Knop met link', '/a'],
      ['anchor', 'In span', '/b'],
      ['anchor', 'Alinea-link', '/c'],
      ['anchor', 'Link met afbeelding', '/d'],
      ['alt', 'Afbeelding erbij', undefined],
    ]);
  });

  it('keeps a link inside running text inline even when the text is short', () => {
    const blocks = parse('<main><p>Zie <a href="/x">hier</a></p></main>');
    expect(blocks).toEqual([{ block_type: 'paragraph', text: 'Zie <a1>hier</a1>', inline: { a1: { tag: 'a', attrs: { href: '/x' } } } }]);
  });

  it('treats a block-level link (card) as a container rather than one giant inline link', () => {
    const blocks = parse('<main><a class="card" href="/p"><h3>Pompen</h3><p>Beschrijving van de pompen.</p></a></main>');
    expect(blocks.map((b) => [b.block_type, b.text])).toEqual([
      ['heading', 'Pompen'],
      ['paragraph', 'Beschrijving van de pompen.'],
    ]);
  });

  it('flattens everything inside a table cell into one segment, with <br/> between blocks', () => {
    const blocks = parse(
      '<main><table><tr><th>Naam</th><td><p>Eerste</p><p>Tweede</p></td><td><ul><li>een</li><li>twee</li></ul></td><td></td><td>Laatste</td></tr></table></main>',
    );
    expect(blocks.map((b) => [b.text, b.group])).toEqual([
      ['Naam', { kind: 'table', id: 'tbl-1', row: 0, col: 0, header: true }],
      ['Eerste<br1/>Tweede', { kind: 'table', id: 'tbl-1', row: 0, col: 1, header: false }],
      ['een<br1/>twee', { kind: 'table', id: 'tbl-1', row: 0, col: 2, header: false }],
      // the empty cell at col 3 produces no block, but keeps its column
      ['Laatste', { kind: 'table', id: 'tbl-1', row: 0, col: 4, header: false }],
    ]);
    expect(blocks[1]?.inline).toEqual({ br1: { tag: 'br', attrs: {} } });
  });

  it('numbers several tables and lists and treats <thead> cells as header cells', () => {
    const blocks = parse(
      '<main><ul><li>a</li></ul><table><thead><tr><td>h</td></tr></thead><tbody><tr><td>x</td></tr></tbody></table><ol><li>b</li></ol><table><tr><td>y</td></tr></table></main>',
    );
    expect(blocks.map((b) => b.group)).toEqual([
      { kind: 'list', id: 'ul-1', ordered: false, index: 0, depth: 0 },
      { kind: 'table', id: 'tbl-1', row: 0, col: 0, header: true },
      { kind: 'table', id: 'tbl-1', row: 1, col: 0, header: false },
      { kind: 'list', id: 'ol-2', ordered: true, index: 0, depth: 0 },
      { kind: 'table', id: 'tbl-2', row: 0, col: 0, header: false },
    ]);
  });

  it('handles list items with paragraphs and nested lists of another kind, and a nested list without a parent text', () => {
    const blocks = parse('<main><ul><li><p>Eerste</p></li><li>Tweede<ol><li>Sub</li></ol></li><li><ul><li>Diep</li></ul></li></ul></main>');
    expect(blocks.map((b) => [b.text, b.group?.depth, b.group?.ordered, b.group?.index])).toEqual([
      ['Eerste', 0, false, 0],
      ['Tweede', 0, false, 1],
      ['Sub', 1, true, 2],
      ['Diep', 1, false, 3],
    ]);
  });

  it('reads definition lists, details/summary, blockquotes and figures as paragraphs', () => {
    const blocks = parse(
      '<main><dl><dt>Debiet</dt><dd>450 liter</dd></dl><details><summary>Vraag</summary><p>Antwoord</p></details>' +
        '<blockquote><p>Citaat</p></blockquote><figure><img src="a.jpg" alt="Foto van een pomp"><figcaption>Onderschrift</figcaption></figure></main>',
    );
    expect(blocks.map((b) => [b.block_type, b.text])).toEqual([
      ['paragraph', 'Debiet'],
      ['paragraph', '450 liter'],
      ['paragraph', 'Vraag'],
      ['paragraph', 'Antwoord'],
      ['paragraph', 'Citaat'],
      ['alt', 'Foto van een pomp'],
      ['paragraph', 'Onderschrift'],
    ]);
  });

  it('puts the alt block of an inline image after the paragraph that contains it', () => {
    const blocks = parse('<main><p>Tekst <img src="i.png" alt="Pictogram"> meer tekst</p></main>');
    expect(blocks.map((b) => [b.block_type, b.text])).toEqual([
      ['paragraph', 'Tekst meer tekst'],
      ['alt', 'Pictogram'],
    ]);
  });
});

describe('parseHtml: inline markup and placeholders', () => {
  const page = parseHtml(readFixture('pumps-nl.html'));
  const withInline = page.blocks.filter((b) => Object.keys(b.inline).length > 0);

  it('round-trips through renderInlineHtml', () => {
    const p = page.blocks[5] as RawBlock;
    expect(p.text).toBe(
      'Onze pompen leveren een hoog rendement bij lage kosten. Bekijk ons <a1>assortiment centrifugaalpompen</a1> of lees meer over <em2>onderhoud</em2> en <strong3>garantie</strong3>.<br4/>Bel ons op 020 123 4567.',
    );
    expect(renderInlineHtml(p.text, p.inline)).toBe(
      'Onze pompen leveren een hoog rendement bij lage kosten. Bekijk ons <a href="/producten/centrifugaalpompen">assortiment centrifugaalpompen</a> of lees meer over <em>onderhoud</em> en <strong>garantie</strong>.<br />Bel ons op 020 123 4567.',
    );
  });

  it('numbers placeholders tag+n in document order, each referenced exactly once and properly nested', () => {
    expect(withInline.length).toBeGreaterThan(2);
    for (const b of withInline) {
      const keys = tokenizeInline(b.text).flatMap((t) => (t.kind === 'open' || t.kind === 'self' ? [t.key] : []));
      expect(Object.keys(b.inline).sort()).toEqual([...keys].sort());
      expect(keys.map((k) => Number(/\d+$/.exec(k)?.[0]))).toEqual(keys.map((_, i) => i + 1));
      expect(verifyInline(b.text, b.text).ok).toBe(true);
    }
  });

  it('keeps href, title, target and rel of a link verbatim, and title of abbr', () => {
    const blocks = parse(
      '<main><p>Lees <a href=" /x?a=1&amp;b=2 " title="Titel" target="_blank" rel="noopener nofollow" class="c" id="i">meer</a> over <abbr title="Kilowatt">kW</abbr> en <u>u</u>, <sup>2</sup>, <sub>3</sub>, <code>x</code>, <small>s</small>, <mark>m</mark>, <i>i</i>, <b>b</b>.</p></main>',
    );
    const inline = (blocks[0] as RawBlock).inline;
    expect(inline['a1']).toEqual({ tag: 'a', attrs: { href: ' /x?a=1&b=2 ', title: 'Titel', target: '_blank', rel: 'noopener nofollow' } });
    expect(inline['abbr2']).toEqual({ tag: 'abbr', attrs: { title: 'Kilowatt' } });
    expect(Object.values(inline).map((t) => t.tag)).toEqual(['a', 'abbr', 'u', 'sup', 'sub', 'code', 'small', 'mark', 'i', 'b']);
  });

  it('flattens every other inline element to its text', () => {
    const blocks = parse('<main><p>Een <span class="x">span</span>, <font color="red">font</font>, <cite>cite</cite>, <time>tijd</time>, <label>label</label> en <del>del</del>.</p></main>');
    expect(blocks).toEqual([{ block_type: 'paragraph', text: 'Een span, font, cite, tijd, label en del.', inline: {} }]);
  });

  it('drops empty wrappers, keeps the spacing around them and trims breaks at the edges', () => {
    const blocks = parse('<main><p>a<strong> </strong>b <em></em>c<br>d<br></p><p><br>Start<br><br>Eind<br></p></main>');
    expect(texts(blocks)).toEqual(['a b c<br1/>d', 'Start<br1/><br2/>Eind']);
  });

  it('collapses whitespace, treats NBSP as a space and removes soft hyphens and zero-width spaces', () => {
    const blocks = parse('<main><p>  Hallo&nbsp;&nbsp; wereld \n\t nog eens  </p><p>Kreisel&shy;pumpen und Wasser&#8203;werk</p><p><strong> Hi </strong> daar</p><p>a <br> b</p></main>');
    expect(texts(blocks)).toEqual(['Hallo wereld nog eens', 'Kreiselpumpen und Wasserwerk', '<strong1>Hi </strong1>daar', 'a<br1/>b']);
    expect(plainText(blocks[2]?.text ?? '')).toBe('Hi daar');
  });

  it('decodes entities and stores literal < and > escaped', () => {
    const blocks = parse('<main><p>5 &lt; 6 &amp; 7 &gt; 3 &euro; &copy; &ndash; &#8364;</p></main>');
    expect(texts(blocks)).toEqual(['5 &lt; 6 & 7 &gt; 3 € © – €']);
    expect(plainText(texts(blocks)[0] ?? '')).toBe('5 < 6 & 7 > 3 € © – €');
  });

  it('neutralises page text that looks like a placeholder', () => {
    const blocks = parse(
      '<main><p>De tekst &lt;a1&gt;kwaad&lt;/a1&gt; en &lt;br2/&gt; is geen link, maar <a href="/x">dit</a> wel.</p>' +
        '<p>Voor <a1>eigen element</a1> na</p><p>Code: <code>&lt;strong3&gt;</code></p></main>',
    );
    const first = blocks[0] as RawBlock;
    expect(placeholderSignature(first.text)).toEqual(['close:a1', 'open:a1']);
    expect(first.text).toContain('&lt;a1&gt;kwaad&lt;/a1&gt;');
    expect(plainText(first.text)).toBe('De tekst <a1>kwaad</a1> en <br2/> is geen link, maar dit wel.');
    const html = renderInlineHtml(first.text, first.inline);
    expect(html).toContain('&lt;a1&gt;kwaad&lt;/a1&gt;');
    expect(html.match(/<a /g)).toHaveLength(1);
    // a custom element that merely has a placeholder-like name is just text
    expect(blocks[1]).toEqual({ block_type: 'paragraph', text: 'Voor eigen element na', inline: {} });
    // and the literal text inside <code> cannot become a second placeholder
    expect(placeholderSignature((blocks[2] as RawBlock).text)).toEqual(['close:code1', 'open:code1']);
    expect((blocks[2] as RawBlock).text).toBe('Code: <code1>&lt;strong3&gt;</code1>');
  });

  it('never lets markup in attribute values leak into the text, and escapes it on render', () => {
    const blocks = parse('<main><p><a href="/x" title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">klik</a></p><p>Lees <a href="/y" title="&quot;&gt;&lt;img src=x&gt;">meer</a></p></main>');
    const inline = blocks[1] as RawBlock;
    expect(inline.text).toBe('Lees <a1>meer</a1>');
    expect(renderInlineHtml(inline.text, inline.inline)).toBe('Lees <a href="/y" title="&quot;&gt;&lt;img src=x&gt;">meer</a>');
  });

  it('refuses javascript:, vbscript: and data: link targets (the text stays, the link goes)', () => {
    const blocks = parse(
      '<main><p>Aa <a href="javascript:alert(1)">een</a> bb <a href="  JaVa\tScRiPt:alert(1)">twee</a> cc <a href="data:text/html,x">drie</a> dd <a href="mailto:a@b.nl">vier</a> ee <a href="tel:+31201234567">vijf</a> ff <a href="#top">zes</a> gg <a>zeven</a> hh <a href="">acht</a></p>' +
        '<p><a href="javascript:void(0)">Alleen script</a></p></main>',
    );
    const p = blocks[0] as RawBlock;
    expect(Object.values(p.inline).map((t) => t.attrs['href'])).toEqual(['mailto:a@b.nl', 'tel:+31201234567', '#top']);
    expect(plainText(p.text)).toBe('Aa een bb twee cc drie dd vier ee vijf ff zes gg zeven hh acht');
    expect(blocks[1]).toEqual({ block_type: 'paragraph', text: 'Alleen script', inline: {} });
    expect(isUnsafeUrl('javascript:x')).toBe(true);
    expect(isUnsafeUrl('/javascript:x')).toBe(false);
    expect(isUnsafeUrl('https://example.nl')).toBe(false);
  });
});
