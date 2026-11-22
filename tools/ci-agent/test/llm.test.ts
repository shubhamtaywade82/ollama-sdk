import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { callStructuredLlm } from '../src/llm.js';

describe('callStructuredLlm', () => {
  const DummySchema = z.object({
    status: z.enum(['ok', 'fail']),
    code: z.number(),
  });

  it('parses valid structured JSON output from model', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'test-model',
        message: {
          role: 'assistant',
          content: '```json\n{"status": "ok", "code": 200}\n```',
        },
      }),
    });

    const result = await callStructuredLlm({
      model: 'test-model',
      system: 'system prompt',
      prompt: 'user prompt',
      schema: DummySchema,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:11434',
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });

    expect(result).toEqual({ status: 'ok', code: 200 });
  });

  it('throws on schema violation (fail-closed)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'test-model',
        message: {
          role: 'assistant',
          content: '{"status": "invalid_status", "code": "not_a_number"}',
        },
      }),
    });

    await expect(
      callStructuredLlm({
        model: 'test-model',
        system: 'system prompt',
        prompt: 'user prompt',
        schema: DummySchema,
        apiKey: 'test-key',
        baseUrl: 'http://localhost:11434',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow();
  });
});
