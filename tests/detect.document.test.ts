import { describe, expect, it, vi } from 'vitest';
import { detectDocument, finalizeSourceLocale, type DetectOptions } from '../src/detect/index.js';
import { ingestInput } from '../src/ingest/index.js';
import type { InputSpec, SourceDocument } from '../src/schemas/index.js';
import { ingestDeps, stages } from './fixtures/ingest/deps.js';
import { fixturePath } from './fixtures/ingest/helpers.js';

const thresholds = stages.thresholds;
const file = (name: string, deps = ingestDeps()): Promise<SourceDocument> => ingestInput({ kind: 'file', path: fixturePath(name) }, deps);
const html = (body: string, extra: Partial<Extract<InputSpec, { kind: 'text' }>> = {}): Promise<SourceDocument> =>
  ingestInput({ kind: 'text', text: body, format: 'html', ...extra }, ingestDeps());
const langs = (doc: SourceDocument) => Object.fromEntries(doc.segments.map((s) => [s.segment_id, `${s.lang?.lang}/${s.lang?.method}`]));
const opts = (over: Partial<DetectOptions> = {}): DetectOptions => ({ thresholds, ...over });

// Three-word loan-word text: the detector says "en" with p ~ 0.42, below detection_confidence_min (0.8).
const UNSURE = 'Hotel restaurant service';
const DUTCH = 'Onze pompen leveren een hoog rendement bij lage kosten en zijn geschikt voor continu bedrijf.';
const unsureDoc = (n: number): Promise<SourceDocument> =>
  html(`<main><h1>Pompen</h1><p>${DUTCH}</p>${Array.from({ length: n }, () => `<p>${UNSURE}</p>`).join('')}</main>`);
const unsureIds = (doc: SourceDocument) => doc.segments.filter((s) => s.text === UNSURE).map((s) => s.segment_id);

