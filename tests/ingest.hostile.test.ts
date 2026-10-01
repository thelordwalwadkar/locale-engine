/** Web pages are untrusted input: hostile or broken markup must cost bounded time and fail with an EngineError, never hang or crash. */
import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../src/detect/index.js';
import { parseHtml } from '../src/ingest/html_parser.js';
import { ingestInput } from '../src/ingest/index.js';
import { EngineError } from '../src/util/errors.js';
import { ingestDeps } from './fixtures/ingest/deps.js';

const page = (inner: string): string => `<html><body><main>${inner}</main></body></html>`;
const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
};

describe('hostile input', () => {
  it('handles tens of thousands of inline elements in one paragraph in linear time', () => {
    const { value, ms } = timed(() => parseHtml(page(`<p>${'<b>x</b>'.repeat(30_000)}</p>`)));
    expect(Object.keys(value.blocks[0]?.inline ?? {})).toHaveLength(30_000);
    expect(ms).toBeLessThan(8000);
  });

  it('collapses masses of empty wrappers and separators without quadratic work', () => {
    const { value, ms } = timed(() => parseHtml(page(`<ul><li>a${'<div></div>'.repeat(30_000)}b</li></ul><p>c${'<b></b>'.repeat(30_000)}d</p>`)));
    expect(value.blocks.map((b) => b.text)).toEqual(['a<br1/>b', 'cd']);
    expect(ms).toBeLessThan(8000);
  });

  it('refuses pages nested deeper than 1000 levels quickly, and reads deep-but-sane ones', () => {
    const bomb = timed(() => {
      try {
        parseHtml(page('<div>'.repeat(30_000) + 'Tekst hier' + '</div>'.repeat(30_000)));
        return undefined;
      } catch (e) {
        return e;
      }
    });
    expect(bomb.value).toBeInstanceOf(EngineError);
    expect(bomb.value).toMatchObject({ code: 'INPUT_INVALID', message: expect.stringContaining('nested too deeply') });
    expect(bomb.ms).toBeLessThan(1500);
    const deep = parseHtml(page('<div>'.repeat(300) + 'Een diepe maar normale pagina' + '</div>'.repeat(300)));
    expect(deep.blocks.map((b) => b.text)).toEqual(['Een diepe maar normale pagina']);
  });

  it('does not count tags inside script and style bodies as nesting', () => {
    const script = `<script>var t = "${'<div>'.repeat(5000)}";</script><style>/* ${'<span>'.repeat(5000)} */</style>`;
    expect(parseHtml(`<html><head>${script}</head><body><main><p>Gewone tekst</p></main></body></html>`).blocks).toHaveLength(1);
  });

  it('survives a 200 000-character word: ingestion is fast and the segment is not translatable', async () => {
    const started = performance.now();
    const doc = await ingestInput({ kind: 'text', format: 'html', text: page(`<p>Gewone tekst over pompen.</p><p>${'a'.repeat(200_000)}</p>`) }, ingestDeps());
    expect(performance.now() - started).toBeLessThan(4000);
    expect(doc.segments.filter((s) => s.block_type === 'paragraph').map((s) => s.translatable)).toEqual([true, false]);
  });

  it('language detection ignores absurd tokens and stays fast on megabytes of text', () => {
    expect(timed(() => detectLanguage('a'.repeat(100_000))).ms).toBeLessThan(1000);
    const big = 'De dompelpomp is voorzien van een thermische beveiliging en geschikt voor afvalwater. '.repeat(12_000);
    const { value, ms } = timed(() => detectLanguage(big));
    expect(value.lang).toBe('nl');
    expect(ms).toBeLessThan(2000);
  });
});
