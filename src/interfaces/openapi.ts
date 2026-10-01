/**
 * The REST surface (spec §6.4) and its OpenAPI 3.1 document. The document is assembled from the same Zod schemas as the MCP
 * tools and the CLI, through the same `toJsonSchema`, so `/openapi.json` cannot disagree with what the server validates.
 */
import { z } from 'zod';
import {
  CompareReportSchema,
  CompareRequestSchema,
  GetRunReportRequestSchema,
  ListLocalesResponseSchema,
  PipelineRequestSchema,
  RunReportSchema,
  ValidateRequestSchema,
} from '../schemas/index.js';
import { CAPABILITIES, inputJsonSchema, toJsonSchema } from './capabilities.js';
import type { AnyCapability, JsonObject, JsonSchema } from './capabilities.js';
import { ErrorBodySchema } from './errors.js';

export interface RestRoute {
  readonly method: 'GET' | 'POST';
  /** Fastify syntax: `/v1/runs/:run_id`. */
  readonly path: string;
  readonly cap: AnyCapability;
  /** Error statuses this route can answer with, besides 200. */
  readonly errors: readonly number[];
}

const POST_ERRORS = [400, 413, 415, 422, 500, 502, 503] as const;

export const REST_ROUTES: readonly RestRoute[] = [
  { method: 'POST', path: '/v1/pipeline', cap: CAPABILITIES.run_pipeline, errors: POST_ERRORS },
  { method: 'POST', path: '/v1/translate', cap: CAPABILITIES.translate_content, errors: POST_ERRORS },
  { method: 'POST', path: '/v1/localize', cap: CAPABILITIES.localize_content, errors: POST_ERRORS },
  { method: 'POST', path: '/v1/validate', cap: CAPABILITIES.validate_content, errors: [400, 413, 415, 422, 500, 503] },
  { method: 'POST', path: '/v1/compare', cap: CAPABILITIES.compare_models, errors: POST_ERRORS },
  { method: 'GET', path: '/v1/locales', cap: CAPABILITIES.list_locales, errors: [500] },
  { method: 'GET', path: '/v1/runs/:run_id', cap: CAPABILITIES.get_run_report, errors: [400, 404, 500] },
];

const HealthBodySchema = z.object({ status: z.literal('ok'), version: z.string() });

const STATUS_TEXT: Record<number, string> = {
  400: 'INVALID_REQUEST (see `issues`) or INPUT_INVALID: the request or its input cannot be used.',
  404: 'RUN_NOT_FOUND: there is no such run.',
  413: 'PAYLOAD_TOO_LARGE: the request body is over the size limit.',
  415: 'UNSUPPORTED_MEDIA_TYPE (send application/json) or UNSUPPORTED_FORMAT (file type of the input).',
  422: 'The input cannot be processed: URL_BLOCKED, ROBOTS_DISALLOWED, COST_CEILING or UNSUPPORTED_ROUTE.',
  500: 'INTERNAL: unexpected failure; the detail is only in the server log.',
  502: 'FETCH_FAILED: the page could not be fetched.',
  503: 'PROVIDER_UNAVAILABLE: no LLM provider has credentials.',
};

/** Components are named by schema identity: translate, localize and pipeline share one request schema. */
const SCHEMA_NAMES = new Map<z.ZodType | undefined, string>([
  [PipelineRequestSchema, 'PipelineRequest'],
  [ValidateRequestSchema, 'ValidateRequest'],
  [CompareRequestSchema, 'CompareRequest'],
  [CompareReportSchema, 'CompareReport'],
  [GetRunReportRequestSchema, 'GetRunReportRequest'],
  [RunReportSchema, 'RunReport'],
  [ListLocalesResponseSchema, 'ListLocalesResponse'],
]);

const ref = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (schema: JsonObject): JsonObject => ({ 'application/json': { schema } });
const openApiPath = (path: string): string => path.replace(/:(\w+)/g, '{$1}');

function nameOf(schema: z.ZodType): string {
  const name = SCHEMA_NAMES.get(schema);
  if (!name) throw new Error('schema has no OpenAPI component name; add it to SCHEMA_NAMES');
  return name;
}

/** GET routes take their input from the path and the query string: one parameter per property of the request schema. */
function parametersOf(route: RestRoute): JsonObject[] {
  const schema = inputJsonSchema(route.cap) as { properties?: Record<string, JsonSchema>; required?: string[] };
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    in: route.path.includes(`:${name}`) ? 'path' : 'query',
    required: schema.required?.includes(name) ?? false,
    schema: property,
  }));
}

function operation(route: RestRoute): JsonObject {
  const { cap } = route;
  const errorResponses = Object.fromEntries(route.errors.map((status) => [String(status), { description: STATUS_TEXT[status], content: jsonContent(ref('ErrorResponse')) }]));
  return {
    operationId: cap.name,
    summary: cap.title,
    description: cap.description,
    ...(cap.input && route.method === 'POST' ? { requestBody: { required: true, content: jsonContent(ref(nameOf(cap.input))) } } : {}),
    ...(cap.input && route.method === 'GET' ? { parameters: parametersOf(route) } : {}),
    responses: { '200': { description: 'The result, exactly as the engine returned it.', content: jsonContent(ref(nameOf(cap.output))) }, ...errorResponses },
  };
}

export function buildOpenApiDocument(version: string): JsonObject {
  const schemas: Record<string, JsonSchema> = {
    ErrorResponse: toJsonSchema(ErrorBodySchema, 'output'),
    HealthResponse: toJsonSchema(HealthBodySchema, 'output'),
  };
  const paths: Record<string, JsonObject> = {
    '/health': {
      get: { operationId: 'health', summary: 'Liveness probe', responses: { '200': { description: 'The server is up.', content: jsonContent(ref('HealthResponse')) } } },
    },
    '/openapi.json': {
      get: { operationId: 'openapi', summary: 'This document', responses: { '200': { description: 'OpenAPI 3.1 document.', content: jsonContent({ type: 'object' }) } } },
    },
  };
  for (const route of REST_ROUTES) {
    const key = openApiPath(route.path);
    paths[key] = { ...paths[key], [route.method.toLowerCase()]: operation(route) };
    if (route.cap.input) schemas[nameOf(route.cap.input)] = toJsonSchema(route.cap.input, 'input');
    schemas[nameOf(route.cap.output)] = toJsonSchema(route.cap.output, 'output');
  }
  return {
    openapi: '3.1.0',
    // The schemas are draft-07, the dialect of the MCP tool schemas they are identical to.
    jsonSchemaDialect: 'http://json-schema.org/draft-07/schema#',
    info: {
      title: 'locale-engine API',
      version,
      description: 'Translate, localize and validate B2B web content per target locale. Same capabilities and schemas as the CLI and the MCP server. No authentication is built in.',
    },
    paths,
    components: { schemas },
  };
}
