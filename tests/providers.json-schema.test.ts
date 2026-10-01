/**
 * JSON-Schema sanitizers: every LLM wire schema passes through every dialect and still describes the same shape
 * (checked with a small JSON-Schema validator: generated samples validate against the sanitized schema AND Zod).
 */
import { describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';
import { toJsonSchema } from '../src/providers/base.js';
import { sanitizeJsonSchema, UnsupportedSchemaError, type JsonSchema, type SchemaDialect } from '../src/providers/json-schema.js';
import {
  BackTranslateBatchWireSchema,
  JudgeBatchWireSchema,
  LangDetectBatchWireSchema,
  LocalizeBatchWireSchema,
  RepairBatchWireSchema,
  TranslateBatchWireSchema,
} from '../src/schemas/index.js';

const WIRE: Record<string, ZodType> = {
  TranslateBatchWireSchema,
  LocalizeBatchWireSchema,
  JudgeBatchWireSchema,
  BackTranslateBatchWireSchema,
  RepairBatchWireSchema,
  LangDetectBatchWireSchema,
};
const NATIVE: SchemaDialect[] = ['openai', 'anthropic', 'gemini', 'ollama'];
const FORBIDDEN_EVERYWHERE = ['$ref', '$defs', 'definitions', '$schema', '$id', 'oneOf', 'allOf', 'const', 'default', 'propertyNames', 'pattern', 'title'];
const FORBIDDEN: Record<string, string[]> = {
  openai: ['minLength', 'maxLength'],
  anthropic: ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems'],
  gemini: ['minLength', 'maxLength', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
  ollama: ['format', 'minimum', 'maximum', 'multipleOf'],
};

const isObj = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Minimal JSON-Schema validator for the keywords the sanitizers emit. */
function validates(schema: JsonSchema, value: unknown): boolean {
  if (Array.isArray(schema['anyOf'])) return (schema['anyOf'] as JsonSchema[]).some((s) => validates(s, value));
  if (Array.isArray(schema['enum']) && !(schema['enum'] as unknown[]).some((e) => e === value)) return false;
  switch (schema['type']) {
    case 'object': {
      if (!isObj(value)) return false;
      const props = isObj(schema['properties']) ? schema['properties'] : {};
      const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
      if (required.some((k) => !(k in value))) return false;
      if (schema['additionalProperties'] === false && Object.keys(value).some((k) => !(k in props))) return false;
      return Object.entries(value).every(([k, v]) => !isObj(props[k]) || validates(props[k], v));
    }
    case 'array':
      return Array.isArray(value) && (!isObj(schema['items']) || value.every((v) => validates(schema['items'] as JsonSchema, v)));
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/** A value of the shape the schema describes (first enum member / anyOf branch, one array item). */
function sample(schema: JsonSchema): unknown {
  if (Array.isArray(schema['enum'])) return (schema['enum'] as unknown[])[0];
  if (Array.isArray(schema['anyOf'])) return sample((schema['anyOf'] as JsonSchema[])[0] ?? {});
  switch (schema['type']) {
    case 'object':
      return Object.fromEntries(Object.entries(isObj(schema['properties']) ? schema['properties'] : {}).map(([k, v]) => [k, sample(v as JsonSchema)]));
    case 'array':
      return [sample(isObj(schema['items']) ? schema['items'] : {})];
    case 'number':
      return 0.5;
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return 'x';
  }
}

function walk(node: unknown, visit: (n: JsonSchema) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (isObj(node)) {
    visit(node);
    for (const [k, v] of Object.entries(node)) if (k !== 'enum') walk(v, visit);
  }
}

describe.each(Object.entries(WIRE))('%s', (_name, wire) => {
  const raw = toJsonSchema(wire);
  const rawSample = sample(raw);

  it.each(NATIVE)('%s: only supported keywords, closed objects, every property required', (dialect) => {
    const s = sanitizeJsonSchema(raw, dialect);
    expect(s['type']).toBe('object');
    walk(s, (node) => {
      for (const k of [...FORBIDDEN_EVERYWHERE, ...(FORBIDDEN[dialect] ?? [])]) expect(node, `${dialect}: ${k}`).not.toHaveProperty(k);
      if (node['type'] === 'object') {
        expect(node['additionalProperties']).toBe(false);
        expect([...(node['required'] as string[])].sort()).toEqual(Object.keys(node['properties'] as object).sort());
      }
    });
  });

  it.each([...NATIVE, 'prompt' as const])('%s: still describes the same shape', (dialect) => {
    const s = sanitizeJsonSchema(raw, dialect);
    const own = sample(s);
    expect(validates(s, own)).toBe(true);
    expect(wire.safeParse(own).success).toBe(true);
    expect(validates(s, rawSample)).toBe(true);
    // a missing required field and an unknown field are both rejected
    const results = (own as { results: Array<Record<string, unknown>> }).results;
    const first = results[0] ?? {};
    const firstKey = Object.keys(first)[0] ?? 'segment_id';
    const { [firstKey]: _dropped, ...partial } = first;
    const missing = { results: [partial] };
    expect(validates(s, missing)).toBe(false);
    expect(wire.safeParse(missing).success).toBe(false);
    if (dialect !== 'prompt') expect(validates(s, { ...(own as object), surprise: 1 })).toBe(false);
  });
});

describe('enums survive and reject unknown values', () => {
  it.each(NATIVE)('%s', (dialect) => {
    const s = sanitizeJsonSchema(toJsonSchema(LangDetectBatchWireSchema), dialect);
    const bad = { results: [{ segment_id: 'p-1', lang: 'klingon', confidence: 0.9 }] };
    expect(validates(s, bad)).toBe(false);
    expect(validates(s, { results: [{ segment_id: 'p-1', lang: 'de', confidence: 0.9 }] })).toBe(true);
    const judge = sanitizeJsonSchema(toJsonSchema(JudgeBatchWireSchema), dialect);
    const item = (judge['properties'] as { results: { items: { properties: { mqm_errors: { items: { properties: { severity: JsonSchema } } } } } } }).results.items.properties
      .mqm_errors.items.properties.severity;
    expect(item['enum']).toEqual(['minor', 'major', 'critical']);
  });
});

describe('general constructs', () => {
  const Named = z.object({ x: z.string() }).meta({ id: 'Named' });
  const Complex = z.object({
    a: z.string().min(1).max(5).regex(/^x/),
    n: z.number().int().min(0).max(10),
    opt: z.string().optional(),
    e: z.email(),
    arr: z.array(z.string()).min(1).max(3),
    u: z.union([z.string(), z.number()]),
    nul: z.string().nullable(),
    lit: z.literal('x'),
    ref1: Named,
    ref2: z.array(Named).describe('list of named'),
  });
  const raw = toJsonSchema(Complex);
  const props = (s: JsonSchema) => s['properties'] as Record<string, JsonSchema>;

  it('openai: keeps numeric/array bounds and known formats, drops string lengths and patterns, inlines $refs', () => {
    const p = props(sanitizeJsonSchema(raw, 'openai'));
    expect(p['a']).toEqual({ type: 'string' });
    expect(p['n']).toMatchObject({ type: 'integer', minimum: 0, maximum: 10 });
    expect(p['e']).toEqual({ type: 'string', format: 'email' });
    expect(p['arr']).toMatchObject({ minItems: 1, maxItems: 3 });
    expect(p['u']).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] });
    expect(p['nul']).toMatchObject({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(p['lit']).toEqual({ type: 'string', enum: ['x'] });
    expect(p['ref1']).toEqual({ type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false });
    expect(p['ref2']).toMatchObject({ type: 'array', description: 'list of named', items: { type: 'object' } });
    expect(sanitizeJsonSchema(raw, 'openai')['required']).toContain('opt');
  });
  it('anthropic drops numeric and array bounds; gemini keeps them; ollama keeps lengths only', () => {
    const a = props(sanitizeJsonSchema(raw, 'anthropic'));
    expect(a['n']).toEqual({ type: 'integer' });
    expect(a['arr']).toEqual({ type: 'array', items: { type: 'string' } });
    expect(a['e']).toEqual({ type: 'string', format: 'email' });
    const g = props(sanitizeJsonSchema(raw, 'gemini'));
    expect(g['n']).toMatchObject({ minimum: 0, maximum: 10 });
    expect(g['a']).toEqual({ type: 'string' });
    const o = props(sanitizeJsonSchema(raw, 'ollama'));
    expect(o['a']).toEqual({ type: 'string', minLength: 1, maxLength: 5 });
    expect(o['e']).toEqual({ type: 'string' });
    expect(o['n']).toEqual({ type: 'integer' });
  });
  it('prompt: keeps every constraint and the optionality, drops only meta keys', () => {
    const s = sanitizeJsonSchema(raw, 'prompt');
    expect(s['$schema']).toBeUndefined();
    expect(s['$defs']).toBeUndefined();
    expect(props(s)['a']).toMatchObject({ minLength: 1, maxLength: 5, pattern: '^x' });
    expect(s['required']).not.toContain('opt');
  });
  it('merges allOf (intersections)', () => {
    const s = sanitizeJsonSchema(toJsonSchema(z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }))), 'openai');
    expect(s).toEqual({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false });
  });
  it('reports what a native dialect cannot express', () => {
    interface Tree {
      name: string;
      children: Tree[];
    }
    const TreeSchema: z.ZodType<Tree> = z.lazy(() => z.object({ name: z.string(), children: z.array(TreeSchema) }));
    const recursive = toJsonSchema(z.object({ root: TreeSchema }));
    for (const d of NATIVE) expect(() => sanitizeJsonSchema(recursive, d)).toThrow(UnsupportedSchemaError);
    expect(() => sanitizeJsonSchema(recursive, 'prompt')).not.toThrow();
    const record = toJsonSchema(z.object({ tags: z.record(z.string(), z.number()) }));
    expect(() => sanitizeJsonSchema(record, 'anthropic')).toThrow(/records/);
    expect(sanitizeJsonSchema(record, 'prompt')['properties']).toBeDefined();
    expect(() => sanitizeJsonSchema(toJsonSchema(z.object({ t: z.tuple([z.string(), z.number()]) })), 'gemini')).toThrow(/tuple/);
    expect(() => sanitizeJsonSchema(toJsonSchema(z.array(z.string())), 'openai')).toThrow(/root/);
    expect(sanitizeJsonSchema(toJsonSchema(z.array(z.string())), 'anthropic')).toEqual({ type: 'array', items: { type: 'string' } });
    expect(() => sanitizeJsonSchema(toJsonSchema(z.object({ any: z.unknown() })), 'openai')).toThrow(/without "type"/);
  });
});