describe('detectDocument: language of the document', () => {
  it('detects the Dutch page; the agreeing <html lang> raises the confidence (method attribute)', async () => {
    const doc = await detectDocument(await file('pumps-nl.html'), opts());
    expect(doc.source_language).toBe('nl');
    expect(doc.source_language_detection).toMatchObject({ lang: 'nl', method: 'attribute' });
    expect(doc.source_language_detection?.confidence).toBeGreaterThan(0.99);
    expect(doc.segments.every((s) => s.lang !== undefined)).toBe(true);
    const en = await detectDocument(await file('pumps-en.html'), opts());
    expect(en.source_language).toBe('en');
  });

  it('does not mutate its input', async () => {
    const before = await file('pumps-nl.html');
    const snapshot = JSON.stringify(before);
    await detectDocument(before, opts());
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('uses a declared language that agrees (method declared) and warns when it disagrees', async () => {
    const text = `<main><h1>Pompen</h1><p>${DUTCH}</p></main>`;
    const agree = await detectDocument(await html(text), opts({ declaredLanguage: 'nl-NL' }));
    expect(agree.source_language_detection).toMatchObject({ lang: 'nl', method: 'declared' });
    expect(agree.source_language_detection?.confidence).toBeGreaterThan(0.99);
    const clash = await detectDocument(await html(text), opts({ declaredLanguage: 'de' }));
    expect(clash.source_language).toBe('nl');
    expect(clash.source_language_detection?.method).toBe('lib');
    expect(clash.warnings.some((w) => w.startsWith('declared language "de" disagrees with the detected language "nl"'))).toBe(true);
  });

  it('keeps the detector\'s answer and warns when <html lang> is wrong (a common CMS default)', async () => {
    const doc = await detectDocument(await html(`<html lang="en-US"><body><main><h1>Pompen</h1><p>${DUTCH}</p></main></body></html>`), opts());
    expect(doc.source_language).toBe('nl');
    expect(doc.source_language_detection?.method).toBe('lib');
    expect(doc.warnings.some((w) => w.includes('<html lang="en-US"> says en but the text is nl'))).toBe(true);
  });

  it('falls back to the declared language, then the attribute, when there is too little text; else und with a warning', async () => {
    const tiny = '<main><p>Pompen meer</p></main>'; // two words: too little for the detector
    const declared = await detectDocument(await html(tiny), opts({ declaredLanguage: 'nl' }));
    expect(declared.source_language_detection).toEqual({ lang: 'nl', confidence: 0.9, method: 'declared' });
    const attribute = await detectDocument(await html(`<html lang="de"><body>${tiny}</body></html>`), opts());
    expect(attribute.source_language_detection).toEqual({ lang: 'de', confidence: 0.7, method: 'attribute' });
    const none = await detectDocument(await html(tiny), opts());
    expect(none.source_language).toBe('und');
    expect(none.source_language_detection).toEqual({ lang: 'und', confidence: 0, method: 'lib' });
    expect(none.warnings).toContain('the document language could not be detected (too little text)');
    expect(none.segments.every((s) => s.lang?.lang === 'und' && s.lang.method === 'inherited')).toBe(true);
  });
});

describe('detectDocument: per-segment languages', () => {
  it('keeps English spec cells English on a Dutch page (mixed-language edge case)', async () => {
    const doc = await detectDocument(await file('pumps-mixed.html'), opts());
    expect(doc.source_language).toBe('nl');
    const cell = (text: string) => doc.segments.find((s) => s.text === text)?.lang;
    expect(cell('Suitable for clean and dirty water applications')).toMatchObject({ lang: 'en', method: 'lib' });
    expect(cell('Thermal protection is built into the stator winding')).toMatchObject({ lang: 'en', method: 'lib' });
    expect(cell('Designed for continuous duty operation at full load')).toMatchObject({ lang: 'en', method: 'lib' });
    expect(doc.segments.find((s) => s.segment_id === 'p-002')?.lang).toMatchObject({ lang: 'nl', method: 'lib' });
    // short Dutch cells and the number cell inherit the document language
    expect(cell('Toepassing')).toMatchObject({ lang: 'nl', method: 'inherited' });
    expect(cell('5,5 kW')).toMatchObject({ lang: 'nl', method: 'inherited' });
    expect(doc.warnings).toEqual([]);
  });

  it('inherits for short and non-translatable segments, detects the rest, and follows detection_min_words', async () => {
    const base = await file('pumps-nl.html');
    const strict = await detectDocument(base, opts({ thresholds: { ...thresholds, detection_min_words: 100 } }));
    expect(strict.segments.every((s) => s.lang?.method === 'inherited')).toBe(true);
    const normal = await detectDocument(base, opts());
    const byId = langs(normal);
    expect(byId['p-002']).toBe('nl/lib'); // long paragraph
    expect(byId['h-001']).toBe('nl/inherited'); // three words
    expect(byId['td-020']).toBe('nl/inherited'); // "450 m³/h"
    const eager = await detectDocument(base, opts({ thresholds: { ...thresholds, detection_min_words: 3 } }));
    expect(langs(eager)['h-001']).toBe('nl/lib');
  });
});

describe('detectDocument: LLM fallback for low-confidence segments', () => {
  const lenient = { ...thresholds, detection_min_words: 3 };

  it('calls classify exactly once, with only the low-confidence segments, and applies its answers', async () => {
    const doc = await unsureDoc(2);
    const ids = unsureIds(doc);
    const classify = vi.fn(async (items: Array<{ segment_id: string; text: string }>) =>
      items.map((i) => ({ segment_id: i.segment_id, lang: 'nl' as const, confidence: 0.93 })),
    );
    const out = await detectDocument(doc, opts({ thresholds: lenient, classify }));
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0]?.[0]).toEqual(ids.map((id) => ({ segment_id: id, text: UNSURE })));
    for (const id of ids) expect(out.segments.find((s) => s.segment_id === id)?.lang).toEqual({ lang: 'nl', confidence: 0.93, method: 'llm' });
    expect(out.segments.find((s) => s.text === DUTCH)?.lang?.method).toBe('lib');
    expect(out.warnings).toEqual([]);
  });

  it('never calls classify when every segment is confident, or when nothing is detected per segment', async () => {
    const classify = vi.fn(async () => []);
    await detectDocument(await file('pumps-mixed.html'), opts({ classify }));
    await detectDocument(await file('pumps-nl.html'), opts({ thresholds: { ...thresholds, detection_confidence_min: 0.5 }, classify }));
    await detectDocument(await unsureDoc(3), opts({ classify })); // default min words (4): the loan-word segments inherit
    expect(classify).not.toHaveBeenCalled();
  });

  it('gives unconfirmed segments the document language and warns when classify is absent', async () => {
    const out = await detectDocument(await unsureDoc(3), opts({ thresholds: lenient }));
    expect(out.warnings).toEqual(['low-confidence language detection for 3 segments; they take the document language']);
    expect(out.segments.filter((s) => s.text === UNSURE).every((s) => s.lang?.method === 'inherited' && s.lang.lang === 'nl')).toBe(true);
  });

  it('tolerates a failing classify: the segments take the document language, a warning says so', async () => {
    const classify = vi.fn(async () => {
      throw new Error('provider down');
    });
    const out = await detectDocument(await unsureDoc(2), opts({ thresholds: lenient, classify }));
    expect(classify).toHaveBeenCalledTimes(1);
    expect(out.segments.filter((s) => s.text === UNSURE).every((s) => s.lang?.method === 'inherited' && s.lang.lang === 'nl')).toBe(true);
    expect(out.warnings).toEqual(['language detection fallback failed (provider down); the document language is used for 2 segments']);
  });

  it('a Dutch title with an English brand suffix is not left "English" when nobody can settle it', async () => {
    const page = await html(
      `<html lang="nl"><head><title>Werking centrifugaalpompen | Industrial Pump Group</title></head><body><main><h1>Pompen</h1><p>${DUTCH}</p></main></body></html>`,
    );
    const title = (d: SourceDocument) => d.segments.find((s) => s.segment_id === 'meta-title')?.lang;
    // the detector alone reads the title as English (unconfirmed)…
    const guessed = await detectDocument(page, opts({ thresholds: { ...thresholds, detection_confidence_min: 0.5 } }));
    expect(title(guessed)).toMatchObject({ lang: 'en', method: 'lib' });
    // …which must not decide how the segment is routed: without a confirming answer it is Dutch like the rest of the page
    const settled = await detectDocument(page, opts({ classify: async () => [] }));
    expect(title(settled)).toMatchObject({ lang: 'nl', method: 'inherited' });
    // and a model that answers is believed
    const asked = await detectDocument(page, opts({ classify: async (items) => items.map((i) => ({ segment_id: i.segment_id, lang: 'nl' as const, confidence: 0.95 })) }));
    expect(title(asked)).toEqual({ lang: 'nl', confidence: 0.95, method: 'llm' });
  });

  it('gives und / other / missing answers the document language, and clamps odd confidences', async () => {
    const doc = await unsureDoc(4);
    const [a, b, c] = unsureIds(doc);
    const classify = async () => [
      { segment_id: a as string, lang: 'und' as const, confidence: 0.2 },
      { segment_id: b as string, lang: 'other' as const, confidence: 0.9 },
      { segment_id: c as string, lang: 'de' as const, confidence: 7 },
      { segment_id: 'nope-999', lang: 'nl' as const, confidence: 1 },
    ];
    const out = await detectDocument(doc, opts({ thresholds: lenient, classify }));
    const lang = (id: string | undefined) => out.segments.find((s) => s.segment_id === id)?.lang;
    expect(lang(a)).toMatchObject({ lang: 'nl', method: 'inherited' });
    expect(lang(b)).toMatchObject({ lang: 'nl', method: 'inherited' });
    expect(lang(c)).toEqual({ lang: 'de', confidence: 1, method: 'llm' });
    expect(lang(unsureIds(doc)[3])).toMatchObject({ lang: 'nl', method: 'inherited' }); // no answer at all
    expect(out.warnings).toEqual(['language detection fallback gave no usable answer (und, other or missing) for 3 segments; the document language is used for them']);
  });

  it('batches at most 40 segments per call', async () => {
    const doc = await unsureDoc(45);
    const sizes: number[] = [];
    const classify = async (items: Array<{ segment_id: string; text: string }>) => {
      sizes.push(items.length);
      return items.map((i) => ({ segment_id: i.segment_id, lang: 'nl' as const, confidence: 0.9 }));
    };
    const out = await detectDocument(doc, opts({ thresholds: lenient, classify }));
    expect(sizes).toEqual([40, 5]);
    expect(out.segments.filter((s) => s.lang?.method === 'llm')).toHaveLength(45);
  });
});

