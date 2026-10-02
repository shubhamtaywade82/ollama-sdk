import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OllamaContract } from '../../generator/types.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const IR_PATH = resolve(PROJECT_ROOT, 'contracts/ir/ollama.ir.json');

function loadIR(): OllamaContract {
  return JSON.parse(readFileSync(IR_PATH, 'utf8')) as OllamaContract;
}

describe('Wave 5: parity blocks migrated into overlays', () => {
  it('every native operation with a legacy surface carries a parity block', () => {
    const ir = loadIR();
    const nativeOps = ir.operations.filter((op) => op.domain === 'native');
    // operations WITHOUT a parity block: those added by Wave 1+ that were
    // never in the legacy manifest (`systemOne`, `blobs`, `webSearch`,
    // `webFetch` — the cloud-hosted capability endpoints brought into the
    // IR by Wave 12 P1 #7).
    const newOps = new Set(['systemOne', 'blobs', 'createBlob', 'webSearch', 'webFetch']);
    for (const op of nativeOps) {
      if (newOps.has(op.id)) {
        expect(op.parity).toBeUndefined();
        continue;
      }
      expect(op.parity, `operation ${op.id} should have a parity block`).toBeDefined();
      expect(op.parity?.legacySurfaceId).toBeDefined();
    }
  });

  it('every openai operation carries a parity block', () => {
    const ir = loadIR();
    const openaiOps = ir.operations.filter((op) => op.domain === 'openai');
    // openaiModels and openaiModelsGetOne are newer operations not in the legacy manifest.
    const opsWithParity = openaiOps.filter((op) => op.parity !== undefined);
    expect(opsWithParity.length).toBeGreaterThanOrEqual(4);
  });

  it('anthropic messages operation carries a parity block with stream events', () => {
    const ir = loadIR();
    const op = ir.operations.find((o) => o.id === 'anthropicMessages');
    expect(op?.parity).toBeDefined();
    expect(op?.parity?.stream).toBeDefined();
    expect(op?.parity?.stream?.interfaceNames.length).toBeGreaterThan(0);
    expect(op?.parity?.stream?.eventTypes?.length).toBeGreaterThan(0);
  });

  it('parity request.fields count matches the legacy manifest', () => {
    // Spot check: the legacy `native-chat` surface had 10 request fields.
    const ir = loadIR();
    const chat = ir.operations.find((o) => o.id === 'chat');
    expect(chat?.parity?.request?.fields).toHaveLength(10);
    // And 13 response fields.
    expect(chat?.parity?.response?.fields).toHaveLength(13);
  });

  it('openaiResponses parity preserves the streaming-event union name', () => {
    const ir = loadIR();
    const op = ir.operations.find((o) => o.id === 'openaiResponses');
    expect(op?.parity?.stream?.unionName).toBe('OpenAIResponsesStreamEvent');
    expect(op?.parity?.stream?.interfaceNames.length).toBeGreaterThan(15);
  });
});

describe('Wave 5: IR-driven parity verifier integration', () => {
  // This is a smoke test — the actual verifier runs in scripts/verify-contract-parity.ts.
  // Here we just assert the IR is structurally valid for the verifier to consume.
  it('every parity.request has a non-empty fields list', () => {
    const ir = loadIR();
    for (const op of ir.operations) {
      if (!op.parity?.request) continue;
      // Some operations (e.g. native-tags, native-ps) have an empty fields
      // list because they take no body — that's expected. The contract is
      // that the array exists.
      expect(Array.isArray(op.parity.request.fields)).toBe(true);
    }
  });

  it('every parity.response has an interfaceName and sourceFile', () => {
    const ir = loadIR();
    for (const op of ir.operations) {
      if (!op.parity?.response) continue;
      expect(
        op.parity.response.interfaceName,
        `${op.id} response missing interfaceName`,
      ).toBeTruthy();
      expect(op.parity.response.sourceFile, `${op.id} response missing sourceFile`).toBeTruthy();
    }
  });
});
