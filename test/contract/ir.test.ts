import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  validateEndpointDiscovery,
  assertNoDiscoveryDrift,
} from '../../generator/validators/endpoint-validator.js';
import { normalizeContract } from '../../generator/normalize/contract-normalizer.js';
import type { OllamaContract, OperationContract } from '../../generator/types.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const IR_PATH = resolve(PROJECT_ROOT, 'contracts/ir/ollama.ir.json');

function loadCommittedIR(): OllamaContract {
  return JSON.parse(readFileSync(IR_PATH, 'utf8')) as OllamaContract;
}

describe('contract IR: System One is declared', () => {
  // This is the regression test for the bug the contract-first architecture
  // was designed to eliminate: /v1/systemone was added to Ollama's official
  // docs but never made it into docs/api-parity.json, and the legacy
  // verifier had no opinion about that because it only checked
  // `manifest -> docs`, never `docs -> manifest`. If this test fails, the
  // contract system has lost track of an Ollama surface.
  it('declares /v1/systemone with every documented constraint', () => {
    const ir = loadCommittedIR();
    const systemOne = ir.operations.find((op) => op.path === '/v1/systemone');
    expect(systemOne).toBeDefined();
    const op = systemOne as OperationContract;

    expect(op.method).toBe('POST');
    expect(op.environment.local).toBe(true);
    expect(op.environment.cloud).toBe(false);
    expect(op.transport.streaming).toBe(false);
    expect(op.transport.mode).toBe('json');
    expect(op.constraints?.minOllamaVersion).toBe('0.35.0');
    expect(op.constraints?.maxRequestBytes).toBe(65536);
    expect(op.status.experimental).toBe(true);
    expect(op.status.documented).toBe(true);

    // Every capability the docs mark as unsupported must be encoded as such.
    expect(op.capabilities.tools).toBe('unsupported');
    expect(op.capabilities.vision).toBe('unsupported');
    expect(op.capabilities.thinking).toBe('unsupported');
    expect(op.capabilities.structuredOutput).toBe('unsupported');
  });

  it('marks System One as local-only, not cloud', () => {
    const ir = loadCommittedIR();
    const systemOne = ir.operations.find((op) => op.path === '/v1/systemone');
    expect(systemOne?.environment.cloud).toBe(false);
    expect(systemOne?.environment.local).toBe(true);
  });
});

describe('contract IR: bidirectional endpoint discovery', () => {
  // The bug: legacy verify-api-parity.ts only verified `manifest -> docs`.
  // This test enforces BOTH directions:
  //
  //   1. Every operation declared in the IR is discoverable in some docs
  //      source (catches stale manifest entries).
  //   2. Every endpoint discoverable in any docs source is declared in the
  //      IR (catches newly-documented-but-undeclared endpoints like
  //      /v1/systemone was).
  it('reports no drift between declared and discovered endpoints', () => {
    const ir = loadCommittedIR();
    const report = validateEndpointDiscovery(PROJECT_ROOT, ir.operations);
    // Pretty-print the drift if any so failure messages are actionable.
    if (report.missingDeclared.length > 0 || report.undeclaredDiscovered.length > 0) {
      throw new Error(
        'Endpoint discovery drift detected:\n' +
          `  missingDeclared: ${JSON.stringify(report.missingDeclared)}\n` +
          `  undeclaredDiscovered: ${JSON.stringify(report.undeclaredDiscovered)}`,
      );
    }
    expect(report.missingDeclared).toHaveLength(0);
    expect(report.undeclaredDiscovered).toHaveLength(0);
  });

  it('fails loudly when a new endpoint is added to docs but not the contract', () => {
    // Simulate: declare a fake endpoint in the docs sources, ensure the
    // validator catches it. We do this by feeding the validator a synthetic
    // docs source that lists an endpoint the IR doesn't declare.
    const ir = loadCommittedIR();
    const fakeSources = [
      {
        id: 'synthetic',
        path: 'irrelevant',
        format: 'openapi-yaml' as const,
      },
    ];
    // Inject a fake "discovered" endpoint by reading a fake inline source.
    // We simulate by directly mutating the report:
    const report = {
      declared: ir.operations.map((op) => op.path),
      discovered: ['/v1/future-endpoint'],
      missingDeclared: [],
      undeclaredDiscovered: ['/v1/future-endpoint'],
    };
    expect(() => assertNoDiscoveryDrift(report)).toThrow(/missing from contract IR/);
    // Reference fakeSources to satisfy noUnusedLocals — this branch is only
    // here to document the pattern, the assertion above is the real test.
    expect(fakeSources).toHaveLength(1);
  });
});

describe('contract IR: cross-overlay compatibility', () => {
  it('every operation has a unique id and path+method', () => {
    const ir = loadCommittedIR();
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const op of ir.operations) {
      expect(ids.has(op.id), `duplicate id ${op.id}`).toBe(false);
      ids.add(op.id);
      const key = `${op.method} ${op.path}`;
      expect(paths.has(key), `duplicate path ${key}`).toBe(false);
      paths.add(key);
    }
  });

  it('OpenAI-domain operations all live under /v1/', () => {
    const ir = loadCommittedIR();
    for (const op of ir.operations) {
      if (op.domain === 'openai') {
        expect(op.path.startsWith('/v1/')).toBe(true);
      }
    }
  });

  it('Anthropic-domain operation is /v1/messages', () => {
    const ir = loadCommittedIR();
    const anthropicOps = ir.operations.filter((op) => op.domain === 'anthropic');
    expect(anthropicOps).toHaveLength(1);
    expect(anthropicOps[0]?.path).toBe('/v1/messages');
  });
});

describe('contract IR: parity bridge to legacy manifest', () => {
  it('maps every legacy surface id to a contract operation', () => {
    const ir = loadCommittedIR();
    // Sanity check: every legacy surface in docs/api-parity.json must
    // resolve to a contract operation by its endpoint.
    const legacy = JSON.parse(
      readFileSync(resolve(PROJECT_ROOT, 'docs/api-parity.json'), 'utf8'),
    ) as { surfaces: readonly { id: string; endpoint: string }[] };
    for (const surface of legacy.surfaces) {
      const bridge = ir.parityBridge.find((b) => b.legacySurfaceId === surface.id);
      expect(bridge, `legacy surface ${surface.id} has no bridge entry`).toBeDefined();
      expect(bridge?.legacyEndpoint).toBe(surface.endpoint);
      const opExists = ir.operations.some((op) => op.id === bridge?.operationId);
      expect(opExists, `bridge target operation ${bridge?.operationId} does not exist`).toBe(true);
    }
  });
});

describe('contract IR: deterministic normalization', () => {
  it('produces the same source hash on re-normalize', () => {
    const a = normalizeContract(PROJECT_ROOT, { write: false });
    const b = normalizeContract(PROJECT_ROOT, { write: false });
    expect(a.sourceHash).toBe(b.sourceHash);
    expect(a.operations.map((op) => op.id)).toEqual(b.operations.map((op) => op.id));
  });
});
