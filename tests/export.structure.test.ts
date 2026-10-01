import * as cheerio from 'cheerio';
import { marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { renderHtml, renderMarkdown, toPageJson } from '../src/export/index.js';
import type { LocaleResult, SegmentGroup, SegmentResult } from '../src/schemas/index.js';
import { localeOf, sampleReport, segmentOf } from './fixtures/export/sample-report.js';

/**
 * Both renderers rebuild structure from segment metadata. These tests feed them damaged or unusual metadata and check that
 * nothing is dropped and the output is still well-formed, in Markdown (as a parser reads it) and in HTML.
 */

interface Spec {
  id: string;
  type: SegmentResult['block_type'];
  text: string;
  order?: number;
  group?: SegmentGroup;
  level?: number;
}

function render(specs: Spec[]): { md: string; html: string; $md: cheerio.CheerioAPI; $html: cheerio.CheerioAPI } {
  const report = sampleReport();
  const locale: LocaleResult = localeOf(report, 'de-CH');
  const template = segmentOf(locale, 'p-003');
  locale.segments = specs.map((spec, i) => {
    const seg: SegmentResult = {
      ...structuredClone(template),
      segment_id: spec.id,
      block_type: spec.type,
      order: spec.order ?? i + 1,
      source_text: spec.text,
      final_text: spec.text,
      changes: [],
      repairs: [],
      review_reasons: [],
      requires_human_review: false,
      validation: null,
    };
    if (spec.group) seg.group = spec.group;
    if (spec.level !== undefined) seg.level = spec.level;
    return seg;
  });
  const page = toPageJson(report, 'de-CH');
  const md = renderMarkdown(page);
  const html = renderHtml(page);
  const body = md.replace(/^---\n[\s\S]*?---\n\n?/, '');
  return { md, html, $md: cheerio.load(marked.parse(body, { async: false, gfm: true })), $html: cheerio.load(html) };
}

const li = (id: string, text: string, group?: SegmentGroup): Spec => ({ id, type: 'list_item', text, ...(group ? { group } : {}) });
const list = (id: string, depth: number, ordered = false): SegmentGroup => ({ kind: 'list', id, ordered, depth });

describe('lists', () => {
  it('renders list items without list metadata as one bullet list', () => {
    const { $md, $html } = render([li('li-1', 'eins'), li('li-2', 'zwei'), li('li-3', 'drei')]);
    expect($md('body > ul > li').map((_, el) => $md(el).text()).get()).toEqual(['eins', 'zwei', 'drei']);
    expect($html('main > ul > li').map((_, el) => $html(el).text()).get()).toEqual(['eins', 'zwei', 'drei']);
    expect($html('main > ul').attr('data-group')).toBeUndefined();
  });

  it('never skips a nesting level, whatever depth the metadata claims', () => {
    const { md, $md, $html } = render([
      li('li-1', 'a', list('ul-1', 2)), // a list that starts deeper than level 0
      li('li-2', 'b', list('ul-1', 5)), // a jump of several levels
      li('li-3', 'c', list('ul-1', 1)),
      li('li-4', 'd', list('ul-1', 0)),
    ]);
    expect(md).toContain('- a\n  - b\n  - c\n- d');
    expect($md('body > ul > li')).toHaveLength(2);
    expect($md('body > ul > li:first-child > ul > li')).toHaveLength(2);
    expect($html('main > ul > li')).toHaveLength(2);
    expect($html('main > ul > li#li-1 > ul > li').map((_, el) => $html(el).attr('id')).get()).toEqual(['li-2', 'li-3']);
  });

  it('nests correctly when the inner list has the same group id as the outer one, and when it has its own', () => {
    const same = render([li('li-1', 'a', list('ul-1', 0)), li('li-2', 'b', list('ul-1', 1)), li('li-3', 'c', list('ul-1', 0))]);
    expect(same.$html('main > ul')).toHaveLength(1);
    expect(same.$html('main > ul > li#li-1 > ul > li#li-2')).toHaveLength(1);
    expect(same.$md('body > ul > li')).toHaveLength(2);

    const own = render([li('li-1', 'a', list('ul-1', 0)), li('li-2', 'b', list('ul-2', 1)), li('li-3', 'c', list('ul-2', 1)), li('li-4', 'd', list('ul-1', 0))]);
    expect(own.$html('main > ul')).toHaveLength(1);
    expect(own.$html('main > ul > li#li-1 > ul > li')).toHaveLength(2);
    expect(own.$html('main > ul > li')).toHaveLength(2);
    expect(own.$md('body > ul > li:first-child > ul > li')).toHaveLength(2);
  });

  it('nests three levels deep', () => {
    const { md, $html } = render([
      li('li-1', 'a', list('ul-1', 0, true)),
      li('li-2', 'b', list('ul-2', 1)),
      li('li-3', 'c', list('ul-3', 2, true)),
      li('li-4', 'd', list('ul-1', 0, true)),
    ]);
    expect(md).toContain('1. a\n   - b\n     1. c\n2. d');
    expect($html('main > ol > li#li-1 > ul > li#li-2 > ol > li#li-3')).toHaveLength(1);
    expect($html('main > ol > li#li-4')).toHaveLength(1);
  });

  it('keeps two lists that touch in the source apart', () => {
    const { md, $md, $html } = render([li('li-1', 'a', list('ul-1', 0)), li('li-2', 'b', list('ul-2', 0)), li('li-3', 'c', list('ol-3', 0, true))]);
    expect($html('main > ul')).toHaveLength(2);
    expect($html('main > ol')).toHaveLength(1);
    expect($md('body > ul')).toHaveLength(2);
    expect($md('body > ol')).toHaveLength(1);
    expect(md).toContain('<!-- -->');
  });

  it('keeps a list that a paragraph interrupted as two lists', () => {
    const { $md, $html } = render([
      li('li-1', 'a', list('ul-1', 0)),
      { id: 'p-2', type: 'paragraph', text: 'Zwischentext' },
      li('li-3', 'b', list('ul-1', 0)),
    ]);
    expect($html('main > ul')).toHaveLength(2);
    expect($md('body > ul')).toHaveLength(2);
  });
});

describe('tables', () => {
  const td = (id: string, text: string, group?: SegmentGroup): Spec => ({ id, type: 'table_cell', text, ...(group ? { group } : {}) });
  const at = (row: number, col: number, header = false): SegmentGroup => ({ kind: 'table', id: 'tbl-1', row, col, header });

  it('renders a table cell without table metadata as a paragraph', () => {
    const { $md, $html } = render([td('td-1', 'allein')]);
    expect($html('main > p#td-1').text()).toBe('allein');
    expect($html('table')).toHaveLength(0);
    expect($md('body > p').text()).toBe('allein');
    expect($md('table')).toHaveLength(0);
  });

  it('puts cells without coordinates into one row, in document order', () => {
    const { $md, $html } = render([
      td('td-1', 'a', { kind: 'table', id: 'tbl-1' }),
      td('td-2', 'b', { kind: 'table', id: 'tbl-1' }),
      td('td-3', 'c', { kind: 'table', id: 'tbl-1' }),
    ]);
    expect($html('table tr')).toHaveLength(1);
    expect($html('table td').map((_, el) => $html(el).text()).get()).toEqual(['a', 'b', 'c']);
    expect($md('table tr')).toHaveLength(2); // empty header row + the data row
  });

  it('orders rows and columns by their coordinates, not by their position in the list', () => {
    const { $md, $html } = render([td('td-1', 'r1c1', at(1, 1)), td('td-2', 'r0c1', at(0, 1, true)), td('td-3', 'r1c0', at(1, 0)), td('td-4', 'r0c0', at(0, 0, true))]);
    expect($html('thead th').map((_, el) => $html(el).text()).get()).toEqual(['r0c0', 'r0c1']);
    expect($html('tbody td').map((_, el) => $html(el).text()).get()).toEqual(['r1c0', 'r1c1']);
    expect($md('thead th').map((_, el) => $md(el).text()).get()).toEqual(['r0c0', 'r0c1']);
  });

  it('does not lose a cell that claims an occupied position', () => {
    const { $html } = render([td('td-1', 'a', at(0, 0)), td('td-2', 'b', at(0, 0)), td('td-3', 'c', at(1, 0))]);
    const texts = $html('td, th').map((_, el) => $html(el).text()).get();
    expect(texts.filter((t) => t !== '').sort()).toEqual(['a', 'b', 'c']); // b moved to the next free column; the gap is an empty cell
  });

  it('keeps two adjacent tables apart and several header rows in the thead', () => {
    const second = (row: number, col: number, header = false): SegmentGroup => ({ kind: 'table', id: 'tbl-2', row, col, header });
    const { $html, $md } = render([
      td('td-1', 'h1', at(0, 0, true)),
      td('td-2', 'h2', at(1, 0, true)),
      td('td-3', 'd', at(2, 0)),
      td('td-4', 'x', second(0, 0, true)),
      td('td-5', 'y', second(1, 0)),
    ]);
    expect($html('table')).toHaveLength(2);
    expect($html('table').eq(0).find('thead tr')).toHaveLength(2);
    expect($html('table').eq(1).find('thead tr')).toHaveLength(1);
    expect($md('table')).toHaveLength(2);
  });
});

describe('headings and order', () => {
  it('gives a heading without a level level 2, and clamps levels to 1-6', () => {
    const { md, $html } = render([
      { id: 'h-1', type: 'heading', text: 'ohne' },
      { id: 'h-2', type: 'heading', text: 'zu tief', level: 9 },
      { id: 'h-3', type: 'heading', text: 'zu flach', level: 0 },
    ]);
    expect($html('main > h2#h-1').text()).toBe('ohne');
    expect($html('main > h6#h-2').text()).toBe('zu tief');
    expect($html('main > h1#h-3').text()).toBe('zu flach');
    expect(md).toContain('## ohne\n\n###### zu tief\n\n# zu flach');
  });

  it('follows the order field, not the position in the list', () => {
    const { $html, md } = render([
      { id: 'p-late', type: 'paragraph', text: 'zuletzt', order: 30 },
      { id: 'p-first', type: 'paragraph', text: 'zuerst', order: 10 },
      { id: 'p-mid', type: 'paragraph', text: 'mitte', order: 20 },
    ]);
    expect($html('main > p').map((_, el) => $html(el).text()).get()).toEqual(['zuerst', 'mitte', 'zuletzt']);
    expect(md.indexOf('zuerst')).toBeLessThan(md.indexOf('mitte'));
    expect(md.indexOf('mitte')).toBeLessThan(md.indexOf('zuletzt'));
  });

  it('renders an empty segment as an empty element in HTML and as nothing in Markdown', () => {
    const { md, $html } = render([
      { id: 'p-1', type: 'paragraph', text: 'vorher' },
      { id: 'p-2', type: 'paragraph', text: '' },
      { id: 'p-3', type: 'paragraph', text: 'nachher' },
    ]);
    expect($html('main > p')).toHaveLength(3);
    expect($html('p#p-2').text()).toBe('');
    expect(md).toContain('vorher\n\nnachher');
  });
});
