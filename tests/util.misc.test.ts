import { describe, expect, it } from 'vitest';
import { mapLimit, mapLimitSettled, Semaphore } from '../src/util/concurrency.js';
import { extractFinalAnswer, parseModelJson, repairJson } from '../src/util/json.js';
import { backoffDelay, parseRetryAfter, retry } from '../src/util/retry.js';
import { isValidSlug, slugify, slugWordsFromUrlPath } from '../src/util/slug.js';
import { charLength, hasNaturalLanguage, hashText, matchCase, wordCount } from '../src/util/text.js';

describe('text helpers', () => {
  it('counts words on plain text', () => {
    expect(wordCount('Onze <a1>pompen</a1> leveren 450 m³/h.')).toBe(5);
    expect(wordCount('   ')).toBe(0);
  });
  it('hashes deterministically to 12 hex chars', () => {
    expect(hashText('abc')).toMatch(/^[0-9a-f]{12}$/);
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
  });
  it('measures length in code points of plain text', () => {
    expect(charLength('<a1>Größe</a1> 😀')).toBe(7);
  });
  it('detects natural language vs codes, numbers, units and URLs', () => {
    const units = ['bar', 'kW', 'rpm'];
    expect(hasNaturalLanguage('N-3085', units)).toBe(false);
    expect(hasNaturalLanguage('450 m³/h', units)).toBe(false);
    expect(hasNaturalLanguage('16 bar', units)).toBe(false);
    expect(hasNaturalLanguage('https://example.com/pompen', units)).toBe(false);
    expect(hasNaturalLanguage('info@example.nl', units)).toBe(false);
    expect(hasNaturalLanguage('Debiet 450 m³/h', units)).toBe(true);
  });
  it('copies capitalisation', () => {
    expect(matchCase('Januar', 'jänner')).toBe('Jänner');
    expect(matchCase('januar', 'jänner')).toBe('jänner');
    expect(matchCase('GROSSE', 'große')).toBe('GROSSE');
  });
});

