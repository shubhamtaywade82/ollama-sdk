/**
 * Documentation endpoint discovery.
 *
 * This is the missing half of the legacy {@link scripts/verify-api-parity.ts}
 * parity verifier. The legacy verifier only checked "manifest → docs"
 * (every declared surface had to exist in the docs). It never checked the
 * inverse: "docs → manifest" (every documented endpoint had to be declared
 * in the manifest). That asymmetry let new endpoints like `/v1/systemone`
 * slip into the Ollama docs without ever failing CI.
 *
 * This module walks every docs source the project tracks and produces a
 * deduplicated list of endpoint paths (`/api/*`, `/v1/*`) it can find. The
 * bidirectional discovery validator then diffs this against the operations
 * declared in the canonical IR.
 *
 * Sources:
 *   - The pinned OpenAPI spec (every `paths:` key is an endpoint)
 *   - The OpenAI compatibility MDX (headings like `## /v1/chat/completions`)
 *   - The Anthropic compatibility MDX (headings mentioning `/v1/messages`)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { parseOpenApi } from './openapi.js';

/** A single docs source contributing endpoint paths. */
export interface DocsSource {
  readonly id: string;
  readonly path: string;
  readonly format: 'openapi-yaml' | 'mdx' | 'documented-endpoints-json';
}

/** All endpoints discovered across every docs source. */
export interface DiscoveredEndpoints {
  readonly endpoints: readonly string[];
  readonly bySource: Readonly<Record<string, readonly string[]>>;
  /**
   * Wave 15: operation-level discovery — (method, path) pairs from the
   * OpenAPI source. Path-only sources (MDX, documented-endpoints.json)
   * contribute all methods (GET/POST/DELETE/PUT/PATCH/HEAD) for their
   * paths. This lets the validator detect missing HTTP methods on paths
   * that are already declared.
   */
  readonly operations: readonly { readonly method: string; readonly path: string }[];
}

const DOCS_SOURCES: readonly DocsSource[] = [
  {
    id: 'openapi',
    path: 'contracts/sources/ollama.openapi.yaml',
    format: 'openapi-yaml',
  },
  {
    id: 'openai-compatibility',
    path: 'docs/upstream/ollama-openai-compatibility.mdx',
    format: 'mdx',
  },
  {
    id: 'anthropic-compatibility',
    path: 'docs/upstream/ollama-anthropic-compatibility.mdx',
    format: 'mdx',
  },
  {
    id: 'documented-endpoints',
    path: 'contracts/sources/documented-endpoints.json',
    format: 'documented-endpoints-json',
  },
];

interface OpenApiPathItem {
  readonly get?: unknown;
  readonly post?: unknown;
  readonly delete?: unknown;
  readonly put?: unknown;
  readonly patch?: unknown;
  readonly head?: unknown;
}

interface OpenApiPathList {
  readonly paths?: Readonly<Record<string, OpenApiPathItem>>;
}

const HTTP_METHODS = ['get', 'post', 'delete', 'put', 'patch', 'head'] as const;

function discoverFromOpenApi(absolutePath: string): readonly string[] {
  const raw = readFileSync(absolutePath, 'utf8');
  const doc = yaml.load(raw) as OpenApiPathList;
  return Object.keys(doc.paths ?? {});
}

/**
 * Wave 15: discover (method, path) operation pairs from the OpenAPI source.
 * This lets the validator detect missing HTTP methods on already-declared
 * paths (e.g. if the IR has HEAD /api/blobs/{digest} but not POST).
 */
function discoverOperationsFromOpenApi(
  absolutePath: string,
): readonly { readonly method: string; readonly path: string }[] {
  const raw = readFileSync(absolutePath, 'utf8');
  const doc = yaml.load(raw) as OpenApiPathList;
  const operations: { method: string; path: string }[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      if (method in (item as Record<string, unknown>)) {
        operations.push({ method: method.toUpperCase(), path });
      }
    }
  }
  return operations;
}

/**
 * Extract `/api/...` and `/v1/...` paths from MDX headings. Headings are
 * the canonical "this is an endpoint" signal in the upstream Ollama docs —
 * both the OpenAI-compat and Anthropic-compat MDX use `## /v1/...` style
 * headings to enumerate their compatibility surface.
 */
function discoverFromMdx(absolutePath: string): readonly string[] {
  const raw = readFileSync(absolutePath, 'utf8');
  const headingPattern = /^#{1,6}\s+(.+?)\s*$/gm;
  const endpoints = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(raw)) !== null) {
    const heading = match[1];
    if (heading === undefined) continue;
    const path = extractPath(heading);
    if (path) endpoints.add(path);
  }
  // Also catch inline occurrences like `POST /v1/messages` in code fences,
  // which the OpenAI compat MDX uses for the Anthropic surface.
  const inlinePattern = /(?:^|\s)(\/(?:api|v1)\/[A-Za-z0-9_\-/{}]+)(?:\s|$)/g;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlinePattern.exec(raw)) !== null) {
    const candidate = inlineMatch[1];
    if (candidate) endpoints.add(candidate);
  }
  return [...endpoints];
}

function extractPath(heading: string): string | undefined {
  const pattern = /(\/(?:api|v1)\/[A-Za-z0-9_\-/{}]+)/;
  const match = pattern.exec(heading);
  return match?.[1];
}

function discoverFromDocumentedEndpoints(absolutePath: string): readonly string[] {
  const raw = readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw) as { endpoints: readonly { path: string }[] };
  return parsed.endpoints.map((entry) => entry.path);
}

/** Discover every endpoint path across every known docs source. */
export function discoverEndpoints(
  projectRoot: string,
  sources: readonly DocsSource[] = DOCS_SOURCES,
): DiscoveredEndpoints {
  const all = new Set<string>();
  const bySource: Record<string, readonly string[]> = {};
  const allOperations: { method: string; path: string }[] = [];

  for (const source of sources) {
    const absolute = resolve(projectRoot, source.path);
    let discovered: readonly string[];
    if (source.format === 'openapi-yaml') {
      discovered = discoverFromOpenApi(absolute);
      // Wave 15: also collect operation-level (method, path) pairs from
      // the OpenAPI source. Path-only sources (MDX, JSON) don't carry
      // method information, so only OpenAPI contributes operations.
      allOperations.push(...discoverOperationsFromOpenApi(absolute));
    } else if (source.format === 'documented-endpoints-json') {
      discovered = discoverFromDocumentedEndpoints(absolute);
    } else {
      discovered = discoverFromMdx(absolute);
    }
    bySource[source.id] = discovered;
    for (const endpoint of discovered) all.add(endpoint);
  }

  return {
    endpoints: [...all].sort(),
    bySource,
    operations: allOperations,
  };
}

/** Convenience: re-use the OpenAPI parser to expose just the operations list. */
export function openApiOperations(projectRoot: string): ReturnType<typeof parseOpenApi> {
  return parseOpenApi(resolve(projectRoot, 'contracts/sources/ollama.openapi.yaml'));
}
