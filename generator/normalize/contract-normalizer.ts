/**
 * Contract normalizer.
 *
 * Walks the inputs in this order:
 *
 *   1. `contracts/sources/ollama.openapi.yaml` — structural truth
 *      (paths, methods, request/response schema refs).
 *   2. `contracts/overlays/*.yaml` — behavioral truth (streaming,
 *      capabilities, env, version constraints).
 *
 * For each overlay operation, the normalizer:
 *   - If `openapi:` is set, finds the matching OpenAPI operation and inherits
 *     its method/path/schema refs.
 *   - If `path:` and `method:` are set explicitly (for operations like
 *     `/v1/systemone` that are documented but not in the OpenAPI spec),
 *     synthesizes a new operation from the overlay alone.
 *
 * Output: a single {@link OllamaContract} IR, written to
 * `contracts/ir/ollama.ir.json` (committed artifact).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import * as yaml from 'js-yaml';

import type {
  HttpMethod,
  OperationContract,
  OperationParameter,
  OllamaContract,
  SchemaContract,
  TransportMode,
} from '../types.js';
import {
  parseOpenApi,
  type ParsedOpenApi,
  type ParsedOpenApiOperation,
} from '../parser/openapi.js';
import type { OverlayDomain, OverlayOperation } from './overlay-schema.js';

const OVERLAY_DIR = 'contracts/overlays';
const SOURCES_OPENAPI = 'contracts/sources/ollama.openapi.yaml';
const IR_OUTPUT = 'contracts/ir/ollama.ir.json';
const LEGACY_PARITY = 'docs/api-parity.json';

interface OverlayFile {
  readonly name: string;
  readonly path: string;
  readonly domain: OverlayDomain;
}

function readOverlays(projectRoot: string): readonly OverlayFile[] {
  const dir = resolve(projectRoot, OVERLAY_DIR);
  const files = readdirSync(dir).filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'));
  return files.map((file) => {
    const path = join(dir, file);
    const raw = readFileSync(path, 'utf8');
    const domain = yaml.load(raw) as OverlayDomain;
    return { name: basename(file, '.yaml'), path, domain };
  });
}

function readLegacyParity(projectRoot: string): {
  readonly byEndpoint: Readonly<Record<string, string>>;
} {
  // Wave 7: the legacy docs/api-parity.json manifest has been retired.
  // The parity bridge is now derived entirely from the overlays' own
  // `parityBridge` blocks — this function is kept only for backwards
  // compatibility with any external consumer that still maintained a
  // legacy manifest; when no manifest exists, return an empty map.
  const path = resolve(projectRoot, LEGACY_PARITY);
  if (!existsSync(path)) {
    return { byEndpoint: {} };
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as {
    surfaces: readonly { endpoint: string; id: string }[];
  };
  const byEndpoint: Record<string, string> = {};
  for (const surface of parsed.surfaces) {
    byEndpoint[surface.endpoint] = surface.id;
  }
  return { byEndpoint };
}

function boolFromSupport(value: 'supported' | 'unsupported' | undefined): boolean {
  return value === 'supported';
}

function transportFromOverlay(
  op: OverlayOperation,
  fallbackMethod: HttpMethod,
): {
  mode: TransportMode;
  streaming: boolean;
  streamingDefault?: boolean;
} {
  const runtime = op.runtime;
  const streaming = runtime?.streaming === 'supported';
  const streamingDefault = runtime?.streamingDefault;
  const declaredTransport = runtime?.transport;
  const mode: TransportMode =
    declaredTransport ?? (streaming ? (fallbackMethod === 'POST' ? 'ndjson' : 'json') : 'json');
  return {
    mode,
    streaming,
    ...(streamingDefault !== undefined ? { streamingDefault } : {}),
  };
}

function lookupOpenApiOperation(
  structural: readonly ParsedOpenApiOperation[],
  overlay: OverlayOperation,
): ParsedOpenApiOperation | undefined {
  const target = overlay.openapi;
  if (!target) return undefined;
  return structural.find((op) => op.path === target);
}

/**
 * Wave 12 (P1 #8): auto-derive path parameters from a path template.
 *
 * Every `{name}` segment becomes a path parameter with type `string` and
 * `required: true`. This is the minimum structural information the IR
 * needs for path-templated operations like `/v1/models/{model}` and
 * `/api/blobs/{digest}` — previously the IR said "GET /v1/models/{model}"
 * but didn't expose the `model` parameter structurally, so generated
 * code couldn't tell what to substitute.
 */
