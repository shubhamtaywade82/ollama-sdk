/**
 * Bidirectional endpoint discovery validator.
 *
 * This is the fix for the bug the contract-first architecture was designed
 * to eliminate: the legacy `verify-api-parity.ts` only verified
 * `manifest → docs` (every declared surface had to exist in the docs), but
 * never verified `docs → manifest`. So when Ollama added `/v1/systemone`
 * to its official docs, nothing failed — the new endpoint simply wasn't in
 * the parity manifest, and the verifier had no opinion about that.
 *
 * This validator asserts both directions:
 *
 *   1. Every endpoint declared in the IR must be discoverable in at least
 *      one docs source (catches stale manifest entries).
 *   2. Every endpoint discovered in the docs must be declared in the IR
 *      (catches newly-added-but-undeclared endpoints like `/v1/systemone`).
 *
 * Direction (2) is the one that previously allowed silent drift.
 */
import type { EndpointDiscoveryReport, OperationContract } from '../types.js';
import { discoverEndpoints, type DocsSource } from '../parser/docs.js';

/** Normalize an endpoint path for comparison (strip trailing slash, lowercase). */
function normalizeEndpoint(path: string): string {
  const trimmed = path.replace(/\/$/, '');
  return trimmed.toLowerCase();
}

/**
 * Run the bidirectional discovery check.
 *
 * @param projectRoot absolute path to the repo root
 * @param operations declared operations from the canonical IR
 * @param sources optional override of the docs sources to scan
 */
export function validateEndpointDiscovery(
  projectRoot: string,
  operations: readonly OperationContract[],
  sources?: readonly DocsSource[],
): EndpointDiscoveryReport {
  const discovery = discoverEndpoints(projectRoot, sources);
  const discovered = new Set(discovery.endpoints.map(normalizeEndpoint));

  const declared = operations.map((op) => normalizeEndpoint(op.path));

  // Direction 1: every declared operation must be discoverable, OR explicitly
  // declared as not-yet-documented (status.documented === false). The latter
  // covers SDK-only operations like `systemOne` that are documented by Ollama
  // but not yet present in the pinned OpenAPI snapshot.
  const missingDeclared = operations
    .filter((op) => {
      if (op.status.documented === false) return false;
      return !discovered.has(normalizeEndpoint(op.path));
    })
    .map((op) => op.path);

  // Direction 2: every discovered endpoint must be declared. This is the
  // critical inverse check that catches newly documented endpoints.
  const declaredSet = new Set(declared);
  const undeclaredDiscovered = discovery.endpoints.filter(
    (endpoint) => !declaredSet.has(normalizeEndpoint(endpoint)),
  );

  // Wave 15: Direction 3 — operation-level (method, path) check. Every
  // (method, path) pair discovered in the OpenAPI source must be declared
  // in the IR. This catches missing HTTP methods on already-declared
  // paths (e.g. if the IR has HEAD /api/blobs/{digest} but the OpenAPI
  // also declares POST /api/blobs/{digest} which the IR doesn't carry).
  const declaredOps = new Set(
    operations.map((op) => `${op.method.toUpperCase()} ${normalizeEndpoint(op.path)}`),
  );
  const missingOperations = discovery.operations
    .filter((op) => !declaredOps.has(`${op.method.toUpperCase()} ${normalizeEndpoint(op.path)}`))
    .map((op) => `${op.method} ${op.path}`);

  return {
    declared: operations.map((op) => op.path),
    discovered: discovery.endpoints,
    missingDeclared,
    undeclaredDiscovered,
    missingOperations,
  };
}

/** Throw with a useful diagnostic if the report contains any drift. */
export function assertNoDiscoveryDrift(report: EndpointDiscoveryReport): void {
  if (
    report.missingDeclared.length === 0 &&
    report.undeclaredDiscovered.length === 0 &&
    report.missingOperations.length === 0
  ) {
    return;
  }
  const lines: string[] = [];
  if (report.missingDeclared.length > 0) {
    lines.push(
      `Declared operations missing from docs sources (${report.missingDeclared.length}):`,
      ...report.missingDeclared.map((p) => `  - ${p}`),
    );
  }
  if (report.undeclaredDiscovered.length > 0) {
    lines.push(
      `Discovered endpoints missing from contract IR (${report.undeclaredDiscovered.length}):`,
      ...report.undeclaredDiscovered.map((p) => `  - ${p}`),
      '',
      'These endpoints are documented by Ollama but not declared in any overlay.',
      'Add them to contracts/overlays/*.yaml before merging — this is the',
      '/v1/systemone-class bug the contract-first architecture is designed to catch.',
    );
  }
  if (report.missingOperations.length > 0) {
    lines.push(
      `Discovered operations missing from contract IR (${report.missingOperations.length}):`,
      ...report.missingOperations.map((p) => `  - ${p}`),
      '',
      'These (method, path) pairs are in the OpenAPI source but not in the IR.',
      'A path may be declared but a specific HTTP method on it is missing.',
      'Add the missing operations to contracts/overlays/*.yaml.',
    );
  }
  throw new Error(lines.join('\n'));
}
