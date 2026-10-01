import { describe, expect, it } from 'vitest';
import { NativeApi } from '../../src/generated/api/native-api.js';
import type { OllamaRuntime } from '../../src/generated/runtime/runtime.js';
import { systemOneOp } from '../../src/generated/api/operations.js';
import { SystemOneRequestSchema } from '../../src/generated/models/SystemOneRequest.schema.js';
import { SystemOneResponseSchema } from '../../src/generated/models/SystemOneResponse.schema.js';
import type { SystemOneRequest, SystemOneResponse } from '../../src/generated/models/index.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Wave 12 (P0 #4): the generated System One surface must be fully typed.
 * Before this wave, `NativeApi.systemOne(request: Record<string, unknown>):
 * Promise<unknown>` was the entire contract — the IR had no schema for
 * /v1/systemone, so the generator fell back to untyped stubs. The MCP
 * tool descriptor for systemOne was even worse: it used the universal
 * `{prompt: string}` fallback.
 *
 * This test file pins the typed surface so a regression to the untyped
 * stubs would fail loud at compile time.
 */
describe('Wave 12: System One is fully generated', () => {
  const runtime = undefined as unknown as OllamaRuntime;
  const api = new NativeApi(runtime);

  function isAssignable<A, B>(_: A extends B ? true : false): boolean {
    return true;
  }

  it('systemOneOp carries request and response schema refs', () => {
    expect(systemOneOp.request?.$ref).toBe('#/schemas/SystemOneRequest');
    expect(systemOneOp.response?.$ref).toBe('#/schemas/SystemOneResponse');
  });

  it('NativeApi.systemOne accepts SystemOneRequest (not Record<string, unknown>)', () => {
    type Method = typeof api.systemOne;
    type Params = Method extends (request: infer R) => Promise<unknown> ? R : never;
    // SystemOneRequest must be assignable to the inferred param type. If
    // the generator regressed to Record<string, unknown>, the assignment
    // would still succeed but the inverse would fail — so we check both
    // directions to be sure.
    expect(isAssignable<SystemOneRequest, Params>(true)).toBe(true);
    // The param type must NOT be Record<string, unknown>. We assert that
    // by checking the inverse direction: Record<string, unknown> is NOT
    // assignable to SystemOneRequest's narrow shape (the `model: string`
    // field is required and not optional). TS structures this so the
    // assignment below compiles only when Params is the rich type.
    type CheckInverse = Params extends { model: string } ? true : false;
    expect(isAssignable<true, CheckInverse>(true)).toBe(true);
  });

  it('NativeApi.systemOne returns Promise<SystemOneResponse> (not Promise<unknown>)', () => {
    type Method = typeof api.systemOne;
    type Return = Method extends (request: unknown) => Promise<infer R> ? R : never;
    expect(isAssignable<SystemOneResponse, Return>(true)).toBe(true);
    // The return type must carry the typed shape (model: string).
    type CheckShape = Return extends { model: string } ? true : false;
    expect(isAssignable<true, CheckShape>(true)).toBe(true);
  });

  it('SystemOneRequestSchema validates a well-formed request', () => {
    const valid: SystemOneRequest = {
      model: 'systemone-v1',
      state: { turn: 1 },
      questions: {
        q1: { type: 'choice', prompt: 'Pick one', choices: ['a', 'b'] },
        q2: { type: 'yes_no', prompt: 'Continue?' },
        q3: { type: 'score', prompt: 'Rate 0-10' },
      },
    };
    const result = SystemOneRequestSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('SystemOneResponseSchema validates a well-formed response', () => {
    const valid: SystemOneResponse = {
      model: 'systemone-v1',
      answers: {
        q1: { type: 'choice', choice: 'a' },
        q2: { type: 'yes_no', yes_no: true },
        q3: { type: 'score', score: 7 },
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = SystemOneResponseSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('MCP tool descriptor for systemOne uses the real schema (no prompt fallback)', () => {
    const toolsPath = resolve(import.meta.dirname, '../../src/generated/mcp/tools.json');
    const tools = JSON.parse(readFileSync(toolsPath, 'utf8')) as {
      tools: ReadonlyArray<{
        _operationId: string;
        inputSchema: {
          type?: string;
          properties?: Record<string, unknown>;
          required?: readonly string[];
        };
      }>;
    };
    const systemOneTool = tools.tools.find((t) => t._operationId === 'systemOne');
    expect(systemOneTool).toBeDefined();
    const props = systemOneTool?.inputSchema.properties ?? {};
    // The real System One schema has model/state/questions; the previous
    // fallback had only `prompt`.
    expect(props).toHaveProperty('model');
    expect(props).toHaveProperty('state');
    expect(props).toHaveProperty('questions');
    expect(props).not.toHaveProperty('prompt');
    expect(systemOneTool?.inputSchema.required).toContain('model');
    expect(systemOneTool?.inputSchema.required).toContain('questions');
  });
});