function derivePathParameters(path: string): readonly OperationParameter[] {
  const matches = path.matchAll(/\{([^}]+)\}/g);
  const out: OperationParameter[] = [];
  for (const m of matches) {
    if (!m[1]) continue;
    out.push({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    });
  }
  return out;
}

function buildOperationContract(
  overlayKey: string,
  overlay: OverlayOperation,
  parentDomain: 'native' | 'openai' | 'anthropic',
  structural: readonly ParsedOpenApiOperation[],
): OperationContract {
  const match = lookupOpenApiOperation(structural, overlay);
  const method: HttpMethod = overlay.method ?? match?.method ?? 'POST';
  const path = overlay.path ?? match?.path ?? overlay.openapi ?? '';
  if (!path) {
    throw new Error(
      `Overlay operation "${overlayKey}" declares neither \`openapi:\` nor \`path:\`; cannot resolve its HTTP path`,
    );
  }
  const domain = overlay.domain ?? parentDomain;

  // Wave 12 (P0 #4): overlay-declared schema names win over OpenAPI refs.
  // This lets operations like /v1/systemone — which are absent from the
  // pinned OpenAPI snapshot — point at schemas declared in the overlay's
  // `schemas:` block. When neither overlay nor OpenAPI supplies a ref,
  // the operation remains untyped (the generated API uses Record<string,
  // unknown> as before).
  const requestRef = overlay.requestSchema
    ? { $ref: `#/schemas/${overlay.requestSchema}` }
    : match?.requestBodyRef
      ? { $ref: `#/schemas/${match.requestBodyRef}` }
      : undefined;
  const responseRef = overlay.responseSchema
    ? { $ref: `#/schemas/${overlay.responseSchema}` }
    : match?.responseRef
      ? { $ref: `#/schemas/${match.responseRef}` }
      : undefined;

  const env = overlay.environment;
  const local = boolFromSupport(env?.local ?? 'supported');
  const cloud = boolFromSupport(env?.cloud ?? 'supported');

  const transport = transportFromOverlay(overlay, method);

  const caps = overlay.capabilities;
  const capabilities: OperationContract['capabilities'] = {
    ...(caps?.thinking !== undefined ? { thinking: caps.thinking } : {}),
    ...(caps?.tools !== undefined ? { tools: caps.tools } : {}),
    ...(caps?.vision !== undefined ? { vision: caps.vision } : {}),
    ...(caps?.structuredOutput !== undefined ? { structuredOutput: caps.structuredOutput } : {}),
    ...(caps?.logprobs !== undefined ? { logprobs: caps.logprobs } : {}),
    ...(caps?.embeddings !== undefined ? { embeddings: caps.embeddings } : {}),
  };

  const compat = overlay.compatibility;
  const limits = overlay.limits;
  const constraints: OperationContract['constraints'] | undefined =
    compat || limits
      ? {
          ...(compat?.minVersion !== undefined ? { minOllamaVersion: compat.minVersion } : {}),
          ...(limits?.maxRequestBytes !== undefined
            ? { maxRequestBytes: limits.maxRequestBytes }
            : {}),
        }
      : undefined;

  const statusOverlay = overlay.status;
  // Default documented=true when EITHER the OpenAPI spec declares the
  // operation OR the overlay declares an explicit `path:` (which means the
  // operation is documented in another source — typically the OpenAI /
  // Anthropic compatibility MDX files — even though it's absent from the
  // pinned OpenAPI snapshot).
  const documented =
    statusOverlay?.documented ?? (match !== undefined || overlay.path !== undefined);
  const status: OperationContract['status'] = {
    documented,
    ...(statusOverlay?.deprecated !== undefined ? { deprecated: statusOverlay.deprecated } : {}),
    ...(statusOverlay?.experimental !== undefined
      ? { experimental: statusOverlay.experimental }
      : {}),
  };

  return {
    id: overlay.id ?? overlayKey,
    method,
    path,
    ...(requestRef ? { request: requestRef } : {}),
    ...(responseRef ? { response: responseRef } : {}),
    environment: { local, cloud },
    transport,
    capabilities,
    ...(constraints ? { constraints } : {}),
    status,
    domain,
    ...(overlay.host ? { host: overlay.host } : {}),
    // Wave 12 (P1 #8): always derive path parameters from the path
    // template. Operations without `{...}` segments get an empty array
    // (omitted from the IR for compactness).
    ...(derivePathParameters(path).length > 0
      ? { parameters: derivePathParameters(path) }
      : {}),
    ...(overlay.notes && overlay.notes.length > 0 ? { notes: overlay.notes } : {}),
    ...(overlay.parity ? { parity: normalizeParity(overlay.parity) } : {}),
  };
}

