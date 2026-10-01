/**
 * JSON Schema sanitizers for provider-native structured output.
 *
 * `z.toJSONSchema()` emits draft 2020-12; every vendor accepts a different subset (checked 2026-09-30):
 *  - openai    Structured Outputs `strict: true` (Responses `text.format`, Chat `response_format`): object root,
 *              `additionalProperties: false` and every property `required` on every object, anyOf (no oneOf/allOf/const),
 *              numeric bounds, minItems/maxItems and a fixed `format` list; no minLength/maxLength/propertyNames/defaults.
 *              `pattern` is documented but compiled by another regex engine than Zod's, so it is dropped.
 *  - anthropic `output_config.format` json_schema: enum/anyOf/allOf/$ref, a fixed `format` list, `additionalProperties: false`
 *              on every object; no numeric, string-length or array-length constraints, no recursion.
 *  - gemini    `responseJsonSchema`: only type, format, title, description, enum, items, prefixItems, minItems, maxItems,
 *              minimum, maximum, anyOf, oneOf, properties, additionalProperties, required ($ref/$defs too, inlined here).
 *  - ollama    `format` (llama.cpp grammar): structural keywords and length bounds; formats and patterns are unreliable.
 *  - prompt    json_mode / prompted: the schema is only SHOWN to the model, so every constraint is kept (it informs the model).
 * Every constraint dropped here is still enforced by Zod after parsing (base.ts), so sanitizing never weakens validation.
 * `$ref`s are always inlined; a schema a dialect cannot express raises `UnsupportedSchemaError` (base.ts then uses prompted mode).
 */

export type JsonSchema = { [key: string]: unknown };
export type SchemaDialect = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'prompt';
type NativeDialect = Exclude<SchemaDialect, 'prompt'>;

/** The schema cannot be expressed in a vendor's native structured-output subset. */
export class UnsupportedSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSchemaError';
  }
}

const STRUCTURAL = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', 'description'];
const OPENAI_FORMATS = ['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid'];
const WIDE_FORMATS = [...OPENAI_FORMATS, 'uri'];

interface DialectRules {
  keep: ReadonlySet<string>;
  formats: ReadonlySet<string>;
}

const RULES: Record<NativeDialect, DialectRules> = {
  openai: {
    keep: new Set([...STRUCTURAL, 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems']),
    formats: new Set(OPENAI_FORMATS),
  },
  anthropic: { keep: new Set([...STRUCTURAL, 'format']), formats: new Set(WIDE_FORMATS) },
  gemini: { keep: new Set([...STRUCTURAL, 'format', 'minimum', 'maximum', 'minItems', 'maxItems']), formats: new Set(WIDE_FORMATS) },
  ollama: { keep: new Set([...STRUCTURAL, 'minItems', 'maxItems', 'minLength', 'maxLength']), formats: new Set() },
};

// Keywords whose values are schemas, by container shape (everything else is a literal and is copied as is).
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const SCHEMA_VALUES = new Set([
  'items',
  'additionalProperties',
  'propertyNames',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'additionalItems',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

// Keywords that belong to one JSON type; used when a `type: [a, b]` node is split into anyOf branches.
const TYPE_KEYWORDS: Record<string, readonly string[]> = {
  string: ['minLength', 'maxLength', 'pattern', 'format', 'enum'],
  number: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'enum'],
  integer: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'enum'],
  array: ['items', 'minItems', 'maxItems', 'prefixItems'],
  object: ['properties', 'required', 'additionalProperties', 'propertyNames'],
  boolean: ['enum'],
  null: [],
};

const isObject = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);

export function sanitizeJsonSchema(schema: JsonSchema, dialect: SchemaDialect): JsonSchema {
  const defs: Record<string, unknown> = { ...(isObject(schema['definitions']) ? schema['definitions'] : {}), ...(isObject(schema['$defs']) ? schema['$defs'] : {}) };
  if (dialect === 'prompt') {
    // Shown to the model only: inline for readability, but a recursive schema keeps its $defs rather than failing.
    let shown = schema;
    try {
      shown = inlineRefs(schema, schema, defs, []);
    } catch (e) {
      if (!(e instanceof UnsupportedSchemaError)) throw e;
    }
    const { $schema: _s, $id: _i, ...rest } = shown;
    return rest;
  }
  const inlined = inlineRefs(schema, schema, defs, []);
  const out = normalize(inlined, RULES[dialect], '#');
  if (dialect === 'openai' && out['type'] !== 'object') {
    throw new UnsupportedSchemaError('OpenAI strict structured output needs an object at the schema root');
  }
  return out;
}

function inlineRefs(node: JsonSchema, root: JsonSchema, defs: Record<string, unknown>, stack: string[]): JsonSchema {
  const ref = node['$ref'];
  if (typeof ref === 'string') {
    if (stack.includes(ref)) throw new UnsupportedSchemaError(`recursive schema (${[...stack, ref].join(' -> ')}) cannot be inlined`);
    const target = resolveRef(ref, root, defs);
    const { $ref: _r, ...siblings } = node;
    // Siblings of a $ref (typically a `description`) override the referenced schema's own annotations.
    return { ...inlineRefs(target, root, defs, [...stack, ref]), ...inlineRefs(siblings, root, defs, stack) };
  }
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$defs' || key === 'definitions') continue;
    if (SCHEMA_MAPS.has(key) && isObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isObject(v) ? inlineRefs(v, root, defs, stack) : v]));
    } else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) {
      out[key] = value.map((v) => (isObject(v) ? inlineRefs(v, root, defs, stack) : v));
    } else if (SCHEMA_VALUES.has(key) && isObject(value)) {
      out[key] = inlineRefs(value, root, defs, stack);
    } else if (key === 'items' && Array.isArray(value)) {
      out[key] = value.map((v) => (isObject(v) ? inlineRefs(v, root, defs, stack) : v));
    } else {
      out[key] = value;
    }
  }
  return out;
}

