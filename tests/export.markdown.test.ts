import * as cheerio from 'cheerio';
import { marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { renderMarkdown, toPageJson } from '../src/export/index.js';
import type { LocaleCode, LocaleResult, PageJson, RunReport, SegmentResult } from '../src/schemas/index.js';
import { GOLDEN_LOCALIZED, localeOf, sampleReport, segmentOf } from './fixtures/export/sample-report.js';

function render(mutate?: (report: RunReport, locale: LocaleResult) => void, code: LocaleCode = 'de-CH'): { md: string; page: PageJson } {
  const report = sampleReport();
  mutate?.(report, localeOf(report, code));
  const page = toPageJson(report, code);
  return { md: renderMarkdown(page), page };
}

/** Front matter as parsed YAML, and the Markdown below it. */
function split(md: string): { front: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)---\n\n?([\s\S]*)$/.exec(md);
  if (!match) throw new Error('no front matter');
  return { front: parseYaml(match[1] as string) as Record<string, unknown>, body: match[2] as string };
}

const html = (md: string): cheerio.CheerioAPI => cheerio.load(marked.parse(md, { async: false, gfm: true }));

/** A locale whose body is exactly these segments (ids p-901…), for structure tests. */
function withBody(locale: LocaleResult, texts: string[], extra: Partial<SegmentResult> = {}): void {
  const template = segmentOf(locale, 'p-003');
  locale.segments = locale.segments.filter((s) => s.block_type === 'meta');
  texts.forEach((text, i) => {
    locale.segments.push({
      ...structuredClone(template),
      segment_id: `p-9${String(i).padStart(2, '0')}`,
      order: 100 + i,
      source_text: text,
      translation: text,
      localized_text: text,
      final_text: text,
      changes: [],
      format_changes: [],
      repairs: [],
      review_reasons: [],
      requires_human_review: false,
      validation: null,
      ...extra,
    });
  });
}

