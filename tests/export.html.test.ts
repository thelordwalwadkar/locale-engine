import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { renderHtml, toPageJson } from '../src/export/index.js';
import type { LocaleCode, LocaleResult, RunReport } from '../src/schemas/index.js';
import { GOLDEN_LOCALIZED, localeOf, sampleReport, segmentOf } from './fixtures/export/sample-report.js';

function render(mutate?: (report: RunReport, locale: LocaleResult) => void, code: LocaleCode = 'de-CH'): { html: string; $: cheerio.CheerioAPI } {
  const report = sampleReport();
  mutate?.(report, localeOf(report, code));
  const html = renderHtml(toPageJson(report, code));
  return { html, $: cheerio.load(html) };
}

describe('html document', () => {
  it('is a complete HTML5 document with lang, hreflang, title, description and generator', () => {
    const { html, $ } = render();
    expect(html.startsWith('<!doctype html>\n<html lang="de-CH" data-hreflang="de-CH">')).toBe(true);
    expect(html.endsWith('</html>\n')).toBe(true);
    expect($('html').attr('lang')).toBe('de-CH');
    expect($('html').attr('data-hreflang')).toBe('de-CH');
    expect($('head meta[charset]').attr('charset')).toBe('utf-8');
    expect(html.indexOf('<meta charset')).toBeLessThan(html.indexOf('<title>'));
    expect($('head meta[name=viewport]').attr('content')).toContain('width=device-width');
    expect($('head title')).toHaveLength(1);
    expect($('head title').text()).toBe('Kreiselpumpen für die Industrie | Beratung und Wartung');
    expect($('head meta[name=description]').attr('content')).toBe('Kreiselpumpen für Industrie und Wasserwirtschaft. Fordern Sie noch heute eine unverbindliche Offerte an.');
    expect($('head meta[name=generator]').attr('content')).toBe('locale-engine');
    expect($('body > main')).toHaveLength(1);
  });

  it('puts the hreflang code in data-hreflang and a comment, never in a link element', () => {
    const { html, $ } = render(undefined, 'en-NL');
    expect($('link[rel=alternate]')).toHaveLength(0);
    expect(html).toContain('<!-- hreflang: en-NL -->');
    expect($('html').attr('lang')).toBe('en-NL');
  });

  it('is self-contained: inline CSS only, no external resources', () => {
    const { $ } = render();
    expect($('style')).toHaveLength(1);
    expect($('link[rel=stylesheet], script, iframe')).toHaveLength(0);
    expect($('head [href], head [src]')).toHaveLength(0);
  });

  it('falls back to the H1 and then to "Untitled" for the title, and omits an absent description', () => {
    const noTitle = render((_r, locale) => {
      locale.seo_meta.title = null;
      locale.seo_meta.meta_description = null;
      segmentOf(locale, 'meta-title').final_text = null;
      segmentOf(locale, 'meta-title').status = 'PROVIDER_ERROR';
      segmentOf(locale, 'meta-description').status = 'PROVIDER_ERROR';
      segmentOf(locale, 'meta-description').final_text = null;
    });
    expect(noTitle.$('title').text()).toBe('Kreiselpumpen für die Industrie'); // the H1
    expect(noTitle.$('meta[name=description]')).toHaveLength(0);
    expect(noTitle.html).toContain('<!-- title: [PROVIDER_ERROR: meta-title] -->');
    expect(noTitle.html).toContain('<!-- description: [PROVIDER_ERROR: meta-description] -->');

    const empty = render((_r, locale) => {
      locale.seo_meta.title = null;
      locale.segments = [];
    });
    expect(empty.$('title').text()).toBe('Untitled');
  });

  it('is deterministic', () => {
    expect(render().html).toBe(render().html);
  });
});