function resolveRef(ref: string, root: JsonSchema, defs: Record<string, unknown>): JsonSchema {
  if (ref === '#') return root;
  const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  const target = m?.[1] !== undefined ? defs[decodeURIComponent(m[1].replace(/~1/g, '/').replace(/~0/g, '~'))] : undefined;
  if (!isObject(target)) throw new UnsupportedSchemaError(`unresolvable $ref "${ref}" (only local #/$defs/… references are supported)`);
  return target;
}

/** Rewrites one (already inlined) node into the dialect's subset; `where` is a JSON pointer used in error messages. */
function normalize(input: JsonSchema, rules: DialectRules, where: string): JsonSchema {
  let node = input;
  if (Array.isArray(node['allOf'])) node = mergeAllOf(node, where);
  if (Array.isArray(node['oneOf'])) {
    const { oneOf, ...rest } = node;
    node = { ...rest, anyOf: oneOf };
  }
  if ('const' in node) {
    const { const: value, ...rest } = node;
    node = { ...rest, enum: [value] };
  }
  const type = node['type'];
  if (Array.isArray(type)) {
    if (type.length === 1) node = { ...node, type: type[0] };
    else return normalize(splitTypeArray(node, type), rules, where);
  }
  if (node['type'] === undefined && !Array.isArray(node['anyOf']) && !Array.isArray(node['enum'])) {
    throw new UnsupportedSchemaError(`${where}: a schema without "type" (unconstrained value) cannot be expressed natively`);
  }
  if (node['prefixItems'] !== undefined || Array.isArray(node['items'])) {
    throw new UnsupportedSchemaError(`${where}: tuple schemas (prefixItems) cannot be expressed natively`);
  }

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (!rules.keep.has(key)) continue;
    if (key === 'format' && !(typeof value === 'string' && rules.formats.has(value))) continue;
    if (key === 'properties' || key === 'required' || key === 'additionalProperties') continue; // rebuilt below
    if (key === 'items' && isObject(value)) out[key] = normalize(value, rules, `${where}/items`);
    else if (key === 'anyOf' && Array.isArray(value)) {
      out[key] = value.map((v, i) => {
        if (!isObject(v)) throw new UnsupportedSchemaError(`${where}/anyOf/${i}: boolean schemas are not supported`);
        return normalize(v, rules, `${where}/anyOf/${i}`);
      });
    } else out[key] = value;
  }

  if (node['type'] === 'object' || isObject(node['properties'])) {
    const extra = node['additionalProperties'];
    const props = isObject(node['properties']) ? node['properties'] : {};
    if (isObject(extra) && Object.keys(extra).length > 0) {
      throw new UnsupportedSchemaError(`${where}: records (additionalProperties with a schema) cannot be expressed natively`);
    }
    const properties: JsonSchema = {};
    for (const [name, sub] of Object.entries(props)) {
      if (!isObject(sub)) throw new UnsupportedSchemaError(`${where}/properties/${name}: boolean schemas are not supported`);
      properties[name] = normalize(sub, rules, `${where}/properties/${name}`);
    }
    out['type'] = 'object';
    out['properties'] = properties;
    // Every property is required: optional fields would need nullable unions, and the model answering every field is harmless.
    out['required'] = Object.keys(properties);
    out['additionalProperties'] = false;
  }
  return out;
}

function mergeAllOf(node: JsonSchema, where: string): JsonSchema {
  const { allOf, ...rest } = node;
  let merged: JsonSchema = rest;
  for (const [i, part] of (allOf as unknown[]).entries()) {
    if (!isObject(part)) throw new UnsupportedSchemaError(`${where}/allOf/${i}: boolean schemas are not supported`);
    const props = { ...(isObject(merged['properties']) ? merged['properties'] : {}), ...(isObject(part['properties']) ? part['properties'] : {}) };
    const required = [...new Set([...asStrings(merged['required']), ...asStrings(part['required'])])];
    merged = { ...merged, ...part, ...(Object.keys(props).length ? { properties: props } : {}), ...(required.length ? { required } : {}) };
  }
  return merged;
}

/** `{type: ['string', 'null'], description}` -> `{description, anyOf: [{type: 'string'}, {type: 'null'}]}`, type keywords per branch. */
function splitTypeArray(node: JsonSchema, types: unknown[]): JsonSchema {
  const { type: _t, ...rest } = node;
  const owned = new Set(Object.values(TYPE_KEYWORDS).flat());
  const outer: JsonSchema = Object.fromEntries(Object.entries(rest).filter(([k]) => !owned.has(k)));
  const branches = types.map((t) => {
    const name = String(t);
    const branch: JsonSchema = { type: name };
    for (const k of TYPE_KEYWORDS[name] ?? []) if (rest[k] !== undefined) branch[k] = rest[k];
    return branch;
  });
  return { ...outer, anyOf: branches };
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