describe('slugify', () => {
  const de = { transliterate: { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' } };
  it('transliterates German umlauts and ß', () => {
    expect(slugify('Kreiselpumpen für Größe & Förderhöhe', de)).toBe('kreiselpumpen-fuer-groesse-foerderhoehe');
  });
  it('strips other diacritics for non-German locales', () => {
    expect(slugify('Pompe centrifughe – città è più')).toBe('pompe-centrifughe-citta-e-piu');
  });
  it('produces valid slugs and respects maxLength at hyphen boundaries', () => {
    const s = slugify('  --Hello,   World!!  ');
    expect(s).toBe('hello-world');
    expect(isValidSlug(s)).toBe(true);
    expect(isValidSlug('Hello')).toBe(false);
    expect(isValidSlug('a--b')).toBe(false);
    expect(slugify('alpha bravo charlie delta', { maxLength: 14 })).toBe('alpha-bravo');
  });
  it('extracts slug words from URL paths', () => {
    expect(slugWordsFromUrlPath('https://x.nl/producten/centrifugaal-pompen/?a=1')).toBe('centrifugaal pompen');
    expect(slugWordsFromUrlPath('/privacyverklaring.html')).toBe('privacyverklaring');
  });
});

describe('parseModelJson', () => {
  const obj = { results: [{ segment_id: 'p-001', translation: 'Hallo {x}' }] };
  it('parses bare JSON', () => {
    const r = parseModelJson(JSON.stringify(obj));
    expect(r.ok && r.value).toEqual(obj);
  });
  it('unwraps <thinking> + <final_answer>', () => {
    const raw = `<thinking>I should output {"oops": 1}</thinking>\n<final_answer>\n${JSON.stringify(obj)}\n</final_answer>`;
    const r = parseModelJson(raw);
    expect(r.ok && r.value).toEqual(obj);
    expect(extractFinalAnswer(raw)).toBe(JSON.stringify(obj));
  });
  it('accepts an unterminated <final_answer>', () => {
    const r = parseModelJson(`<final_answer>${JSON.stringify(obj)}`);
    expect(r.ok && r.value).toEqual(obj);
  });
  it('strips code fences and surrounding prose', () => {
    const raw = 'Sure! Here you go:\n```json\n' + JSON.stringify(obj, null, 2) + '\n```\nLet me know if you need more.';
    const r = parseModelJson(raw);
    expect(r.ok && r.value).toEqual(obj);
  });
  it('finds JSON inside prose without fences, ignoring braces in strings', () => {
    const tricky = { a: 'brace } inside', b: [1, 2] };
    const r = parseModelJson(`Result follows ${JSON.stringify(tricky)} — done.`);
    expect(r.ok && r.value).toEqual(tricky);
  });
  it('repairs trailing commas and raw newlines in strings', () => {
    const r = parseModelJson('{"a": "line1\nline2", "b": [1,2,],}');
    expect(r.ok && r.value).toEqual({ a: 'line1\nline2', b: [1, 2] });
    expect(repairJson('{"a":1,}')).toBe('{"a":1}');
  });
  it('fails cleanly on prose', () => {
    const r = parseModelJson('I cannot help with that.');
    expect(r.ok).toBe(false);
  });
});

describe('retry & backoff', () => {
  it('retries until success, recording delays, no real sleeping', async () => {
    const delays: number[] = [];
    let n = 0;
    const result = await retry(
      async () => {
        if (++n < 3) throw new Error('boom');
        return 'ok';
      },
      { retries: 3, baseMs: 100, jitter: false, sleep: async (ms) => void delays.push(ms) },
    );
    expect(result).toBe('ok');
    expect(n).toBe(3);
    expect(delays).toEqual([100, 200]);
  });
  it('stops after retries are exhausted and honours shouldRetry and Retry-After hints', async () => {
    let n = 0;
    await expect(
      retry(async () => { n++; throw new Error('x'); }, { retries: 2, baseMs: 1, sleep: async () => {} }),
    ).rejects.toThrow('x');
    expect(n).toBe(3);
    let m = 0;
    await expect(
      retry(async () => { m++; throw new Error('fatal'); }, { retries: 5, baseMs: 1, shouldRetry: () => false, sleep: async () => {} }),
    ).rejects.toThrow('fatal');
    expect(m).toBe(1);
    const seen: number[] = [];
    let k = 0;
    await retry(
      async () => {
        if (++k < 2) throw Object.assign(new Error('429'), { retryAfterMs: 5000 });
        return 1;
      },
      { retries: 1, baseMs: 10, jitter: false, sleep: async (ms) => void seen.push(ms) },
    );
    expect(seen).toEqual([5000]);
  });
  it('computes capped exponential delays and parses Retry-After', () => {
    expect(backoffDelay(1, 100, 2, 1000, false)).toBe(100);
    expect(backoffDelay(5, 100, 2, 1000, false)).toBe(1000);
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:10 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'))).toBe(10_000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

describe('concurrency', () => {
  it('never exceeds the limit and preserves order', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
  it('settled variant reports failures without rejecting', async () => {
    const res = await mapLimitSettled([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('bad');
      return n;
    });
    expect(res.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
  it('semaphore releases are idempotent', async () => {
    const s = new Semaphore(1);
    const release = await s.acquire();
    release();
    release();
    const r2 = await s.acquire();
    r2();
  });
});

describe('hardening (hostile input)', () => {
  it('hasNaturalLanguage stays linear on huge whitespace-free tokens and ignores URLs and e-mails wrapped in punctuation', () => {
    const t0 = Date.now();
    expect(hasNaturalLanguage('a'.repeat(50_000))).toBe(false);
    expect(hasNaturalLanguage(`${'x.'.repeat(30_000)}@`)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(hasNaturalLanguage('(https://example.com/pompen)')).toBe(false);
    expect(hasNaturalLanguage('<info@example.nl>')).toBe(false);
    expect(hasNaturalLanguage('Zie https://example.com voor meer')).toBe(true);
  });
  it('slugWordsFromUrlPath lower-cases, decodes escapes and throws on a malformed one (callers: no usable slug)', () => {
    expect(slugWordsFromUrlPath('/producten/Centrifugaal-Pompen/')).toBe('centrifugaal pompen');
    expect(slugWordsFromUrlPath('/a/100%25-kwaliteit')).toBe('100% kwaliteit');
    expect(() => slugWordsFromUrlPath('/a/100%-kwaliteit')).toThrow(URIError);
  });
});
