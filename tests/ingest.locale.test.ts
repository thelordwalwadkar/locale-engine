import { describe, expect, it } from 'vitest';
import { determineSourceLocale, languageOfTag, parseLocaleTag, type SourceLocaleInput } from '../src/ingest/locale.js';

describe('parseLocaleTag', () => {
  it.each([
    ['nl', { language: 'nl' }],
    ['nl-nl', { language: 'nl', region: 'NL' }],
    ['en_GB', { language: 'en', region: 'GB' }],
    ['EN-gb', { language: 'en', region: 'GB' }],
    ['zh-Hans-CN', { language: 'zh', region: 'CN' }],
    ['sr-Latn', { language: 'sr' }],
    ['es-419', { language: 'es' }],
    ['en-*', { language: 'en' }],
    ['de-CH-x-private', { language: 'de', region: 'CH' }],
    ['en-x-GB', { language: 'en' }],
    [' fr-CA ', { language: 'fr', region: 'CA' }],
  ])('parses %j', (tag, expected) => {
    expect(parseLocaleTag(tag)).toEqual(expected);
  });

  it.each(['', '*', 'x-default', 'nederlands', 'e', '123', undefined])('rejects %j', (tag) => {
    expect(parseLocaleTag(tag)).toBeUndefined();
    expect(languageOfTag(tag)).toBeUndefined();
  });
});

describe('determineSourceLocale', () => {
  const cases: Array<[string, SourceLocaleInput, string, RegExp]> = [
    // the caller always wins
    ['declared full locale beats everything', { declared: 'en-GB', html_lang: 'nl', url: 'https://x.nl/', language: 'nl' }, 'en-GB', /^declared by the caller: en-GB$/],
    ['declared bare nl', { declared: 'nl', language: 'und' }, 'nl-NL', /declared by the caller: nl \(normalised to nl-NL\)/],
    ['declared bare en is region-less', { declared: 'en', language: 'en' }, 'en-*', /normalised to en-\*/],
    ['declared en-* stays', { declared: 'en-*', language: 'en' }, 'en-*', /^declared by the caller: en-\*$/],
    ['declared is normalised', { declared: 'EN_gb', language: 'en' }, 'en-GB', /normalised to en-GB/],
    ['declared junk is ignored', { declared: 'x-default', html_lang: 'nl', language: 'nl' }, 'nl-NL', /<html lang>/],
    // attributes
    ['html lang nl', { html_lang: 'nl', language: 'nl' }, 'nl-NL', /<html lang> "nl" declares nl-NL/],
    ['html lang nl-nl', { html_lang: 'nl-nl', language: 'nl' }, 'nl-NL', /declares nl-NL/],
    ['html lang en-gb', { html_lang: 'en-gb', language: 'en' }, 'en-GB', /declares en-GB/],
    ['html lang en_US', { html_lang: 'en_US', language: 'en' }, 'en-US', /declares en-US/],
    ['html lang en without region', { html_lang: 'en', language: 'en' }, 'en-*', /names the language only \(region unknown\)/],
    ['html lang en refined by .co.uk', { html_lang: 'en', url: 'https://www.shop.co.uk/a', language: 'en' }, 'en-GB', /region from \.uk/],
    ['html lang en on .nl stays region-less', { html_lang: 'en', url: 'https://x.nl/', language: 'en' }, 'en-*', /region unknown/],
    ['html lang de on .ch', { html_lang: 'de', url: 'https://x.ch/', language: 'de' }, 'de-CH', /region from \.ch/],
    ['og:locale when html lang is absent', { og_locale: 'nl_BE', language: 'nl' }, 'nl-BE', /og:locale "nl_BE" declares nl-BE/],
    ['html lang wins over og:locale', { html_lang: 'en-GB', og_locale: 'en_US', language: 'en' }, 'en-GB', /<html lang>/],
    ['attribute used before detection (language unknown)', { html_lang: 'it-IT', language: 'und' }, 'it-IT', /declares it-IT/],
    ['junk html lang falls through to og:locale', { html_lang: 'x-default', og_locale: 'de_AT', language: 'de' }, 'de-AT', /og:locale/],
    // attribute disagrees with the detected language
    ['wrong html lang is ignored, ccTLD decides', { html_lang: 'en-US', url: 'https://x.nl/', language: 'nl' }, 'nl-NL', /ccTLD \.nl suggests region NL.*<html lang> "en-US" ignored: the text is nl/],
    ['wrong html lang and no ccTLD: language default', { html_lang: 'en', language: 'de' }, 'de-*', /language de, region unknown.*ignored: the text is de/],
    // ccTLD as a hint for the detected language
    ['.nl + nl', { url: 'https://www.vandijkpompen.nl/pompen', language: 'nl' }, 'nl-NL', /ccTLD \.nl suggests region NL for the nl text/],
    ['.co.uk + en', { url: 'https://www.pumps.co.uk/', language: 'en' }, 'en-GB', /ccTLD \.uk suggests region GB/],
    ['.uk + en', { url: 'https://pumps.uk/', language: 'en' }, 'en-GB', /ccTLD \.uk/],
    ['.com + en', { url: 'https://pumps.com/', language: 'en' }, 'en-*', /language en, region unknown/],
    ['.nl + en stays region-less', { url: 'https://pumps.nl/', language: 'en' }, 'en-*', /region unknown/],
    ['.at + de', { url: 'https://x.at/', language: 'de' }, 'de-AT', /ccTLD \.at suggests region AT/],
    ['.de + de', { url: 'https://x.de/', language: 'de' }, 'de-DE', /ccTLD \.de/],
    ['.ch + it', { url: 'https://x.ch/', language: 'it' }, 'it-CH', /ccTLD \.ch/],
    ['.it + it', { url: 'https://x.it/', language: 'it' }, 'it-IT', /ccTLD \.it/],
    ['.de + nl gives no region for the wrong language', { url: 'https://x.de/', language: 'nl' }, 'nl-NL', /language nl \(defaults to nl-NL\)/],
    // language only
    ['nl defaults to nl-NL', { language: 'nl' }, 'nl-NL', /language nl \(defaults to nl-NL\)/],
    ['en is region-less', { language: 'en' }, 'en-*', /language en, region unknown/],
    ['other languages are region-less', { language: 'fr' }, 'fr-*', /language fr, region unknown/],
    ['language is case-insensitive', { language: 'NL' }, 'nl-NL', /language nl/],
    ['unknown language', { language: 'und' }, 'und', /language could not be determined/],
    ['unknown language with unusable attribute', { html_lang: 'x-default', language: 'und' }, 'und', /could not be determined/],
    ['an unparsable url gives no hint', { url: 'not a url', language: 'nl' }, 'nl-NL', /defaults to nl-NL/],
  ];

  it.each(cases)('%s', (_name, input, locale, evidence) => {
    const r = determineSourceLocale(input);
    expect(r.source_locale).toBe(locale);
    expect(r.evidence).toMatch(evidence);
  });
});
