import { describe, expect, it } from 'vitest';
import { buildToolDescriptors } from '../../generator/emitters/mcp/tools.js';
import { normalizeContract } from '../../generator/normalize/contract-normalizer.js';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');

/**
 * Wave 12 (P1 #5): the MCP emitter previously used a universal
 * `{ prompt: string, additionalProperties: true }` fallback for every
 * operation without an OpenAPI request schema. This affected GET/HEAD
 * operations like /v1/models/{model}, /api/version, /api/ps, /api/tags,
 * /api/blobs/{digest} — operations that don't take a "prompt" at all.
 *
 * The new behavior derives the input schema from the path:
 *   - Path params become required string fields.
 *   - Parameterless GET/HEAD gets an empty object schema.
 *
 * The fabricated `prompt` field is gone everywhere.
 */
describe('Wave 12: MCP input schemas are structurally derived (no prompt fallback)', () => {
  const contract = normalizeContract(PROJECT_ROOT, { write: false });
  const descriptors = buildToolDescriptors(contract.operations, contract.schemas);
  const byOp = (id: string) => descriptors.find((d) => d._operationId === id);

  it('no inputSchema uses the fabricated `{ prompt: "Input for <op>" }` fallback', () => {
    // The previous fallback schema was:
    //   { type: 'object',
    //     properties: { prompt: { type: 'string', description: 'Input for <op>' } },
    //     additionalProperties: true }
    // After Wave 12, no tool should use that exact shape. Some real
    // operations (notably `generate`) DO have a `prompt` field on their
    // actual request schema — those are legitimate and not the fallback.
    for (const d of descriptors) {
      expect(d.inputSchema.type).toBe('object');
      const props = (d.inputSchema.properties ?? {}) as Record<string, unknown>;
      const promptProp = props.prompt as { description?: string } | undefined;
      if (promptProp) {
        // The fabricated fallback's description was exactly
        // `Input for <opId>`. Real schemas' descriptions come from the
        // OpenAPI/overlay spec and never match that exact string.
        expect(promptProp.description).not.toBe(`Input for ${d._operationId}`);
      }
    }
  });

  it('path-derived schemas set additionalProperties=false (no free-form fields)', () => {
    // Tools for operations WITHOUT a request body schema (GET/HEAD) now
    // use a path-derived schema. Those always set additionalProperties
    // to false — the previous fallback used true.
    const pathDerivedOpIds = ['version', 'tags', 'ps', 'openaiModels', 'openaiModelsGetOne', 'blobs'];
    for (const id of pathDerivedOpIds) {
      const tool = byOp(id);
      expect(tool, `tool for ${id}`).toBeDefined();
      expect(tool?.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('GET /v1/models/{model} exposes a `model` path parameter', () => {
    const tool = byOp('openaiModelsGetOne');
    expect(tool).toBeDefined();
    const props = tool?.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('model');
    const modelProp = props.model as { type: string; description: string };
    expect(modelProp.type).toBe('string');
    expect(modelProp.description).toMatch(/path parameter/i);
    expect(tool?.inputSchema.required).toEqual(['model']);
    expect(tool?.inputSchema.additionalProperties).toBe(false);
  });

  it('HEAD /api/blobs/{digest} exposes a `digest` path parameter', () => {
    const tool = byOp('blobs');
    expect(tool).toBeDefined();
    const props = tool?.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('digest');
    expect(tool?.inputSchema.required).toEqual(['digest']);
  });

  it('GET /api/version, /api/tags, /api/ps all expose empty object schemas', () => {
    for (const id of ['version', 'tags', 'ps', 'openaiModels']) {
      const tool = byOp(id);
      expect(tool, `tool for ${id}`).toBeDefined();
      const props = tool?.inputSchema.properties as Record<string, unknown>;
      expect(Object.keys(props)).toEqual([]);
      expect(tool?.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('POST operations with a real request schema keep using it', () => {
    // chat, generate, embed, systemOne all have request schemas in the IR.
    // They should NOT fall back to the path-derived schema.
    const chat = byOp('chat');
    expect(chat).toBeDefined();
    const chatProps = chat?.inputSchema.properties as Record<string, unknown>;
    expect(chatProps).toHaveProperty('model');
    expect(chatProps).toHaveProperty('messages');

    const systemOne = byOp('systemOne');
    expect(systemOne).toBeDefined();
    const soProps = systemOne?.inputSchema.properties as Record<string, unknown>;
    expect(soProps).toHaveProperty('model');
    expect(soProps).toHaveProperty('questions');
  });
});
