import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import type { MockCall } from '../src/providers/mock.js';
import { TranslateBatchWireSchema } from '../src/schemas/llm.js';
import { ProviderError } from '../src/schemas/provider.js';
import { EngineError } from '../src/util/errors.js';
import { GOLDEN_SOURCE, goldenFixtures, makeRun, mockProvider, testRegistry } from './helpers/harness.js';

const cfg = loadConfig();

const translationPayload = {
  stage: 'translation',
  source_locale: 'nl-NL',
  target_locale: 'de-CH',
  operation: 'TRANSLATE_LOCALIZE',
  document: { title: null, h1: null, page_type: 'CONTENT' },
  segments: [
    { segment_id: 'p-003', block_type: 'paragraph', meta_kind: null, source_language: 'nl', text: GOLDEN_SOURCE, glossary_term_ids: ['GLOSS-0012', 'GLOSS-0019'] },
    { segment_id: 'h-001', block_type: 'heading', meta_kind: null, source_language: 'nl', text: 'Onze centrifugaalpompen', glossary_term_ids: ['GLOSS-0012'] },
  ],
};
const glossarySystem = '## Glossary\n| id | source term | use | also acceptable | note |\n|---|---|---|---|---|\n| GLOSS-0012 | centrifugaalpomp | Kreiselpumpe |  |  |\n| GLOSS-0019 | opvoerhoogte | Förderhöhe |  |  |\n';

