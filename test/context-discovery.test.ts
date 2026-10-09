import { describe, expect, it } from 'vitest';
import { OllamaClient } from '../src/client.js';
import {
  extractParameterNumCtx,
  findRunningModelContextLength,
  resolveContextLength,
} from '../src/context-discovery.js';
import { OLLAMA_FALLBACK_CONTEXT_LENGTH } from '../src/context-safety.js';
import type { ModelResponse } from '../src/types.js';

/**
 * Context-window discovery (src/context-discovery.ts + ModelsClient.getContextLength):
 * allocated (/api/ps) vs Modelfile num_ctx (/api/show parameters) vs native
 * GGUF max (/api/show model_info), resolved by precedence.
 */

function psEntry(overrides: Partial<ModelResponse> & { name: string }): ModelResponse {
  return {
    model: overrides.name,
    modified_at: '2026-10-09T00:00:00Z',
    size: 1,
    digest: 'sha256:x',
    details: {
      format: 'gguf',
      family: 'llama',
      parameter_size: '8B',
      quantization_level: 'Q4_K_M',
    },
    ...overrides,
  } as ModelResponse;
}

describe('extractParameterNumCtx', () => {
  it('parses num_ctx from the padded multi-line parameters string /api/show returns', () => {
    // Realistic shape from the official API examples: name + whitespace padding + value.
    expect(extractParameterNumCtx('num_stop 8192\nnum_ctx    4096\ntemperature 0.7')).toBe(4096);
    expect(extractParameterNumCtx('num_ctx 8192')).toBe(8192);
  });

  it('ignores absent, malformed, and non-positive values', () => {
    expect(extractParameterNumCtx(undefined)).toBeUndefined();
    expect(extractParameterNumCtx('')).toBeUndefined();
    expect(extractParameterNumCtx('temperature 0.7\ntop_k 40')).toBeUndefined();
    expect(extractParameterNumCtx('num_ctx abc')).toBeUndefined();
    expect(extractParameterNumCtx('num_ctx 0')).toBeUndefined();
    // Must not match keys that merely start with num_ctx
    expect(extractParameterNumCtx('num_ctx_extra 4096')).toBeUndefined();
  });
});

describe('resolveContextLength precedence', () => {
  it('prefers the allocated running window over everything else', () => {
    expect(resolveContextLength({ running: 4096, parameter: 8192, native: 131072 })).toEqual({
      contextLength: 4096,
      source: 'running',
      runningContextLength: 4096,
      parameterContextLength: 8192,
      nativeContextLength: 131072,
    });
  });

  it('falls back to the Modelfile num_ctx default when not running', () => {
    expect(resolveContextLength({ parameter: 8192, native: 131072 })).toEqual({
      contextLength: 8192,
      source: 'parameters',
      parameterContextLength: 8192,
      nativeContextLength: 131072,
    });
  });

  it('falls back to the native GGUF max when no tighter signal exists', () => {
    expect(resolveContextLength({ native: 131072 })).toEqual({
      contextLength: 131072,
      source: 'model-info',
      nativeContextLength: 131072,
    });
  });

  it('returns the conservative fallback when nothing is discoverable', () => {
    expect(resolveContextLength({})).toEqual({
      contextLength: OLLAMA_FALLBACK_CONTEXT_LENGTH,
      source: 'fallback',
    });
  });

  it('drops degenerate signal values instead of trusting them', () => {
    expect(resolveContextLength({ running: 0, parameter: -5, native: Number.NaN })).toEqual({
      contextLength: OLLAMA_FALLBACK_CONTEXT_LENGTH,
      source: 'fallback',
    });
    expect(resolveContextLength({ running: 0, native: 4096 }).source).toBe('model-info');
  });
});