describe('html blocks', () => {
  it('gives every block its segment id, verdict and review flag', () => {
    const { $ } = render();
    expect($('h1#h-001').text()).toBe('Kreiselpumpen für die Industrie');
    expect($('h2#h-002').text()).toBe('Warum unsere Pumpen?');
    const golden = $('p#p-003');
    expect(golden.text()).toBe(GOLDEN_LOCALIZED);
    expect(golden.attr('data-verdict')).toBe('HUMAN_REVIEW');
    expect(golden.attr('data-review')).toBe('true');
    expect($('p#p-007').attr('data-verdict')).toBe('PASS');
    expect($('p#p-007').attr('data-review')).toBeUndefined();
    expect($('p#p-019').attr('data-verdict')).toBeUndefined(); // never validated
    const ids = $('main [id]').map((_, el) => $(el).attr('id')).get();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(19); // every body segment, no meta segment
  });

  it('keeps blocks in document order', () => {
    const { $ } = render();
    const ids = $('main [id]').map((_, el) => $(el).attr('id')).get();
    expect(ids[0]).toBe('h-001');
    expect(ids.indexOf('p-003')).toBeLessThan(ids.indexOf('li-004'));
    expect(ids.indexOf('li-006')).toBeLessThan(ids.indexOf('p-007'));
    expect(ids.indexOf('td-016')).toBeLessThan(ids.indexOf('alt-017'));
    expect(ids[ids.length - 1]).toBe('p-019');
  });

  it('nests lists by depth and groups items by group id', () => {
    const { $ } = render();
    const top = $('main > ul');
    expect(top).toHaveLength(1);
    expect(top.attr('data-group')).toBe('ul-1');
    expect(top.children('li').map((_, el) => $(el).attr('id')).get()).toEqual(['li-004', 'li-005']);
    const nested = top.children('li#li-005').children('ol');
    expect(nested).toHaveLength(1);
    expect(nested.attr('data-group')).toBe('ul-2');
    expect(nested.children('li#li-006').text()).toBe('Auch am Wochenende erreichbar');
    expect($('li#li-006').parents('li')).toHaveLength(1);
  });

  it('keeps two adjacent top-level lists apart', () => {
    const { $ } = render((_r, locale) => {
      const seg = segmentOf(locale, 'li-005');
      if (seg.group) {
        seg.group.id = 'ol-9';
        seg.group.ordered = true;
      }
      segmentOf(locale, 'li-006').group = { kind: 'list', id: 'ol-9', ordered: true, index: 1, depth: 0 };
    });
    expect($('main > ul > li')).toHaveLength(1);
    expect($('main > ol > li')).toHaveLength(2);
  });

  it('builds tables with a thead of header cells and a tbody', () => {
    const { $ } = render();
    const table = $('main > table');
    expect(table).toHaveLength(1);
    expect(table.attr('data-group')).toBe('tbl-1');
    expect(table.find('thead th').map((_, el) => `${$(el).attr('scope')}:${$(el).attr('id')}`).get()).toEqual(['col:td-008', 'col:td-009', 'col:td-010']);
    expect(table.find('tbody tr')).toHaveLength(2);
    expect(table.find('tbody tr:first-child td').map((_, el) => $(el).text()).get()).toEqual(['CP-100', 'Fördermenge: 450 m³/h', '80 m']);
  });

  it('omits the thead when the table has no header row and scopes row headers', () => {
    const plain = render((_r, locale) => {
      for (const seg of locale.segments) if (seg.group?.kind === 'table') seg.group.header = false;
    });
    expect(plain.$('table thead')).toHaveLength(0);
    expect(plain.$('table tbody tr')).toHaveLength(3);

    const rowHeaders = render((_r, locale) => {
      for (const seg of locale.segments) if (seg.group?.kind === 'table') seg.group.header = seg.group.col === 0;
    });
    expect(rowHeaders.$('table thead')).toHaveLength(0);
    expect(rowHeaders.$('tbody th[scope=row]').map((_, el) => rowHeaders.$(el).text()).get()).toEqual(['Modell', 'CP-100', 'CP-200']);
  });

  it('fills missing table positions with empty cells', () => {
    const { $ } = render((_r, locale) => {
      locale.segments = locale.segments.filter((s) => s.segment_id !== 'td-013');
    });
    const cells = $('tbody tr:first-child td');
    expect(cells).toHaveLength(3);
    expect(cells.eq(2).text()).toBe('');
  });

  it('renders images as figure > img with the source verbatim, and anchors as a call to action', () => {
    const { html, $ } = render();
    const img = $('figure#alt-017 > img');
    expect(img.attr('src')).toBe('/images/pomp-cp100.jpg');
    expect(img.attr('alt')).toBe('Kreiselpumpe CP-100 in einer Fabrikhalle');
    const cta = $('p.cta#a-018 > a');
    expect(cta.attr('href')).toBe('/contact?utm=pompen&ref=nl');
    expect(cta.text()).toBe('Offerte anfordern');
    expect(html).toContain('href="/contact?utm=pompen&amp;ref=nl"');
  });

  it('turns inline placeholders into real tags with their attributes', () => {
    const { html, $ } = render();
    expect($('li#li-004 a').attr('href')).toBe('/pompen?type=cp&maat=large');
    expect($('li#li-005 strong').text()).toBe('erfahrene');
    expect($('p#p-007 br')).toHaveLength(1);
    expect(html).toContain('href="/pompen?type=cp&amp;maat=large"');
  });

  it('shows unresolved segments as a visible error marker inside their block', () => {
    const { $ } = render(undefined, 'en-NL');
    expect($('p#p-019 > span.locale-error').text()).toBe('[PROVIDER_ERROR: p-019]');
    expect($('p#p-019').attr('data-review')).toBe('true');

    const inner = render((_r, locale) => {
      for (const [id, status] of [['li-004', 'PROVIDER_ERROR'], ['td-012', 'NOT_PROCESSED'], ['alt-017', 'PROVIDER_ERROR'], ['a-018', 'NOT_PROCESSED'], ['h-002', 'PROVIDER_ERROR']] as const) {
        const seg = segmentOf(locale, id);
        seg.status = status;
        seg.final_text = null;
      }
    });
    expect(inner.$('li#li-004 .locale-error').text()).toBe('[PROVIDER_ERROR: li-004]');
    expect(inner.$('td#td-012 .locale-error').text()).toBe('[NOT_PROCESSED: td-012]');
    expect(inner.$('figure#alt-017 .locale-error').text()).toBe('[PROVIDER_ERROR: alt-017]');
    expect(inner.$('figure#alt-017 img')).toHaveLength(0);
    expect(inner.$('p.cta#a-018 .locale-error').text()).toBe('[NOT_PROCESSED: a-018]');
    expect(inner.$('p.cta#a-018 a')).toHaveLength(0);
    expect(inner.$('h2#h-002 .locale-error').text()).toBe('[PROVIDER_ERROR: h-002]');
  });

  it('keeps the alt text of an image block without a src visible as a caption', () => {
    const { $ } = render((_r, locale) => {
      delete segmentOf(locale, 'alt-017').src;
    });
    expect($('figure#alt-017 img')).toHaveLength(0);
    expect($('figure#alt-017 figcaption').text()).toBe('Kreiselpumpe CP-100 in einer Fabrikhalle');
  });
});