describe('markdown front matter', () => {
  it('carries the keys of the brief, in order, taken from seo_meta', () => {
    const { md } = render();
    const { front } = split(md);
    expect(Object.keys(front)).toEqual(['title', 'description', 'slug', 'hreflang', 'locale', 'verdict', 'quality_score', 'run_id', 'source_locale']);
    expect(front).toMatchObject({
      title: 'Kreiselpumpen für die Industrie | Beratung und Wartung',
      slug: 'kreiselpumpen-industrie',
      hreflang: 'de-CH',
      locale: 'de-CH',
      verdict: 'HUMAN_REVIEW',
      quality_score: 94,
      run_id: 'run-20260930-a1b2c3',
      source_locale: 'nl-NL',
    });
    expect(md.startsWith('---\n')).toBe(true);
  });

  it('is YAML-safe for colons, quotes, #, leading dashes and look-alike scalars', () => {
    const hostile = {
      title: `Pumpen: "Offerte" & mehr # 1 - 'x' @home *bold* [a] {b} %c !d |e >f`,
      description: '- starts with a dash: and has a # hash',
      slug: 'true',
    };
    const { md } = render((report, locale) => {
      locale.seo_meta.title = hostile.title;
      locale.seo_meta.meta_description = hostile.description;
      locale.seo_meta.slug = hostile.slug;
      report.run_id = '20260930';
    });
    const { front } = split(md);
    expect(front['title']).toBe(hostile.title);
    expect(front['description']).toBe(hostile.description);
    expect(front['slug']).toBe('true'); // stays a string, not a boolean
    expect(front['run_id']).toBe('20260930'); // stays a string, not a number
  });

  it('flattens newlines and keeps long values on one line', () => {
    const long = `${'Kreiselpumpen '.repeat(30)}Ende`;
    const { md } = render((_r, locale) => {
      locale.seo_meta.title = 'Zeile eins\nZeile zwei';
      locale.seo_meta.meta_description = long;
    });
    const { front } = split(md);
    expect(front['title']).toBe('Zeile eins Zeile zwei');
    expect(front['description']).toBe(long);
    expect(md.split('\n').filter((l) => l.startsWith('description:'))).toHaveLength(1);
  });

  it('falls back to the meta segments when seo_meta has no value', () => {
    const { md } = render((_r, locale) => {
      locale.seo_meta.title = null;
      locale.seo_meta.slug = null;
    });
    const { front } = split(md);
    expect(front['title']).toBe(segmentOf(localeOfSample(), 'meta-title').final_text);
    expect(front['slug']).toBe('kreiselpumpen-industrie');
  });

  it('shows null for a missing value and a comment for a failed or review-flagged meta segment', () => {
    const { md } = render((_r, locale) => {
      locale.seo_meta.title = null;
      const title = segmentOf(locale, 'meta-title');
      title.status = 'PROVIDER_ERROR';
      title.final_text = null;
      title.requires_human_review = true;
      segmentOf(locale, 'meta-description').requires_human_review = true;
    });
    expect(md).toContain('title: null # [PROVIDER_ERROR: meta-title] review: meta-title');
    expect(md).toMatch(/description: .* # review: meta-description/);
    expect(split(md).front['title']).toBeNull();
  });

  it('shows "n/a (not validated)" instead of the score when validation did not run', () => {
    const { md } = render((_r, locale) => {
      locale.verdict_reasons = ['NOT_VALIDATED: translate-only run [EVIDENCE: options.stages.validate=false]'];
      locale.quality_score = 100;
    });
    const { front } = split(md);
    expect(front['quality_score']).toBe('n/a (not validated)');
    expect(front['verdict']).toBe('HUMAN_REVIEW');
  });

  it('honours the run option passed by the caller, because a page.json has no run options', () => {
    const page = toPageJson(sampleReport(), 'de-CH');
    expect(split(renderMarkdown(page, { validated: false })).front['quality_score']).toBe('n/a (not validated)');
    expect(split(renderMarkdown(page, { validated: true })).front['quality_score']).toBe(94);
    expect(split(renderMarkdown(page)).front['quality_score']).toBe(94);
  });

  it('rounds the score to one decimal', () => {
    const { md } = render((_r, locale) => {
      locale.quality_score = 94.44444444444444;
    });
    expect(split(md).front['quality_score']).toBe(94.4);
  });
});

const localeOfSample = (): LocaleResult => localeOf(sampleReport(), 'de-CH');

describe('markdown body', () => {
  it('renders headings, paragraphs, lists, a table, an image and an anchor in document order', () => {
    const { body } = split(render().md);
    const lines = body.split('\n');
    expect(lines).toContain('# Kreiselpumpen für die Industrie');
    expect(lines).toContain('## Warum unsere Pumpen?');
    const order = ['# Kreiselpumpen', '## Warum', 'Unsere Kreiselpumpen fördern', '- Sehen Sie', '| Modell', '![Kreiselpumpe', '[Offerte anfordern]', 'Unser Service'];
    const positions = order.map((needle) => body.indexOf(needle));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('keeps meta segments out of the body', () => {
    const { body } = split(render().md);
    expect(body).not.toContain('Beratung und Wartung');
    expect(body).not.toContain('kreiselpumpen-industrie');
    expect(body).not.toContain('meta-');
  });

  it('uses final_text and appends a review comment to segments that need a human', () => {
    const { body } = split(render().md);
    expect(body).toContain(`${GOLDEN_LOCALIZED} <!-- review: p-003 -->`);
    expect(body).not.toContain('innerhalb von 5 Werktagen'); // the translation-stage text must not leak
    expect(body.match(/<!-- review:/g)).toHaveLength(1);
  });

  it('renders inline placeholders: links, emphasis and hard breaks', () => {
    const { body } = split(render().md);
    expect(body).toContain('[Pumpenreihe](/pompen?type=cp&maat=large)');
    expect(body).toContain('Beratung durch **erfahrene** Monteure');
    expect(body).toContain('Ab € 1\'250.00 zzgl. MWST, je nach Grösse.  \nRufen Sie uns an');
  });

  it('nests list items under the text of their parent, for bullets and numbers', () => {
    const { body } = split(render().md);
    expect(body).toContain('- Beratung durch **erfahrene** Monteure\n  1. Auch am Wochenende erreichbar');

    const ordered = split(
      render((_r, locale) => {
        for (const id of ['li-004', 'li-005']) {
          const seg = segmentOf(locale, id);
          if (seg.group) seg.group.ordered = true;
        }
      }).md,
    ).body;
    expect(ordered).toContain('1. Sehen Sie sich');
    expect(ordered).toContain('2. Beratung durch **erfahrene** Monteure\n   1. Auch am Wochenende erreichbar');
    // and a Markdown parser agrees with the structure
    const $ = html(ordered);
    expect($('body > ol > li')).toHaveLength(2);
    expect($('body > ol > li:nth-child(2) > ol > li').text()).toContain('Auch am Wochenende erreichbar');
  });

  it('renders a GFM table with its header row', () => {
    const { body } = split(render().md);
    expect(body).toContain('| Modell | Fördermenge | Förderhöhe |\n| --- | --- | --- |\n| CP-100 | Fördermenge: 450 m³/h | 80 m |\n| CP-200 | 900 m³/h | 95 m |');
    const $ = html(body);
    expect($('table thead th').map((_, el) => $(el).text()).get()).toEqual(['Modell', 'Fördermenge', 'Förderhöhe']);
    expect($('table tbody tr')).toHaveLength(2);
  });

  it('gives a table without a header row an empty header instead of promoting a data row', () => {
    const { body } = split(
      render((_r, locale) => {
        for (const seg of locale.segments) if (seg.group?.kind === 'table') seg.group.header = false;
      }).md,
    );
    expect(body).toContain('|  |  |  |\n| --- | --- | --- |\n| Modell | Fördermenge | Förderhöhe |');
    const $ = html(body);
    expect($('table tbody tr')).toHaveLength(3);
  });

  it('keeps missing table positions as empty cells', () => {
    const { body } = split(
      render((_r, locale) => {
        locale.segments = locale.segments.filter((s) => s.segment_id !== 'td-013');
      }).md,
    );
    expect(body).toContain('| CP-100 | Fördermenge: 450 m³/h |  |');
  });

  it('renders image alt text and anchors with their own targets', () => {
    const { body } = split(render().md);
    expect(body).toContain('![Kreiselpumpe CP-100 in einer Fabrikhalle](/images/pomp-cp100.jpg)');
    expect(body).toContain('[Offerte anfordern](/contact?utm=pompen&ref=nl)');
  });

  it('marks unresolved segments visibly, also inside lists and tables', () => {
    const { body } = split(
      render((_r, locale) => {
        const p = segmentOf(locale, 'p-003');
        p.status = 'NOT_PROCESSED';
        p.final_text = null;
        const li = segmentOf(locale, 'li-004');
        li.status = 'PROVIDER_ERROR';
        li.final_text = null;
        const td = segmentOf(locale, 'td-012');
        td.status = 'NOT_PROCESSED';
        td.final_text = null;
        const h = segmentOf(locale, 'h-002');
        h.status = 'PROVIDER_ERROR';
        h.final_text = null;
      }).md,
    );
    expect(body).toContain('> [NOT_PROCESSED: p-003] <!-- review: p-003 -->');
    expect(body).toContain('- [PROVIDER_ERROR: li-004]');
    expect(body).toContain('| CP-100 | [NOT_PROCESSED: td-012] | 80 m |');
    expect(body).toContain('> [PROVIDER_ERROR: h-002]');
    expect(body).not.toContain('Unsere Kreiselpumpen fördern');
  });

  it('marks the provider-error segment of en-NL', () => {
    const { body } = split(render(undefined, 'en-NL').md);
    expect(body).toContain('> [PROVIDER_ERROR: p-019] <!-- review: p-019 -->');
  });

  it('reports an OK segment without text as NO_OUTPUT instead of rendering nothing', () => {
    const { body } = split(
      render((_r, locale) => {
        segmentOf(locale, 'h-002').final_text = null;
      }).md,
    );
    expect(body).toContain('> [NO_OUTPUT: h-002]');
  });
});

describe('markdown escaping (source text is untrusted)', () => {
  const blockLookalikes = ['1. Einleitung', '2026. Das Jahr der Pumpe', '# Kein Titel', '- Kein Punkt', '* Kein Stern', '+ Kein Plus', '> Kein Zitat', '---', '===', '***', '```js', '~~~', '    eingerückt'];

  it('does not let paragraph text turn into another kind of block', () => {
    const { body } = split(render((_r, locale) => withBody(locale, blockLookalikes)).md);
    const $ = html(body);
    const top = $('body').children().map((_, el) => el.tagName).get();
    expect(top).toEqual(blockLookalikes.map(() => 'p'));
    expect($('p').map((_, el) => $(el).text()).get()).toEqual(blockLookalikes.map((t) => t.trim()));
  });

  it('never emits raw HTML from literal "<" in prose', () => {
    const { body } = split(
      render((_r, locale) => withBody(locale, ['Druck &lt; 5 bar und &lt;script&gt;alert(1)&lt;/script&gt;', 'Roh <script>alert(2)</script> und <img src=x onerror=alert(3)>'])).md,
    );
    const $ = html(body);
    expect($('script, img')).toHaveLength(0);
    expect($('p').eq(0).text()).toBe('Druck < 5 bar und <script>alert(1)</script>');
    expect($('p').eq(1).text()).toBe('Roh <script>alert(2)</script> und <img src=x onerror=alert(3)>');
  });

  it('keeps a backslash before punctuation literal', () => {
    const { body } = split(render((_r, locale) => withBody(locale, ['Pfad C:\\temp\\*.txt und \\_x'])).md);
    expect(html(body)('p').text()).toBe('Pfad C:\\temp\\*.txt und \\_x');
  });

  it('escapes pipes in table cells and turns hard breaks into <br>', () => {
    const { body } = split(
      render((_r, locale) => {
        const cell = segmentOf(locale, 'td-013');
        cell.final_text = 'a | b<br1/>c';
        cell.inline = { br1: { tag: 'br', attrs: {} } };
      }).md,
    );
    expect(body).toContain('| CP-100 | Fördermenge: 450 m³/h | a \\| b<br>c |');
    const $ = html(body);
    expect($('tbody tr:first-child td')).toHaveLength(3);
    expect($('tbody tr:first-child td:last-child').html()).toBe('a | b<br>c');
  });

  it('keeps link destinations valid and neutralises script URLs', () => {
    const { body } = split(
      render((_r, locale) => {
        segmentOf(locale, 'li-004').inline = { a1: { tag: 'a', attrs: { href: '/pompen (gross)/a b?x=1|2' } } };
        const anchor = segmentOf(locale, 'a-018');
        anchor.href = 'javascript:alert(1)';
        segmentOf(locale, 'alt-017').src = 'data:text/html,<script>alert(1)</script>';
      }).md,
    );
    expect(body).toContain('[Pumpenreihe](/pompen%20%28gross%29/a%20b?x=1%7C2)');
    expect(body).toContain('[Offerte anfordern](#)');
    expect(body).toContain('![Kreiselpumpe CP-100 in einer Fabrikhalle](#)');
    expect(body.toLowerCase()).not.toContain('javascript:');
    const $ = html(body);
    expect($('li a').attr('href')).toBe('/pompen%20%28gross%29/a%20b?x=1%7C2');
  });

  it('escapes brackets in link text and image alt text', () => {
    const { body } = split(
      render((_r, locale) => {
        segmentOf(locale, 'a-018').final_text = 'Angebot [neu] anfordern';
        segmentOf(locale, 'alt-017').final_text = 'Pumpe [CP-100] im Werk';
      }).md,
    );
    const $ = html(body);
    expect($('a[href="/contact?utm=pompen&ref=nl"]').text()).toBe('Angebot [neu] anfordern');
    expect($('img').attr('alt')).toBe('Pumpe [CP-100] im Werk');
  });

  it('turns newlines inside segment text into spaces and never leaks CR characters', () => {
    const { md } = render((_r, locale) => {
      segmentOf(locale, 'p-019').final_text = 'Zeile eins\r\nZeile zwei\n\nZeile drei';
    });
    expect(md).not.toContain('\r');
    expect(md).toContain('Zeile eins Zeile zwei Zeile drei');
  });
});

describe('markdown output', () => {
  it('is deterministic and ends with exactly one newline', () => {
    const a = render().md;
    const b = render().md;
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(a.endsWith('\n\n')).toBe(false);
  });

  it('renders a locale without body segments as front matter only', () => {
    const { md } = render((_r, locale) => {
      locale.segments = [];
    });
    expect(md).toMatch(/^---\n[\s\S]*\n---\n$/);
  });
});