describe('findRunningModelContextLength', () => {
  it('matches by exact name and by model field', () => {
    const models = [psEntry({ name: 'llama3.1:latest', context_length: 4096 })];
    expect(findRunningModelContextLength(models, 'llama3.1:latest')).toBe(4096);
    expect(
      findRunningModelContextLength(
        [psEntry({ name: 'x', model: 'qwen:7b', context_length: 8192 })],
        'qwen:7b',
      ),
    ).toBe(8192);
  });

  it('matches a tag-less request model to its tagged running entry', () => {
    const models = [psEntry({ name: 'llama3.1:latest', context_length: 4096 })];
    expect(findRunningModelContextLength(models, 'llama3.1')).toBe(4096);
  });

  it('returns undefined when not loaded or when the entry lacks context_length', () => {
    const loaded = [psEntry({ name: 'llama3.1:latest', context_length: 4096 })];
    expect(findRunningModelContextLength(loaded, 'gemma4')).toBeUndefined();
    expect(findRunningModelContextLength([], 'llama3.1')).toBeUndefined();
    // Tag-less request must not match a different model sharing the prefix.
    expect(
      findRunningModelContextLength([psEntry({ name: 'llama3.2:latest' })], 'llama3.1'),
    ).toBeUndefined();
    expect(
      findRunningModelContextLength([psEntry({ name: 'llama3.1:latest' })], 'llama3.1'),
    ).toBeUndefined();
  });
});

describe('ModelsClient.getContextLength (client wiring)', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('consults /api/ps then /api/show and resolves the allocated window with native context', async () => {
    const calls: { path: string; method: string }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, method: init?.method ?? 'GET' });
      if (path.endsWith('/api/ps')) {
        return jsonResponse({ models: [{ name: 'gemma4:latest', context_length: 4096 }] });
      }
      return jsonResponse({
        model_info: { 'gemma4.context_length': 131072, 'gemma4.block_count': 42 },
        details: {
          format: 'gguf',
          family: 'gemma4',
          parameter_size: '12B',
          quantization_level: 'Q4_K_M',
        },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = new OllamaClient({ fetch: fetchImpl, retries: 0 });

    const discovered = await client.getContextLength({ model: 'gemma4' });

    expect(discovered).toEqual({
      contextLength: 4096,
      source: 'running',
      runningContextLength: 4096,
      nativeContextLength: 131072,
    });
    expect(calls.map((c) => c.path)).toEqual(['/api/ps', '/api/show']);
  });

  it('skips /api/ps entirely with skipRunningCheck and resolves the Modelfile num_ctx default', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      return jsonResponse({
        parameters: 'num_stop 8192\nnum_ctx 8192',
        details: {
          format: 'gguf',
          family: 'llama',
          parameter_size: '8B',
          quantization_level: 'Q4_K_M',
        },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = new OllamaClient({ fetch: fetchImpl, retries: 0 });

    const discovered = await client.models.getContextLength({
      model: 'llama3.1',
      skipRunningCheck: true,
    });

    expect(discovered).toEqual({
      contextLength: 8192,
      source: 'parameters',
      parameterContextLength: 8192,
    });
    expect(calls).toEqual(['/api/show']);
  });

  it("treats a 404 from /api/ps as 'not running' and still discovers via /api/show", async () => {
    let psCalls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/api/ps')) {
        psCalls += 1;
        return jsonResponse({ error: 'not found' }, 404);
      }
      return jsonResponse({
        model_info: { 'llama.context_length': 131072 },
        details: {
          format: 'gguf',
          family: 'llama',
          parameter_size: '8B',
          quantization_level: 'Q4_K_M',
        },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = new OllamaClient({ fetch: fetchImpl, retries: 0 });

    const discovered = await client.getContextLength({ model: 'llama3.1:latest' });

    expect(discovered).toEqual({
      contextLength: 131072,
      source: 'model-info',
      nativeContextLength: 131072,
    });
    expect(psCalls).toBe(1);
  });

  it('propagates real transport failures from /api/ps', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/api/ps')) {
        return jsonResponse({ error: 'boom' }, 500);
      }
      return jsonResponse({});
    }) as unknown as typeof globalThis.fetch;
    const client = new OllamaClient({ fetch: fetchImpl, retries: 0 });

    await expect(client.getContextLength({ model: 'llama3.1' })).rejects.toThrow();
  });

  it('resolves the documented fallback when the server reports nothing', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/api/ps')) return jsonResponse({ models: [] });
      return jsonResponse({
        details: {
          format: 'gguf',
          family: 'llama',
          parameter_size: '8B',
          quantization_level: 'Q4_K_M',
        },
      });
    }) as unknown as typeof globalThis.fetch;
    const client = new OllamaClient({ fetch: fetchImpl, retries: 0 });

    expect(await client.getContextLength({ model: 'llama3.1' })).toEqual({
      contextLength: OLLAMA_FALLBACK_CONTEXT_LENGTH,
      source: 'fallback',
    });
  });
});