describe('html escaping (source text is untrusted)', () => {
  const hostile = '<script>alert(1)</script> "quoted" & <img src=x onerror=alert(2)>';

  it('escapes text, attribute values and the head', () => {
    const { html, $ } = render((_r, locale) => {
      segmentOf(locale, 'p-019').final_text = hostile.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      segmentOf(locale, 'p-003').final_text = hostile; // a model that returned raw markup
      segmentOf(locale, 'alt-017').final_text = '" onmouseover="alert(3)" x="';
      segmentOf(locale, 'alt-017').src = '/x.jpg" onerror="alert(4)';
      locale.seo_meta.title = '</title><script>alert(5)</script>';
      locale.seo_meta.meta_description = '"><script>alert(6)</script>';
    });
    expect($('script')).toHaveLength(0);
    expect($('img[onerror], [onmouseover], [onerror]')).toHaveLength(0);
    expect($('p#p-019').text()).toBe(hostile);
    expect($('p#p-003').text()).toBe(hostile);
    expect($('figure#alt-017 img').attr('alt')).toBe('" onmouseover="alert(3)" x="');
    expect($('figure#alt-017 img').attr('src')).toBe('/x.jpg" onerror="alert(4)');
    expect($('title').text()).toBe('</title><script>alert(5)</script>');
    expect($('meta[name=description]').attr('content')).toBe('"><script>alert(6)</script>');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('"quoted" &amp; &lt;img src=x onerror=alert(2)&gt;'); // text nodes keep plain quotes
  });

  it('drops event-handler and style attributes from inline tags and keeps the useful ones', () => {
    const { $ } = render((_r, locale) => {
      segmentOf(locale, 'li-004').inline = {
        a1: { tag: 'a', attrs: { href: '/ok', onclick: 'alert(1)', STYLE: 'x', 'data-x': 'y', title: 'Titel', target: '_blank', rel: 'noopener' } },
      };
    });
    const link = $('li#li-004 a');
    expect(link.attr('href')).toBe('/ok');
    expect(link.attr('title')).toBe('Titel');
    expect(link.attr('target')).toBe('_blank');
    expect(link.attr('rel')).toBe('noopener');
    expect(link.attr('onclick')).toBeUndefined();
    expect(link.attr('style')).toBeUndefined();
    expect(link.attr('data-x')).toBeUndefined();
  });

  it('replaces script-capable URLs with # and keeps the original inert', () => {
    const { html, $ } = render((_r, locale) => {
      segmentOf(locale, 'li-004').inline = { a1: { tag: 'a', attrs: { href: ' JaVa\tScRiPt:alert(1)' } } };
      segmentOf(locale, 'a-018').href = 'javascript:alert(2)';
      segmentOf(locale, 'alt-017').src = 'data:text/html;base64,PHNjcmlwdD4=';
    });
    expect($('li#li-004 a').attr('href')).toBe('#');
    expect($('li#li-004 a').attr('data-blocked-href')).toBe(' JaVa\tScRiPt:alert(1)');
    expect($('p.cta a').attr('href')).toBe('#');
    expect($('p.cta a').attr('data-blocked-href')).toBe('javascript:alert(2)');
    expect($('figure#alt-017 img').attr('src')).toBe('#');
    expect($('figure#alt-017 img').attr('data-blocked-src')).toBe('data:text/html;base64,PHNjcmlwdD4=');
    expect(html).not.toMatch(/\shref="\s*javascript:/i); // data-blocked-href may hold the original
  });

  it('lets harmless URLs through verbatim, including inline image data', () => {
    const { $ } = render((_r, locale) => {
      segmentOf(locale, 'alt-017').src = 'data:image/png;base64,iVBORw0KGgo=';
      segmentOf(locale, 'a-018').href = 'mailto:info@example.nl?subject=Offerte%20CP-100';
    });
    expect($('figure#alt-017 img').attr('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect($('p.cta a').attr('href')).toBe('mailto:info@example.nl?subject=Offerte%20CP-100');
  });

  it('cannot break out of the HTML comments it writes', () => {
    const { html } = render((_r, locale) => {
      locale.hreflang = 'de-CH --> <script>alert(1)</script>';
      segmentOf(locale, 'meta-title').requires_human_review = true;
      segmentOf(locale, 'meta-title').segment_id = 'meta--title-->x';
    });
    expect(html).not.toContain('<script>');
    const comments = [...html.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1] as string);
    expect(comments.length).toBeGreaterThan(0);
    for (const c of comments) expect(c).not.toContain('--');
  });
});
