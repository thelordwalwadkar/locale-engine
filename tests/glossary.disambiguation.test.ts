/** Glossary terms that are also an ordinary word in another sense (Dutch lager = bearing / lower, druk = pressure / busy). */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { findGlossaryHits, parseGlossaryCsv } from '../src/config/glossary.js';

const HEADER = 'term_id,category,do_not_translate,nl-NL,en-NL,en-GB,de-DE,de-AT,de-CH,it-IT,notes,skip_after,skip_before';
const csv = [
  HEADER,
  'GLOSS-0033,component,false,lager,bearing,bearing,Lager,Lager,Lager,cuscinetto,Noun only,"^\\s+(?:gelegen|dan)\\b",',
  'GLOSS-0017,hydraulics,false,druk,pressure,pressure,Druck,Druck,Druck,pressione,busy,,"\\b(?:erg|te)\\s+$"',
  'GLOSS-0012,pump_type,false,centrifugaalpomp,centrifugal pump,centrifugal pump,Kreiselpumpe,Kreiselpumpe,Kreiselpumpe,pompa centrifuga,',
].join('\n');
const glossary = parseGlossaryCsv(csv);
const ids = (text: string): string[] => findGlossaryHits(text, 'nl', glossary).map((h) => h.term_id);

describe('glossary sense disambiguation (skip_after / skip_before)', () => {
  it('parses the optional columns and leaves entries without them untouched', () => {
    expect(glossary.find((e) => e.term_id === 'GLOSS-0033')).toMatchObject({ skip_after: '^\\s+(?:gelegen|dan)\\b' });
    expect(glossary.find((e) => e.term_id === 'GLOSS-0033')?.skip_before).toBeUndefined();
    expect(glossary.find((e) => e.term_id === 'GLOSS-0017')).toMatchObject({ skip_before: '\\b(?:erg|te)\\s+$' });
    expect(glossary.find((e) => e.term_id === 'GLOSS-0012')?.skip_after).toBeUndefined();
  });

  it('ignores a hit that the text after it shows to be the other sense, and keeps the real one', () => {
    expect(ids('een lager gelegen put of bron')).toEqual([]);
    expect(ids('lager dan de zuigzijde')).toEqual([]);
    expect(ids('De lagers van de pomp zijn gesmeerd.')).toEqual(['GLOSS-0033']);
    expect(ids('Het lager is versleten.')).toEqual(['GLOSS-0033']);
  });

  it('ignores a hit that the text before it shows to be the other sense', () => {
    expect(ids('Het is erg druk op de weg.')).toEqual([]);
    expect(ids('De druk is te hoog.')).toEqual(['GLOSS-0017']);
    expect(ids('Een relatief hoge druk.')).toEqual(['GLOSS-0017']);
  });

  it('still finds every other occurrence in the same text', () => {
    expect(ids('Het lager gelegen lager is een centrifugaalpomp-lager.')).toEqual(['GLOSS-0033', 'GLOSS-0012', 'GLOSS-0033']);
  });

  it('rejects an invalid regular expression with the glossary file named', () => {
    const bad = [HEADER, 'GLOSS-0033,component,false,lager,bearing,bearing,Lager,Lager,Lager,cuscinetto,,"(unclosed",'].join('\n');
    expect(() => parseGlossaryCsv(bad, 'bad.csv')).toThrow(/bad\.csv.*skip_after/s);
  });
});

describe('the shipped glossary', () => {
  const real = loadConfig().glossary;
  const hits = (text: string): string[] => findGlossaryHits(text, 'nl', real).map((h) => h.term_id);

  it('no longer reads the adjective in "lager gelegen put of bron" as the bearing', () => {
    expect(hits('uit een lager gelegen put of bron')).not.toContain('GLOSS-0033');
    expect(hits('Solide as/lager-constructie voor zware belastingen')).toContain('GLOSS-0033');
    expect(hits('De lagers van de pomp')).toContain('GLOSS-0033');
  });
});
