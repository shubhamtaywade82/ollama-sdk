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

  return {
    declared: operations.map((op) => op.path),
    discovered: discovery.endpoints,
    missingDeclared,
    undeclaredDiscovered,
  };
}

/** Throw with a useful diagnostic if the report contains any drift. */
export function assertNoDiscoveryDrift(report: EndpointDiscoveryReport): void {
  if (report.missingDeclared.length === 0 && report.undeclaredDiscovered.length === 0) {
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
  throw new Error(lines.join('\n'));
}
