import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { lintSegment, normalizeFormats } from '../src/lint/index.js';
import type { LintContext } from '../src/lint/types.js';
import type { LocaleCode } from '../src/schemas/common.js';

const cfg = loadConfig();
const ctxOf = (target: LocaleCode): LintContext => ({
  target,
  profile: cfg.locales[target],
  common: cfg.common,
  glossary: cfg.glossary,
  thresholds: { back_translation_similarity_min: 0.4 },
});

describe('protected number phrases (names and standard designations)', () => {
  const source = 'Geschikt voor Industrie 4.0 bij 12,5 bar volgens EN 12845:2019 en IEC 60034-30-1.';

  it('the normaliser converts real numbers but never the number part of "Industrie 4.0" or a standard', () => {
    const r = normalizeFormats(
      { source_text: source, source_lang: 'nl', source_locale: 'nl-NL', target_text: 'Suitable for Industry 4.0 at 12,5 bar per EN 12845:2019 and IEC 60034-30-1.', target: 'en-GB' },
      ctxOf('en-GB'),
    );
    expect(r.text).toBe('Suitable for Industry 4.0 at 12.5 bar per EN 12845:2019 and IEC 60034-30-1.');
    expect(r.changes.map((c) => `${c.from}→${c.to}`)).toEqual(['12,5→12.5']);
    const de = normalizeFormats(
      { source_text: source, source_lang: 'nl', source_locale: 'nl-NL', target_text: 'Geeignet für Industrie 4.0 bei 12,5 bar nach EN 12845:2019 und IEC 60034-30-1.', target: 'de-CH' },
      ctxOf('de-CH'),
    );
    expect(de.text).toBe('Geeignet für Industrie 4.0 bei 12.5 bar nach EN 12845:2019 und IEC 60034-30-1.');
  });

  it('the entity rule requires the protected number to survive verbatim', () => {
    const lint = (target: string) =>
      lintSegment(
        { segment_id: 'p-001', block_type: 'paragraph', operation: 'TRANSLATE_LOCALIZE', source_text: source, source_lang: 'nl', source_locale: 'nl-NL', target_text: target, translatable: true },
        ctxOf('de-DE'),
      ).findings.filter((f) => f.rule_or_category === 'INTEGRITY-ENTITY');
    expect(lint('Geeignet für Industrie 4.0 bei 12,5 bar nach EN 12845:2019 und IEC 60034-30-1.')).toEqual([]);
    expect(lint('Geeignet für Industrie 4,0 bei 12,5 bar nach EN 12845:2019 und IEC 60034-30-1.').length).toBeGreaterThan(0);
    expect(lint('Geeignet für Industrie 4.0 bei 12,5 bar nach EN 12854:2019 und IEC 60034-30-1.').length).toBeGreaterThan(0);
  });

  it('other decimals next to the same words are still reformatted', () => {
    const r = normalizeFormats(
      { source_text: 'Versie 4.5 van de pomp', source_lang: 'nl', source_locale: 'nl-NL', target_text: 'Version 4.5 of the pump', target: 'de-DE' },
      ctxOf('de-DE'),
    );
    expect(r.text).toBe('Version 4,5 of the pump');
  });
});
