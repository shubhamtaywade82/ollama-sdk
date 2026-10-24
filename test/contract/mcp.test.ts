import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { emitMcpTools, buildToolDescriptors } from '../../generator/emitters/mcp/tools.js';
import type { OllamaContract } from '../../generator/types.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const IR_PATH = resolve(PROJECT_ROOT, 'contracts/ir/ollama.ir.json');

function loadIR(): OllamaContract {
  return JSON.parse(readFileSync(IR_PATH, 'utf8')) as OllamaContract;
}

describe('Wave 6: MCP tool generation', () => {
  // The binary-transport exclusions — must mirror BINARY_TRANSPORT_MCP_EXCLUSIONS
  // in generator/emitters/mcp/tools.ts and BINARY_BODY_OPS in
  // generator/emitters/typescript/api.ts (ADR 0038 keeps the three in sync;
  // test/contract/generated.test.ts asserts the audio/createBlob pair).
  const BINARY_TRANSPORT_OPS = new Set(['createBlob', 'openaiAudioSpeech']);

  it('emits one tool per documented operation in the IR (excluding binary-transport ops)', () => {
    const ir = loadIR();
    const descriptors = buildToolDescriptors(ir.operations, ir.schemas);
    // Wave 17: createBlob requires a binary body (application/octet-stream)
    // that the JSON runtime cannot handle. v1.22.0 (ADR 0038):
    // openaiAudioSpeech streams a raw binary audio response that none of
    // the transport modes can deliver.
    const documentedOps = ir.operations.filter(
      (op) => op.status.documented && !BINARY_TRANSPORT_OPS.has(op.id),
    );
    expect(descriptors.length).toBe(documentedOps.length);
  });

  it('names every tool with the `ollama_` prefix', () => {
    const ir = loadIR();
    const descriptors = buildToolDescriptors(ir.operations, ir.schemas);
    for (const d of descriptors) {
      expect(d.name).toMatch(/^ollama_/);
    }
  });

  it('marks GET/HEAD operations as read-only and idempotent', () => {
    const ir = loadIR();
    const descriptors = buildToolDescriptors(ir.operations, ir.schemas);
    const versionTool = descriptors.find((d) => d.name === 'ollama_version');
    expect(versionTool?.annotations?.readOnlyHint).toBe(true);
    expect(versionTool?.annotations?.idempotentHint).toBe(true);
  });

  it('marks DELETE operations as destructive', () => {
    const ir = loadIR();
    const descriptors = buildToolDescriptors(ir.operations, ir.schemas);
    const deleteTool = descriptors.find((d) => d.name === 'ollama_delete');
    expect(deleteTool?.annotations?.destructiveHint).toBe(true);
  });

  it('derives inputSchema from the operation request schema', () => {
    const ir = loadIR();
    const descriptors = buildToolDescriptors(ir.operations, ir.schemas);
    const chat = descriptors.find((d) => d.name === 'ollama_chat');
    expect(chat?.inputSchema.type).toBe('object');
    expect(chat?.inputSchema.properties).toBeDefined();
    const props = chat?.inputSchema.properties as Record<string, unknown>;
    expect(props.model).toBeDefined();
    expect(props.messages).toBeDefined();
  });

  it('includes the operationId in `_operationId` for runtime lookup', () => {
    const ir = loadIR();
    const descriptors = buildToolDescriptors(ir.operations, ir.schemas);
    const chat = descriptors.find((d) => d.name === 'ollama_chat');
    expect(chat?._operationId).toBe('chat');
  });

  it('emits `tools.json` with a `_comment` header and the tools array', () => {
    const ir = loadIR();
    const file = emitMcpTools('src/generated/mcp', ir.operations, ir.schemas);
    const parsed = JSON.parse(file.content) as {
      _comment: string;
      tools: readonly { name: string }[];
    };
    expect(parsed._comment).toMatch(/AUTO-GENERATED/);
    // Wave 17: createBlob excluded (binary body); v1.21.0: openaiAudioSpeech
    // excluded (binary audio response) — see BINARY_TRANSPORT_OPS above.
    expect(parsed.tools.length).toBe(
      ir.operations.filter((op) => op.status.documented && !BINARY_TRANSPORT_OPS.has(op.id)).length,
    );
  });
});

describe('Wave 6: MCP tool descriptors are valid JSON Schema', () => {
  it('every inputSchema has a `type` field', () => {
    const ir = loadIR();
    const descriptors = buildToolDescriptors(ir.operations, ir.schemas);
    for (const d of descriptors) {
      expect(d.inputSchema.type, `${d.name} inputSchema missing type`).toBeDefined();
    }
  });

  it('every inputSchema is serializable (no functions, no $refs)', () => {
    const ir = loadIR();
    const descriptors = buildToolDescriptors(ir.operations, ir.schemas);
    for (const d of descriptors) {
      const json = JSON.stringify(d.inputSchema);
      expect(json).not.toContain('$ref');
      // Should be a non-empty JSON object.
      expect(json.length).toBeGreaterThan(10);
    }
  });
});