describe('MockProvider', () => {
  it('default translation applies the glossary table of the system prompt and keeps the source text', async () => {
    const p = mockProvider('mock');
    const r = await p.complete(glossarySystem, [{ role: 'user', content: JSON.stringify(translationPayload) }], { max_tokens: 1000 }, TranslateBatchWireSchema);
    const first = r.parsed?.results[0];
    expect(first?.segment_id).toBe('p-003');
    expect(first?.translation).toContain('Kreiselpumpen');
    expect(first?.translation).toContain('Förderhöhe');
    expect(first?.translation).toContain('450 m³/h');
    expect(first?.terminology_applied.map((t) => t.rule)).toEqual(expect.arrayContaining(['GLOSS-0012', 'GLOSS-0019']));
    expect(r.usage.input_tokens).toBeGreaterThan(0);
    expect(r.cost_usd).toBeGreaterThan(0);
    expect(r.provider).toBe('mock');
    expect(r.model).toBe('mock-a');
  });

  it('fixtures replace the default for the segments they cover and leave the rest on defaults', async () => {
    const p = mockProvider('mock', { fixtures: goldenFixtures() });
    const r = await p.complete(glossarySystem, [{ role: 'user', content: JSON.stringify(translationPayload) }], { max_tokens: 1000 }, TranslateBatchWireSchema);
    expect(r.parsed?.results[0]?.translation).toMatch(/^Unsere Kreiselpumpen fördern bis zu 450 m³\/h/);
    expect(r.parsed?.results[0]?.entities_preserved).toEqual(['450 m³/h', '80']);
    expect(r.parsed?.results[1]?.translation).toMatch(/^\[mock de-CH\]/);
  });

  it('prompted models answer with <thinking>/<final_answer>; native models with bare JSON', async () => {
    const prompted = mockProvider('mock', {}, 'mock-b');
    const native = mockProvider('mock');
    const msg = [{ role: 'user' as const, content: JSON.stringify(translationPayload) }];
    expect((await prompted.complete('', msg, { max_tokens: 100 })).raw_text).toContain('<final_answer>');
    expect((await native.complete('', msg, { max_tokens: 100 })).raw_text.startsWith('{')).toBe(true);
  });

  it('reports PARAM_UNSUPPORTED only for parameters the caller set and the model ignores', async () => {
    const p = mockProvider('mock', {}, 'mock-b');
    const msg = [{ role: 'user' as const, content: JSON.stringify(translationPayload) }];
    const withTopP = await p.complete('', msg, { max_tokens: 100, temperature: 0.2, top_p: 0.9 });
    expect(withTopP.warnings.map((w) => w.code)).toEqual(['PARAM_UNSUPPORTED']);
    const without = await p.complete('', msg, { max_tokens: 100, temperature: 0.2 });
    expect(without.warnings).toEqual([]);
  });

  it('can simulate failures and broken output, and records every call', async () => {
    const calls: MockCall[] = [];
    const msg = [{ role: 'user' as const, content: JSON.stringify(translationPayload) }];
    const broken = mockProvider('mock', { calls, rawResponse: () => 'Sure! Here is the translation: {"results": [' });
    await expect(broken.complete('', msg, { max_tokens: 100 }, TranslateBatchWireSchema)).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    const failing = mockProvider('mock', { calls, fail: (c) => new ProviderError('boom', 'SERVER', { provider: c.provider }) });
    await expect(failing.complete('', msg, { max_tokens: 100 })).rejects.toThrow('boom');
    expect(calls.map((c) => c.stage)).toEqual(['translation', 'translation']);
    await expect(mockProvider('mock').complete('', [{ role: 'user', content: 'not json' }], { max_tokens: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('judge default reports exactly one major omission per neutralised claim (prompt rule 5)', async () => {
    const p = mockProvider('mock');
    const payload = {
      stage: 'validation',
      target_locale: 'de-CH',
      segments: [{ segment_id: 'p-003', market_claims: [{ source_phrase: 'in heel Nederland', action: 'NEUTRALIZE', replacement_phrase: null }, { source_phrase: 'in Zwitserland', action: 'KEEP', replacement_phrase: null }] }],
    };
    const r = await p.complete('', [{ role: 'user', content: JSON.stringify(payload) }], { max_tokens: 100 });
    const res = JSON.parse(r.raw_text).results[0];
    expect(res.mqm_errors).toHaveLength(1);
    expect(res.mqm_errors[0]).toMatchObject({ category: 'accuracy/omission', severity: 'major', source_span: 'in heel Nederland' });
    expect(res.mqm_errors[0].explanation).toContain('[EVIDENCE: INTEGRITY-MARKET-CLAIM]');
  });
});

describe('StageRunner', () => {
  const msgSchema = TranslateBatchWireSchema;

  it('records tokens, cost and latency per call and hands the provider the right output mode', async () => {
    const seen: string[] = [];
    const native = mockProvider('mock', { fixtures: goldenFixtures() });
    const run = makeRun(cfg, testRegistry(native));
    const out = await run.runner.call({
      stage: 'translation',
      locale: 'de-CH',
      segments: 2,
      segmentIds: ['p-003', 'h-001'],
      system: (mode) => {
        seen.push(mode);
        return glossarySystem;
      },
      payload: translationPayload,
      schema: msgSchema,
    });
    expect(out.results).toHaveLength(2);
    expect(seen).toEqual(['json']);
    const [rec] = run.costs.calls();
    expect(rec).toMatchObject({ stage: 'translation', locale: 'de-CH', provider: 'mock', model: 'mock-a', ok: true, segments: 2, attempts: 1 });
    expect(rec?.cost_usd).toBeGreaterThan(0);
    expect(run.costs.totals().calls).toBe(1);

    const prompted = makeRun(cfg, testRegistry(mockProvider('mock', {}, 'mock-b')));
    await prompted.runner.call({ stage: 'translation', locale: 'de-CH', segments: 1, system: (m) => (seen.push(m), ''), payload: translationPayload, schema: msgSchema });
    expect(seen).toEqual(['json', 'tagged']);
  });

  it('passes the stage parameters of stages.yaml (spec §0.2) and logs PARAM_UNSUPPORTED', async () => {
    const calls: MockCall[] = [];
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { calls }, 'mock-b')));
    await run.runner.call({ stage: 'localization', locale: 'de-CH', segments: 1, system: () => '', payload: { ...translationPayload, stage: 'localization', segments: [{ segment_id: 'p-003', input_text: 'x', source_text: 'x', market_claims: [] }] }, schema: (await import('../src/schemas/llm.js')).LocalizeBatchWireSchema });
    expect(calls[0]?.params).toMatchObject({ temperature: 0.3, top_p: 0.9, max_tokens: 8192 });
    const warn = run.log.entries().find((e) => e.code === 'PARAM_UNSUPPORTED');
    expect(warn).toMatchObject({ level: 'warn', stage: 'localization', provider: 'mock', locale: 'de-CH' });
    expect(run.costs.calls()[0]?.warnings).toEqual(['PARAM_UNSUPPORTED']);
  });

  it('enforces the cost ceiling before calling the provider', async () => {
    const calls: MockCall[] = [];
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { calls })), { ceiling: 0.0000001 });
    const call = () => run.runner.call({ stage: 'translation', locale: 'de-CH', segments: 1, system: () => '', payload: translationPayload, schema: msgSchema });
    await call(); // the first call is allowed and pushes spending over the ceiling
    await expect(call()).rejects.toMatchObject({ code: 'COST_CEILING' });
    await expect(call()).rejects.toBeInstanceOf(EngineError);
    expect(calls).toHaveLength(1);
    expect(run.costs.exceeded).toBe(true);
  });

  it('records a failed call and a PROVIDER_ERROR log entry, then rethrows', async () => {
    const run = makeRun(cfg, testRegistry(mockProvider('mock', { fail: (c) => new ProviderError('rate limited', 'RATE_LIMIT', { provider: c.provider, status: 429 }) })));
    await expect(run.runner.call({ stage: 'translation', locale: 'de-CH', segments: 1, segmentIds: ['p-003'], system: () => '', payload: translationPayload, schema: msgSchema })).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(run.costs.calls()[0]).toMatchObject({ ok: false, input_tokens: 0, cost_usd: 0, warnings: ['RATE_LIMIT'] });
    const e = run.log.entries().find((x) => x.code === 'PROVIDER_ERROR');
    expect(e).toMatchObject({ level: 'error', stage: 'translation', locale: 'de-CH', segment_id: 'p-003' });
    expect(e?.message).toContain('RATE_LIMIT');
  });

  it('a failed call that already spent tokens still counts toward the cost ceiling', async () => {
    const spend = { usage: { input_tokens: 2000, output_tokens: 1000 }, cost_usd: 0.5, attempts: 2 };
    const run = makeRun(
      cfg,
      testRegistry(mockProvider('mock', { fail: (c) => Object.assign(new ProviderError('invalid JSON twice', 'SCHEMA_INVALID', { provider: c.provider }), spend) })),
      { ceiling: 0.4 },
    );
    const call = () => run.runner.call({ stage: 'translation', locale: 'de-CH', segments: 1, system: () => '', payload: translationPayload, schema: msgSchema });
    await expect(call()).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    expect(run.costs.calls()[0]).toMatchObject({ ok: false, input_tokens: 2000, output_tokens: 1000, cost_usd: 0.5, attempts: 2 });
    expect(run.costs.totals().cost_usd).toBe(0.5);
    await expect(call()).rejects.toMatchObject({ code: 'COST_CEILING' });
  });

  it('reports the binding (provider and model id) per stage', () => {
    const run = makeRun(cfg, testRegistry(mockProvider('mock'), { validation: mockProvider('judge', {}, 'mock-b') }));
    expect(run.runner.binding('translation')).toEqual({ provider: 'mock', model: 'mock-a' });
    expect(run.runner.binding('validation')).toEqual({ provider: 'judge', model: 'mock-b' });
  });
});