/** Convert an overlay's OperationParity into the IR's OperationParityContract. */
function normalizeParity(
  parity: import('./overlay-schema.js').OperationParity,
): import('../types.js').OperationParityContract {
  return {
    ...(parity.legacySurfaceId ? { legacySurfaceId: parity.legacySurfaceId } : {}),
    ...(parity.docsUrl ? { docsUrl: parity.docsUrl } : {}),
    ...(parity.fallbackDocsFile ? { fallbackDocsFile: parity.fallbackDocsFile } : {}),
    ...(parity.request ? { request: normalizeFieldParity(parity.request) } : {}),
    ...(parity.response ? { response: normalizeFieldParity(parity.response) } : {}),
    ...(parity.stream ? { stream: parity.stream } : {}),
  };
}

function normalizeFieldParity(
  fp: import('./overlay-schema.js').FieldParity,
): import('../types.js').FieldParityContract {
  return {
    fields: [...(fp.fields ?? [])],
    unsupportedFields: [...(fp.unsupportedFields ?? [])],
    sdkOnlyFields: [...(fp.sdkOnlyFields ?? [])],
    nestedUnsupportedFields: [...(fp.nestedUnsupportedFields ?? [])],
    docAliases: { ...(fp.docAliases ?? {}) },
    featureAliases: { ...(fp.featureAliases ?? {}) },
    ...(fp.interfaceName ? { interfaceName: fp.interfaceName } : {}),
    ...(fp.sourceFile ? { sourceFile: fp.sourceFile } : {}),
  };
}

