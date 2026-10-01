/**
 * OpenAPI structural parser.
 *
 * Reads the upstream `openapi.yaml` and produces a structural view of every
 * operation: `{ id, method, path, request?, response? }`. This is the
 * "structural truth" half of the canonical IR; behavioral truth comes from
 * the YAML overlays (see {@link ../normalize/contract-normalizer.ts}).
 *
 * This parser intentionally does NOT depend on any OpenAPI-specific runtime
 * library — the Ollama OpenAPI spec is small and stable enough to walk with
 * js-yaml + a thin traversal. Adding `@apidevtools/openapi-types` is a
 * future option if the spec grows.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';

/** A single operation discovered in the OpenAPI spec. */
export interface ParsedOpenApiOperation {
  readonly operationId: string;
  readonly method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  readonly path: string;
  readonly requestBodyRef?: string;
  readonly responseRef?: string;
}

/**
 * A JSON Schema node extracted from the OpenAPI `components.schemas` section.
 * The shape is intentionally permissive — the OpenAPI spec is the source of
 * truth, and we pass through unknown keywords rather than reject them.
 */
export interface JsonSchemaNode {
  readonly type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
  readonly description?: string;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly items?: JsonSchemaNode;
  readonly $ref?: string;
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly allOf?: readonly JsonSchemaNode[];
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly format?: string;
  readonly default?: unknown;
  readonly additionalProperties?: boolean | JsonSchemaNode;
  readonly [keyword: string]: unknown;
}

/** A named schema definition with its name resolved from `components.schemas`. */
export interface ParsedSchema {
  readonly name: string;
  readonly schema: JsonSchemaNode;
}

/** Result of parsing the upstream OpenAPI spec. */
export interface ParsedOpenApi {
  readonly operations: readonly ParsedOpenApiOperation[];
  readonly schemaNames: readonly string[];
  readonly schemas: readonly ParsedSchema[];
  readonly info: {
    readonly title?: string;
    readonly version?: string;
  };
}

interface OpenApiPathItem {
  readonly get?: OpenApiOperation;
  readonly post?: OpenApiOperation;
  readonly delete?: OpenApiOperation;
  readonly put?: OpenApiOperation;
  readonly patch?: OpenApiOperation;
}

interface OpenApiOperation {
  readonly operationId?: string;
  readonly requestBody?: {
    readonly content?: Readonly<Record<string, { readonly schema?: { readonly $ref?: string } }>>;
  };
  readonly responses?: Readonly<
    Record<
      string,
      {
        readonly content?: Readonly<
          Record<string, { readonly schema?: { readonly $ref?: string } }>
        >;
      }
    >
  >;
}

interface OpenApiDocument {
  readonly openapi?: string;
  readonly info?: { readonly title?: string; readonly version?: string };
  readonly paths?: Readonly<Record<string, OpenApiPathItem>>;
  readonly components?: {
    readonly schemas?: Readonly<Record<string, JsonSchemaNode>>;
  };
}

const METHODS = ['get', 'post', 'delete', 'put', 'patch'] as const;

/**
 * Ollama's OpenAPI spec sometimes uses operationId and sometimes doesn't
 * (older snapshots only had path+method). When missing, derive a stable id
 * by camelCasing the path segments.
 */
function deriveOperationId(method: string, path: string, explicit?: string): string {
  if (explicit) return explicit;
  const cleaned = path.replace(/^\//, '').replace(/[{}]/g, '').replace(/\//g, '_');
  const segments = cleaned.split('_').filter((segment) => segment.length > 0);
  const camel = segments
    .map((segment, index) => {
      const lower = segment.toLowerCase();
      return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
  return `${method.toLowerCase()}${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

function refName(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const match = /#\/components\/schemas\/(.+)$/.exec(ref);
  return match?.[1];
}

/** Parse an OpenAPI YAML file into a structural operation list + named schemas. */
export function parseOpenApi(filePath: string): ParsedOpenApi {
  const absolute = resolve(filePath);
  const raw = readFileSync(absolute, 'utf8');
  const doc = yaml.load(raw) as OpenApiDocument;

  const operations: ParsedOpenApiOperation[] = [];
  const schemaMap = doc.components?.schemas ?? {};
  const schemaNames = Object.keys(schemaMap);
  const schemas: ParsedSchema[] = schemaNames.map((name) => ({
    name,
    schema: schemaMap[name] as JsonSchemaNode,
  }));

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op) continue;
      const requestRef = refName(op.requestBody?.content?.['application/json']?.schema?.$ref);
      const responseRef = refName(
        op.responses?.['200']?.content?.['application/json']?.schema?.$ref ??
          op.responses?.['200']?.content?.['application/x-ndjson']?.schema?.$ref,
      );
      operations.push({
        operationId: deriveOperationId(method.toUpperCase(), path, op.operationId),
        method: method.toUpperCase() as 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH',
        path,
        ...(requestRef ? { requestBodyRef: requestRef } : {}),
        ...(responseRef ? { responseRef: responseRef } : {}),
      });
    }
  }

  return {
    operations,
    schemaNames,
    schemas,
    info: {
      ...(doc.info?.title ? { title: doc.info.title } : {}),
      ...(doc.info?.version ? { version: doc.info.version } : {}),
    },
  };
}