describe('finalizeSourceLocale', () => {
  it('re-evaluates the locale from the detected language, the URL and <html lang>', async () => {
    const nl = finalizeSourceLocale(await detectDocument(await file('pumps-nl.html'), opts()));
    expect(nl.source_locale).toBe('nl-NL');
    // no attributes at ingest time: the locale becomes known only after detection
    const bare = await ingestInput({ kind: 'text', text: `<main><h1>Pompen</h1><p>${DUTCH}</p></main>`, format: 'html', name: 'https://www.pompen.nl/aanbod' }, ingestDeps());
    expect(bare.source_locale).toBe('und');
    const detected = await detectDocument(bare, opts());
    const finalized = finalizeSourceLocale(detected);
    expect(finalized).toMatchObject({ source_locale: 'nl-NL', source_language: 'nl' });
    expect(finalized.source_locale_evidence).toBe('ccTLD .nl suggests region NL for the nl text');
  });

  it('ignores a wrong <html lang> once the language is known, and lets a declared locale win', async () => {
    const wrong = await detectDocument(await html(`<html lang="en-US"><body><main><h1>Pompen</h1><p>${DUTCH}</p></main></body></html>`), opts());
    const fixed = finalizeSourceLocale(wrong);
    expect(fixed.source_locale).toBe('nl-NL');
    expect(fixed.source_locale_evidence).toContain('ignored: the text is nl');
    expect(finalizeSourceLocale(wrong, 'nl-BE')).toMatchObject({ source_locale: 'nl-BE', source_locale_evidence: 'declared by the caller: nl-BE' });
  });

  it('never trades a region established at ingest for a region-less answer', async () => {
    const doc = await ingestInput({ kind: 'text', text: '<main><h1>Pumps</h1><p>Our pumps are built for continuous duty in sewage applications.</p></main>', format: 'html' }, ingestDeps({ sourceLocale: 'en-GB' }));
    const detected = await detectDocument(doc, opts({ declaredLanguage: 'en-GB' }));
    expect(finalizeSourceLocale(detected).source_locale).toBe('en-GB');
    expect(finalizeSourceLocale(detected, 'en').source_locale).toBe('en-*');
  });
});