function buildSchemas(
  structural: readonly ParsedOpenApi[],
  overlays: readonly OverlayFile[],
): readonly SchemaContract[] {
  const byName = new Map<string, SchemaContract>();
  // First: OpenAPI-sourced schemas (structural truth for everything the
  // pinned snapshot actually models).
  for (const spec of structural) {
    for (const parsed of spec.schemas) {
      const existing = byName.get(parsed.name);
      if (existing) continue;
      byName.set(parsed.name, {
        name: parsed.name,
        source: { openapi: `#/components/schemas/${parsed.name}` },
        ...(parsed.schema.description ? { description: parsed.schema.description } : {}),
        definition: parsed.schema,
      });
    }
  }
  // Wave 12 (P0 #4): then merge in overlay-declared inline schemas. These
  // cover operations the OpenAPI snapshot doesn't model (e.g. System One).
  // Overlay schemas take precedence over OpenAPI when names collide — the
  // overlay is the authoritative behavioral source when present.
  for (const file of overlays) {
    const inline = file.domain.schemas;
    if (!inline) continue;
    for (const [name, definition] of Object.entries(inline)) {
      byName.set(name, {
        name,
        source: { overlay: file.name },
        ...(definition.description ? { description: definition.description } : {}),
        definition,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function buildParityBridge(
  operations: readonly OperationContract[],
  legacyByEndpoint: Readonly<Record<string, string>>,
  overlayBridges: ReadonlyArray<Readonly<Record<string, string>>>,
): {
  readonly legacySurfaceId: string;
  readonly operationId: string;
  readonly legacyEndpoint: string;
}[] {
  // Build a map of operationId -> legacySurfaceId from overlay parityBridge
  // blocks. Each overlay file declares `parityBridge: { <legacyId>: <opId> }`.
  const opIdToLegacy = new Map<string, string>();
  for (const bridge of overlayBridges) {
    for (const [legacyId, opId] of Object.entries(bridge)) {
      opIdToLegacy.set(opId, legacyId);
    }
  }
  const opIdToEndpoint = new Map(operations.map((op) => [op.id, op.path]));

  const bridge: { legacySurfaceId: string; operationId: string; legacyEndpoint: string }[] = [];
  // First: overlay-declared bridges (the canonical Wave 7+ source).
  for (const [opId, legacyId] of opIdToLegacy) {
    const endpoint = opIdToEndpoint.get(opId);
    if (endpoint) {
      bridge.push({ operationId: opId, legacySurfaceId: legacyId, legacyEndpoint: endpoint });
    }
  }
  // Then: any remaining operations whose endpoint matches a legacy
  // manifest entry (kept for backwards compatibility with consumers that
  // still maintain a legacy manifest; usually a no-op now).
  const seenOp = new Set(bridge.map((b) => b.operationId));
  for (const op of operations) {
    if (seenOp.has(op.id)) continue;
    const legacySurfaceId = legacyByEndpoint[op.path];
    if (legacySurfaceId) {
      bridge.push({ operationId: op.id, legacySurfaceId, legacyEndpoint: op.path });
    }
  }
  return bridge;
}

function sourceHash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Compile sources + overlays → canonical IR.
 *
 * @param projectRoot absolute path to the ollama-sdk repo root
 * @param options.write when `true` (default), writes the IR to {@link IR_OUTPUT};
 *   pass `false` for dry-run validations
 */
export function normalizeContract(
  projectRoot: string,
  options: { write?: boolean } = {},
): OllamaContract {
  const write = options.write ?? true;

  const openapiPath = resolve(projectRoot, SOURCES_OPENAPI);
  const parsed = parseOpenApi(openapiPath);
  const overlays = readOverlays(projectRoot);
  const legacy = readLegacyParity(projectRoot);

  const operations: OperationContract[] = [];
  const overlayContents: string[] = [];

  for (const file of overlays) {
    overlayContents.push(readFileSync(file.path, 'utf8'));
    const parentDomain = file.domain.domain ?? 'native';
    for (const [key, overlay] of Object.entries(file.domain.operations)) {
      operations.push(buildOperationContract(key, overlay, parentDomain, parsed.operations));
    }
  }

  // Stable sort: native first, then openai, then anthropic; within each domain,
  // sort alphabetically by id. This makes the committed IR deterministic.
  const domainOrder: Record<string, number> = { native: 0, openai: 1, anthropic: 2 };
  operations.sort((a, b) => {
    const da = domainOrder[a.domain] ?? 99;
    const db = domainOrder[b.domain] ?? 99;
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });

  const schemas = buildSchemas([parsed], overlays);
  const overlayBridges = overlays.map((file) => file.domain.parityBridge ?? {});
  const parityBridge = buildParityBridge(operations, legacy.byEndpoint, overlayBridges);

  const contract: OllamaContract = {
    contractVersion: 1,
    // Wave 12 (P1): renamed from observedOllamaVersion. The OpenAPI
    // info.version is a source-tracking artifact, NOT the Ollama server
    // version. We emit both fields during the migration window so older
    // readers don't break; new readers should prefer sourceVersion.
    ...(parsed.info.version
      ? { sourceVersion: parsed.info.version, observedOllamaVersion: parsed.info.version }
      : {}),
    // Wave 12 (P1): generatedAt is intentionally OMITTED from the
    // committed IR. The field made the IR non-deterministic — re-running
    // `contract:normalize` produced a diff just because of the timestamp,
    // even when nothing else changed. The sourceHash field already
    // provides reproducibility. Build metadata (including generation
    // timestamp) belongs in CI artifacts, not the canonical contract.
    sourceHash: sourceHash([readFileSync(openapiPath, 'utf8'), ...overlayContents]),
    operations,
    schemas,
    parityBridge,
  };

  if (write) {
    const outPath = resolve(projectRoot, IR_OUTPUT);
    mkdirSync(resolve(projectRoot, 'contracts/ir'), { recursive: true });
    writeFileSync(outPath, JSON.stringify(contract, null, 2) + '\n', 'utf8');
  }

  return contract;
}
