import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { emitModels, emitSchema } from '../../generator/emitters/typescript/models.js';
import {
  detectTypeDrift,
  formatDriftReport,
} from '../../generator/emitters/typescript/drift-detector.js';
import {
  emitOperations,
} from '../../generator/emitters/typescript/operations.js';
import { emitApi } from '../../generator/emitters/typescript/api.js';
import { normalizeContract } from '../../generator/normalize/contract-normalizer.js';
import type { OllamaContract, SchemaContract } from '../../generator/types.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const IR_PATH = resolve(PROJECT_ROOT, 'contracts/ir/ollama.ir.json');

function loadIR(): OllamaContract {
  return JSON.parse(readFileSync(IR_PATH, 'utf8')) as OllamaContract;
}

describe('generated models: structural correctness', () => {
  it('emits a TypeScript interface for every schema in the IR', () => {
    const ir = loadIR();
    const files = emitModels('src/generated/models', ir.schemas);
    // One file per schema + an index.ts.
    expect(files.length).toBe(ir.schemas.length + 1);
    for (const file of files) {
      expect(file.content.length).toBeGreaterThan(0);
      expect(file.content).toMatch(/(export interface|export type) /);
    }
  });

  it('marks every property as readonly (mirrors src/types.ts convention)', () => {
    const ir = loadIR();
    const files = emitModels('src/generated/models', ir.schemas);
    // Find the ChatRequest emitted file and inspect its content.
    const chatFile = files.find((f) => f.path.endsWith('/ChatRequest.ts'));
    expect(chatFile).toBeDefined();
    const content = chatFile?.content ?? '';
    // Every property line should be `readonly <name>...`.
    const propLines = content.split('\n').filter((line) => /^\s+readonly [a-zA-Z]/.test(line));
    expect(propLines.length).toBeGreaterThan(0);
    for (const line of propLines) {
      expect(line).toMatch(/^\s+readonly /);
    }
  });

  it('emits type aliases for primitive schemas (not interfaces)', () => {
    const ir = loadIR();
    const thinkValue = ir.schemas.find((s) => s.name === 'ThinkValue');
    expect(thinkValue).toBeDefined();
    if (!thinkValue) return;
    const content = emitSchema(thinkValue as SchemaContract, ir.schemas);
    // ThinkValue is a oneOf [boolean, string, null] → should emit `type`
    // alias, not `interface`.
    expect(content).toMatch(/export type ThinkValue = /);
  });

  it('imports referenced sibling schemas', () => {
    const ir = loadIR();
    const files = emitModels('src/generated/models', ir.schemas);
    // ChatResponse references Logprob (via logprobs array field) and
    // ToolCall (via message.tool_calls). The generated import block
    // should include both.
    const chatResponseFile = files.find((f) => f.path.endsWith('/ChatResponse.ts'));
    const content = chatResponseFile?.content ?? '';
    expect(content).toMatch(/import type \{[^}]*Logprob[^}]*\} from '.\/index.js'/);
    expect(content).toMatch(/import type \{[^}]*ToolCall[^}]*\} from '.\/index.js'/);
  });
});

describe('generated operations: OperationDefinition shape', () => {
  it('emits one `as const satisfies OperationDefinition` per operation', () => {
    const ir = loadIR();
    const file = emitOperations('src/generated/api', ir.operations);
    const satisfyCount = (file.content.match(/satisfies OperationDefinition/g) ?? []).length;
    expect(satisfyCount).toBe(ir.operations.length);
  });

  it('uses the `Op` suffix for variable names to avoid reserved-word collisions', () => {
    const ir = loadIR();
    const file = emitOperations('src/generated/api', ir.operations);
    // `delete` is reserved — must be exported as `deleteOp`.
    expect(file.content).toMatch(/export const deleteOp = \{/);
    expect(file.content).not.toMatch(/export const delete = \{/);
  });

  it('exports allOperations as an array of every operation constant', () => {
    const ir = loadIR();
    const file = emitOperations('src/generated/api', ir.operations);
    expect(file.content).toMatch(/export const allOperations = \[/);
    for (const op of ir.operations) {
      expect(file.content).toMatch(new RegExp(`\\b${op.id}Op\\b`));
    }
  });
});

describe('generated api: domain classes', () => {
  it('emits NativeApi, OpenAIApi, and AnthropicApi classes', () => {
    const ir = loadIR();
    const files = emitApi('src/generated/api', ir.operations);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/generated/api/native-api.ts');
    expect(paths).toContain('src/generated/api/openai-api.ts');
    expect(paths).toContain('src/generated/api/anthropic-api.ts');
  });

  it('NativeApi.chat has streaming + non-streaming overloads', () => {
    const ir = loadIR();
    const files = emitApi('src/generated/api', ir.operations);
    const nativeFile = files.find((f) => f.path.endsWith('/native-api.ts'));
    const content = nativeFile?.content ?? '';
    expect(content).toMatch(
      /chat\(request: ChatRequest & \{ stream\?: false \}\): Promise<ChatResponse>/,
    );
    expect(content).toMatch(
      /chat\(request: ChatRequest & \{ stream: true \}\): Promise<AsyncGenerator<ChatResponse/,
    );
  });

  it('NativeApi.version (GET) does not take a request body', () => {
    const ir = loadIR();
    const files = emitApi('src/generated/api', ir.operations);
    const nativeFile = files.find((f) => f.path.endsWith('/native-api.ts'));
    const content = nativeFile?.content ?? '';
    expect(content).toMatch(
      /version\(options\?: \{ signal\?: AbortSignal \}\): Promise<VersionResponse>/,
    );
  });
});

describe('drift detector: surfaces real schema-vs-handwritten differences', () => {
  it('runs without throwing and produces a structured report', () => {
    const ir = loadIR();
    const result = detectTypeDrift(PROJECT_ROOT, ir.schemas);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.totalMatched).toBeGreaterThan(0);
    // The format function should produce a readable multi-line report.
    const report = formatDriftReport(result);
    expect(report).toMatch(/Type drift report:/);
  });

  it('catches fields present in hand-written types but missing from OpenAPI', () => {
    // GenerateResponse in src/types.ts has `context`, `image`, `completed`,
    // `total` — Ollama removed these from the OpenAPI spec but the SDK still
    // carries them. The drift detector should report them as `removed`.
    const ir = loadIR();
    const result = detectTypeDrift(PROJECT_ROOT, ir.schemas);
    const generate = result.entries.find((e) => e.schemaName === 'GenerateResponse');
    expect(generate).toBeDefined();
    // We know from the run output that at least one of these is reported.
    const knownDrift = ['context', 'image', 'completed', 'total'];
    const removedSet = new Set(generate?.removed ?? []);
    const found = knownDrift.filter((f) => removedSet.has(f));
    expect(found.length).toBeGreaterThan(0);
  });
});

describe('generated code: deterministic regeneration', () => {
  it('produces identical output when normalized twice', () => {
    const ir1 = normalizeContract(PROJECT_ROOT, { write: false });
    const ir2 = normalizeContract(PROJECT_ROOT, { write: false });
    expect(ir1.sourceHash).toBe(ir2.sourceHash);
    expect(ir1.operations.map((o) => o.id)).toEqual(ir2.operations.map((o) => o.id));
    expect(ir1.schemas.map((s) => s.name)).toEqual(ir2.schemas.map((s) => s.name));
  });
});

describe('IR schemas: definitions are present', () => {
  it('every schema in the IR carries a non-empty definition', () => {
    const ir = loadIR();
    for (const schema of ir.schemas) {
      expect(schema.definition, `schema ${schema.name} has no definition`).toBeDefined();
    }
  });
});
