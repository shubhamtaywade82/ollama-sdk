import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OllamaContract } from '../../generator/types.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const IR_PATH = resolve(PROJECT_ROOT, 'contracts/ir/ollama.ir.json');

function loadIR(): OllamaContract {
  return JSON.parse(readFileSync(IR_PATH, 'utf8')) as OllamaContract;
}

/**
 * Wave 12 (P1 #8): the canonical IR must carry structural parameter
 * information for path-templated operations. Before this wave the IR
 * said "GET /v1/models/{model}" but didn't expose the `model` parameter
 * structurally — generated code couldn't tell what to substitute, and
 * the MCP emitter had to re-parse the path template itself.
 *
 * The normalizer now auto-derives path parameters from `{name}` segments
 * and attaches them to the operation as `parameters: [{ name, in: 'path',
 * required: true, schema: { type: 'string' } }]`.
 */
describe('Wave 12: IR carries structural path parameters', () => {
  it('/v1/models/{model} exposes a `model` path parameter', () => {
    const ir = loadIR();
    const op = ir.operations.find((o) => o.id === 'openaiModelsGetOne');
    expect(op).toBeDefined();
    expect(op?.parameters).toBeDefined();
    expect(op?.parameters?.length).toBe(1);
    const param = op?.parameters?.[0];
    expect(param?.name).toBe('model');
    expect(param?.in).toBe('path');
    expect(param?.required).toBe(true);
    expect(param?.schema?.type).toBe('string');
  });

  it('/api/blobs/{digest} exposes a `digest` path parameter', () => {
    const ir = loadIR();
    const op = ir.operations.find((o) => o.id === 'blobs');
    expect(op).toBeDefined();
    const param = op?.parameters?.[0];
    expect(param?.name).toBe('digest');
    expect(param?.in).toBe('path');
    expect(param?.required).toBe(true);
  });

  it('operations without path templates have no parameters field', () => {
    // Operations like /api/chat, /api/version, /v1/systemone don't have
    // `{...}` segments — the normalizer omits the parameters field for
    // them (rather than emitting an empty array) to keep the IR compact.
    const ir = loadIR();
    const op = ir.operations.find((o) => o.id === 'chat');
    expect(op?.parameters).toBeUndefined();
    const version = ir.operations.find((o) => o.id === 'version');
    expect(version?.parameters).toBeUndefined();
  });

  it('every path parameter is required and typed as string', () => {
    // Path parameters in REST APIs are always required (you can't omit
    // a path segment) and Ollama's path parameters are all string-typed
    // (model names, blob digests). This invariant pins the auto-derivation
    // logic so a future change that emits optional or non-string path
    // params fails loud.
    const ir = loadIR();
    for (const op of ir.operations) {
      if (!op.parameters) continue;
      for (const p of op.parameters) {
        expect(p.in).toBe('path');
        expect(p.required).toBe(true);
        expect(p.schema?.type).toBe('string');
      }
    }
  });
});
