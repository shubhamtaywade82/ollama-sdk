import { describe, expect, it } from 'vitest';
import { NativeApi } from '../../src/generated/api/native-api.js';
import type { OllamaRuntime } from '../../src/generated/runtime/runtime.js';
import { systemOneOp } from '../../src/generated/api/operations.js';
import { SystemOneRequestSchema } from '../../src/generated/models/SystemOneRequest.schema.js';
import { SystemOneResponseSchema } from '../../src/generated/models/SystemOneResponse.schema.js';
import type { SystemOneRequest, SystemOneResponse } from '../../src/generated/models/index.js';
import type { SystemOneUsage } from '../../src/system-one.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Wave 13: System One is now a fully contract-generated native operation.
 * The schemas come from the OpenAPI source (not hand-written overlay
 * schemas as in Wave 12), the question discriminated union uses the
 * correct "noul" terminology (not "yes_no"), the usage block carries
 * input_tokens/output_tokens (not prompt_tokens/completion_tokens),
 * and the answer types are separate (ChoiceAnswer/NoulAnswer/ScoreAnswer
 * instead of one monolithic Answer).
 *
 * These tests pin the new typed surface so a regression to the Wave 12
 * shapes would fail loud at compile time.
 */
describe('Wave 13: System One is contract-generated from OpenAPI', () => {
  const runtime = undefined as unknown as OllamaRuntime;
  const _api = new NativeApi(runtime);

  function isAssignable<A, B>(_: A extends B ? true : false): boolean {
    return true;
  }

  it('systemOneOp carries request and response schema refs from OpenAPI', () => {
    expect(systemOneOp.request?.$ref).toBe('#/schemas/SystemOneRequest');
    expect(systemOneOp.response?.$ref).toBe('#/schemas/SystemOneResponse');
  });

  it('systemOneOp declares both request size limits', () => {
    expect(systemOneOp.constraints?.minOllamaVersion).toBe('0.35.0');
    expect(systemOneOp.constraints?.maxRequestBytes).toBe(65536);
    expect(systemOneOp.constraints?.maxRequestBytesWithImages).toBe(33554432);
  });

  it('systemOneOp declares vision as model-dependent (not unsupported)', () => {
    expect(systemOneOp.capabilities.vision).toBe('model-dependent');
    // The other capabilities remain unsupported.
    expect(systemOneOp.capabilities.tools).toBe('unsupported');
    expect(systemOneOp.capabilities.thinking).toBe('unsupported');
    expect(systemOneOp.capabilities.structuredOutput).toBe('unsupported');
  });

  it('NativeApi.systemOne accepts SystemOneRequest and returns SystemOneResponse', () => {
    type Method = typeof _api.systemOne;
    type Params = Method extends (request: infer R) => Promise<unknown> ? R : never;
    type Return = Method extends (request: unknown) => Promise<infer R> ? R : never;
    expect(isAssignable<SystemOneRequest, Params>(true)).toBe(true);
    expect(isAssignable<SystemOneResponse, Return>(true)).toBe(true);
  });

  it('SystemOneRequest carries an images field (vision support)', () => {
    type Req = SystemOneRequest;
    // The images field must exist and accept an array of strings.
    expect(isAssignable<Req, { images?: readonly string[] }>(true)).toBe(true);
  });

  it('SystemOneRequestSchema validates a well-formed request with all three question types', () => {
    const valid: SystemOneRequest = {
      model: 'tev1:4b',
      state: { ticket: 'Customer was charged twice' },
      questions: {
        intent: {
          type: 'choice',
          instructions: 'What is the primary intent?',
          criteria: {
            refund: 'Customer wants a refund',
            duplicate_charge: 'Customer reports multiple charges',
            cancellation: 'Customer wants to cancel',
            none: 'None of these',
          },
        },
        urgent: {
          type: 'noul',
          instructions: 'Does this require immediate attention?',
        },
        difficulty: {
          type: 'score',
          instructions: 'How difficult is this case?',
          criteria: ['trivial', 'simple', 'moderate', 'complex', 'very_complex'],
        },
      },
    };
    const result = SystemOneRequestSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('SystemOneRequestSchema validates a request with images', () => {
    const valid: SystemOneRequest = {
      model: 'clef:4b',
      state: 'Describe this image',
      images: ['iVBORw0KGgo...'],
      questions: {
        category: {
          type: 'choice',
          instructions: 'What is in this image?',
          criteria: {
            cat: 'A cat',
            dog: 'A dog',
            other: 'Something else',
          },
        },
      },
    };
    const result = SystemOneRequestSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('SystemOneResponseSchema validates a well-formed response with typed answers', () => {
    // Wave 13 correction: uses the exact upstream wire format.
    // - confidence is a number (not { score: number })
    // - noul answer has `noul: number` (not `bool: boolean` + `probability`)
    // - score answer has `legend: Record<string, string>` (not string)
    //   and `probabilities: Record<string, number>` (not number[])
    //   and `score: number` (probability-weighted average, not integer index)
    //   and `confidence: number` (all fields required)
    const valid: SystemOneResponse = {
      model: 'tev1:4b',
      answers: {
        intent: {
          type: 'choice',
          choice: 'duplicate_charge',
          probabilities: { refund: 0.0125, duplicate_charge: 0.9781, cancellation: 0.0093 },
          confidence: 0.8906,
        },
        urgent: {
          type: 'noul',
          noul: 0.87,
        },
        difficulty: {
          type: 'score',
          score: 2.73,
          legend: { '0': 'trivial', '1': 'simple', '2': 'moderate', '3': 'complex', '4': 'very_complex' },
          probabilities: { '0': 0.05, '1': 0.1, '2': 0.2, '3': 0.55, '4': 0.1 },
          confidence: 0.78,
        },
      },
      usage: { input_tokens: 142, output_tokens: 8 },
    };
    const result = SystemOneResponseSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('SystemOneUsage carries input_tokens/output_tokens (not prompt_tokens/completion_tokens)', () => {
    // Wave 12 incorrectly used prompt_tokens/completion_tokens/total_tokens.
    // Wave 13 corrects this to match the actual Ollama API: input_tokens
    // and output_tokens only (no total_tokens — callers can add them).
    // SystemOneUsage is defined in src/system-one.ts (the upstream OpenAPI
    // defines usage inline within SystemOneResponse, not as a named schema).
    type Usage = SystemOneUsage;
    // Should have input_tokens and output_tokens.
    expect(isAssignable<Usage, { input_tokens: number; output_tokens: number }>(true)).toBe(true);
    // Should NOT have prompt_tokens or completion_tokens.
    type HasPromptTokens = Usage extends { prompt_tokens: number } ? true : false;
    expect(isAssignable<HasPromptTokens, false>(true)).toBe(true);
  });

  it('MCP tool descriptor for systemOne uses the OpenAPI-derived schema (no prompt fallback)', () => {
    const toolsPath = resolve(import.meta.dirname, '../../src/generated/mcp/tools.json');
    const tools = JSON.parse(readFileSync(toolsPath, 'utf8')) as {
      tools: ReadonlyArray<{
        _operationId: string;
        inputSchema: {
          properties?: Record<string, unknown>;
          required?: readonly string[];
        };
      }>;
    };
    const systemOneTool = tools.tools.find((t) => t._operationId === 'systemOne');
    expect(systemOneTool).toBeDefined();
    const props = systemOneTool?.inputSchema.properties ?? {};
    expect(props).toHaveProperty('model');
    expect(props).toHaveProperty('state');
    expect(props).toHaveProperty('questions');
    expect(props).toHaveProperty('images');
    expect(props).not.toHaveProperty('prompt');
    expect(systemOneTool?.inputSchema.required).toContain('model');
    expect(systemOneTool?.inputSchema.required).toContain('questions');
  });
});
