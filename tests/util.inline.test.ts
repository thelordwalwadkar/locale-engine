import { describe, expect, it } from 'vitest';
import {
  escapeLiteral,
  mapPlainSpan,
  placeholderSignature,
  plainText,
  plainTextWithMap,
  renderInlineHtml,
  renderInlineMarkdown,
  tokenizeInline,
  unescapeLiteral,
  verifyInline,
} from '../src/util/inline.js';
import type { InlineTag } from '../src/schemas/segment.js';

const inline: Record<string, InlineTag> = {
  a1: { tag: 'a', attrs: { href: '/pompen?x=1&y=2' } },
  strong2: { tag: 'strong', attrs: {} },
  br3: { tag: 'br', attrs: {} },
};
const text = 'Bekijk onze <a1>centrifugaalpompen</a1> en <strong2>dompelpompen</strong2>.<br3/>Klaar &lt; 5 min.';

describe('inline codec', () => {
  it('tokenizes text, open, close and self-closing placeholders with offsets', () => {
    const toks = tokenizeInline(text);
    expect(toks.filter((t) => t.kind !== 'text').map((t) => t.kind + ':' + (t as { key: string }).key)).toEqual([
      'open:a1',
      'close:a1',
      'open:strong2',
      'close:strong2',
      'self:br3',
    ]);
    // round trip
    const rebuilt = toks.map((t) => (t.kind === 'text' ? t.text : t.raw)).join('');
    expect(rebuilt).toBe(text);
  });

  it('plainText strips placeholders and decodes &lt; &gt;', () => {
    expect(plainText(text)).toBe('Bekijk onze centrifugaalpompen en dompelpompen.Klaar < 5 min.');
    expect(unescapeLiteral(escapeLiteral('a < b > c'))).toBe('a < b > c');
    expect(escapeLiteral('x<y')).toBe('x&lt;y');
  });

  it('does not treat unknown tags as placeholders', () => {
    expect(plainText('a <div1>b</div1> c')).toBe('a <div1>b</div1> c');
  });

  it('maps plain spans back to source offsets, excluding boundary tags', () => {
    const map = plainTextWithMap(text);
    const plainIdx = map.plain.indexOf('centrifugaalpompen');
    const span = mapPlainSpan(map, plainIdx, plainIdx + 'centrifugaalpompen'.length);
    expect(text.slice(span.start, span.end)).toBe('centrifugaalpompen');
    // a span across a tag keeps the tag inside
    const i2 = map.plain.indexOf('en dompel');
    const sp2 = mapPlainSpan(map, i2, i2 + 'en dompelpompen'.length);
    expect(text.slice(sp2.start, sp2.end)).toBe('en <strong2>dompelpompen</strong2>');
    // entity-encoded char maps to its 4-char source
    const lt = map.plain.indexOf('<');
    const sp3 = mapPlainSpan(map, lt, lt + 1);
    expect(text.slice(sp3.start, sp3.end)).toBe('&lt;');
  });

  it('computes a stable placeholder signature', () => {
    expect(placeholderSignature(text)).toEqual(['close:a1', 'close:strong2', 'open:a1', 'open:strong2', 'self:br3']);
  });

  describe('verifyInline', () => {
    const src = 'Zie <a1>onze pompen</a1> en <strong2>prijzen</strong2>.';
    it('accepts reordered, renamed-content placeholders', () => {
      const tgt = 'Sehen Sie <strong2>Preise</strong2> und <a1>unsere Pumpen</a1>.';
      expect(verifyInline(src, tgt).ok).toBe(true);
    });
    it('reports missing, extra and unbalanced placeholders', () => {
      const v = verifyInline(src, 'Sehen Sie <a1>unsere Pumpen</a1> und <em9>Preise</em9>.');
      expect(v.ok).toBe(false);
      expect(v.missing).toEqual(['close:strong2', 'open:strong2']);
      expect(v.extra).toEqual(['close:em9', 'open:em9']);
      const overlap = verifyInline(src, 'Sehen <a1>Sie <strong2>unsere</a1> Pumpen</strong2>.');
      expect(overlap.unbalanced.length).toBeGreaterThan(0);
      expect(overlap.ok).toBe(false);
    });
    it('detects duplicated placeholders', () => {
      const v = verifyInline('<a1>x</a1>', '<a1>x</a1> <a1>y</a1>');
      expect(v.extra).toEqual(['close:a1', 'open:a1']);
    });
  });

  describe('rendering', () => {
    it('renders html with attributes escaped and text escaped', () => {
      expect(renderInlineHtml(text, inline)).toBe(
        'Bekijk onze <a href="/pompen?x=1&amp;y=2">centrifugaalpompen</a> en <strong>dompelpompen</strong>.<br />Klaar &lt; 5 min.',
      );
    });
    it('drops unbalanced placeholders instead of emitting broken markup', () => {
      expect(renderInlineHtml('x <a1>y and </strong2>z', inline)).toBe('x y and z');
    });
    it('renders markdown links, emphasis and hard breaks', () => {
      expect(renderInlineMarkdown(text, inline)).toBe('Bekijk onze [centrifugaalpompen](/pompen?x=1&y=2) en **dompelpompen**.  \nKlaar < 5 min.');
    });
  });
});
