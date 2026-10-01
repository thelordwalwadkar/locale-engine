import { describe, expect, it } from 'vitest';
import { classifyPage } from '../src/ingest/classify.js';
import { stages } from './fixtures/ingest/deps.js';

const cfg = stages.page_classification;

describe('classifyPage', () => {
  it('classifies /privacyverklaring as LEGAL and says why', () => {
    const r = classifyPage({ urlOrPath: 'https://www.example.nl/privacyverklaring' }, cfg);
    expect(r.page_type).toBe('LEGAL');
    expect(r.evidence).toBe('url path "/privacyverklaring" matches legal pattern "privacyverklaring"');
  });

  it.each([
    'https://x.nl/privacy-policy/',
    'https://x.nl/nl/privacyverklaring.html',
    'https://x.de/datenschutzerklaerung',
    'https://x.de/impressum',
    'https://x.de/agb',
    'https://x.nl/algemene-voorwaarden',
    'https://x.nl/over-ons/disclaimer',
    'https://x.com/terms-and-conditions',
    'https://x.com/legal',
    'https://x.nl/cookiebeleid',
    'https://x.it/informativa',
    'https://x.it/condizioni-di-vendita',
    'https://x.nl/%70rivacyverklaring',
  ])('treats %s as a legal page', (url) => {
    expect(classifyPage({ urlOrPath: url }, cfg).page_type).toBe('LEGAL');
  });

  it.each([
    'https://x.nl/',
    'https://x.nl/producten/dompelpompen',
    'https://x.nl/privacyproof-pompen',
    'https://x.nl/legalisatie',
    'https://x.nl/termsheet-pompen',
    'https://x.nl/?page=privacy',
    'https://x.nl/agbeton',
  ])('treats %s as content', (url) => {
    const r = classifyPage({ urlOrPath: url }, cfg);
    expect(r.page_type).toBe('CONTENT');
    expect(r.evidence).toMatch(/^no legal pattern matched/);
  });

  it('classifies by title or first heading when the URL says nothing', () => {
    const byTitle = classifyPage({ urlOrPath: 'https://x.nl/pagina-7', title: 'Privacy policy' }, cfg);
    expect(byTitle.page_type).toBe('LEGAL');
    expect(byTitle.evidence).toBe('title "Privacy policy" matches legal title pattern "Privacy policy"');
    const byHeading = classifyPage({ title: 'Welkom', h1: 'Algemene voorwaarden van Van Dijk Pompen' }, cfg);
    expect(byHeading.page_type).toBe('LEGAL');
    expect(byHeading.evidence).toBe('first heading "Algemene voorwaarden van Van Dijk Pompen" matches legal title pattern "Algemene voorwaarden"');
    expect(classifyPage({ title: 'Terms & Conditions' }, cfg).page_type).toBe('LEGAL');
    expect(classifyPage({ title: 'Datenschutzerklärung' }, cfg).page_type).toBe('LEGAL');
    expect(classifyPage({ title: 'Dompelpompen voor afvalwater', h1: 'Dompelpompen' }, cfg).page_type).toBe('CONTENT');
  });

  it('labels file names and plain names, and tests the caller label as written', () => {
    expect(classifyPage({ urlOrPath: 'privacy.docx' }, cfg).evidence).toBe('file name "privacy.docx" matches legal pattern "privacy"');
    expect(classifyPage({ urlOrPath: '/privacyverklaring' }, cfg).evidence).toContain('url path "/privacyverklaring"');
    expect(classifyPage({ urlOrPath: 'impressum' }, cfg).evidence).toContain('name "impressum"');
    expect(classifyPage({ urlOrPath: 'pompen-overzicht.md' }, cfg).page_type).toBe('CONTENT');
  });

  it('lets the caller override the classification, in both directions', () => {
    const forced = classifyPage({ urlOrPath: 'https://x.nl/privacyverklaring', override: 'CONTENT' }, cfg);
    expect(forced).toEqual({ page_type: 'CONTENT', evidence: 'page type set by the caller: CONTENT' });
    expect(classifyPage({ urlOrPath: 'https://x.nl/pompen', override: 'LEGAL' }, cfg).evidence).toBe('page type set by the caller: LEGAL');
  });

  it('says so when there is nothing to test', () => {
    expect(classifyPage({}, cfg)).toEqual({ page_type: 'CONTENT', evidence: 'no url, title or heading to test; treated as content' });
  });

  it('honours custom patterns from the configuration', () => {
    const custom = { legal_url_patterns: ['/colofon$'], legal_title_patterns: [] };
    expect(classifyPage({ urlOrPath: 'https://x.nl/colofon' }, custom).page_type).toBe('LEGAL');
    expect(classifyPage({ urlOrPath: 'https://x.nl/privacy' }, custom).page_type).toBe('CONTENT');
  });
});
