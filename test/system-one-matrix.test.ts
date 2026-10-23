import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OllamaClient } from '../src/client.js';
import { NativeApi } from '../src/generated/api/native-api.js';
import { OllamaRuntime } from '../src/generated/runtime/runtime.js';
import { HttpClient } from '../src/transport/http.js';
import {
  OllamaAbortError,
  OllamaCloudModelVersionError,
  OllamaRequestTooLargeError,
} from '../src/errors.js';
import { systemOneOp } from '../src/generated/api/operations.js';
import { SystemOneRequestSchema } from '../src/generated/models/SystemOneRequest.schema.js';
import type { SystemOneRequest, SystemOneResponse } from '../src/system-one.js';

/**
 * Wave 13: Full System One test matrix.
 *
 * Covers:
 *   - Valid requests (choice, noul, score, mixed, structured state, images)
 *   - Schema validation (empty state, empty questions, invalid question type)
 *   - Response parsing (choice, noul with probability, score with legend)
 *   - Runtime guards (environment gating, version gating, no streaming)
 *   - Request size limits — dual cap since the 2026-10-16 upstream
 *     clarification: text+schema (images excluded) ≤ 64 KiB AND whole
 *     request ≤ 32 MiB, both bounds on every request
 *   - Contract integrity (OpenAPI discovers System One, no documented-endpoints exception)
 *   - OllamaClient.systemOne() ergonomic method + key-safe generics
 */

function mockFetch(response: unknown, status = 200): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

function mockFetchCapturing(
  response: unknown,
  status = 200,
): { fetchImpl: typeof globalThis.fetch; getLastBody: () => unknown } {
  let lastBody: unknown;
  return {
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      lastBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify(response), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch,
    getLastBody: () => lastBody,
  };
}

describe('Wave 13: System One — valid requests', () => {
  it('valid choice question', () => {
    const req: SystemOneRequest = {
      model: 'tev1:4b',
      state: 'test state',
      questions: {
        q1: {
          type: 'choice',
          instructions: 'Pick one',
          criteria: { a: 'Option A', b: 'Option B' },
        },
      },
    };
    expect(SystemOneRequestSchema.safeParse(req).success).toBe(true);
  });

  it('valid noul question', () => {
    const req: SystemOneRequest = {
      model: 'tev1:4b',
      state: 'test state',
      questions: {
        q1: { type: 'noul', instructions: 'Is this true?' },
      },
    };
    expect(SystemOneRequestSchema.safeParse(req).success).toBe(true);
  });

  it('valid score question', () => {
    const req: SystemOneRequest = {
      model: 'tev1:4b',
      state: 'test state',
      questions: {
        q1: {
          type: 'score',
          instructions: 'Rate this',
          criteria: ['low', 'medium', 'high'],
        },
      },
    };
    expect(SystemOneRequestSchema.safeParse(req).success).toBe(true);
  });

  it('mixed question types in one request', () => {
    const req: SystemOneRequest = {
      model: 'tev1:4b',
      state: { ticket: 'Customer was charged twice' },
      questions: {
        intent: {
          type: 'choice',
          instructions: 'What is the primary intent?',
          criteria: {
            refund: 'Customer wants a refund',
            duplicate_charge: 'Customer reports multiple charges',
          },
        },
        urgent: { type: 'noul', instructions: 'Does this require immediate attention?' },
        difficulty: {
          type: 'score',
          instructions: 'How difficult is this case?',
          criteria: ['trivial', 'simple', 'moderate', 'complex'],
        },
      },
    };
    expect(SystemOneRequestSchema.safeParse(req).success).toBe(true);
  });

  it('structured state (object)', () => {
    const req: SystemOneRequest = {
      model: 'tev1:4b',
      state: { ticket: 'abc', priority: 'high', timestamp: 12345 },
      questions: {
        q1: { type: 'noul', instructions: 'Is this urgent?' },
      },
    };
    expect(SystemOneRequestSchema.safeParse(req).success).toBe(true);
  });

  it('request with images array', () => {
    const req: SystemOneRequest = {
      model: 'clef:4b',
      state: 'Describe this image',
      images: ['iVBORw0KGgo...', 'iVBORw0KGgo...'],
      questions: {
        category: {
          type: 'choice',
          instructions: 'What is in this image?',
          criteria: { cat: 'A cat', dog: 'A dog', other: 'Something else' },
        },
      },
    };
    expect(SystemOneRequestSchema.safeParse(req).success).toBe(true);
  });
});

describe('Wave 13: System One — response parsing', () => {
  it('choice answer with confidence (correct upstream wire format)', async () => {
    // Wave 13 correction: confidence is a bare number (not { score }),
    // and probabilities is required.
    const mockResponse: SystemOneResponse = {
      model: 'tev1:4b',
      answers: {
        intent: {
          type: 'choice',
          choice: 'duplicate_charge',
          probabilities: { refund: 0.05, duplicate_charge: 0.9, cancellation: 0.05 },
          confidence: 0.92,
        },
      },
      usage: { input_tokens: 142, output_tokens: 8 },
    };
    const { fetchImpl, getLastBody } = mockFetchCapturing(mockResponse);
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      fetch: fetchImpl,
    });

    const result = await client.systemOne({
      model: 'tev1:4b',
      state: 'test',
      questions: {
        intent: {
          type: 'choice',
          instructions: 'Pick',
          criteria: { a: 'A', b: 'B' },
        },
      },
    });

    expect(result.answers.intent.type).toBe('choice');
    if (result.answers.intent.type === 'choice') {
      expect(result.answers.intent.choice).toBe('duplicate_charge');
      expect(result.answers.intent.confidence).toBe(0.92);
      expect(result.answers.intent.probabilities).toBeDefined();
    }
    // Verify the request was sent correctly.
    const body = getLastBody() as { model: string; questions: unknown };
    expect(body.model).toBe('tev1:4b');
  });

  it('noul answer with probability (correct upstream wire format)', async () => {
    // Wave 13 correction: noul answer has `noul: number` (probability of
    // true), NOT `bool: boolean` + `probability?: number`.
    const mockResponse: SystemOneResponse = {
      model: 'tev1:4b',
      answers: {
        urgent: {
          type: 'noul',
          noul: 0.87,
        },
      },
      usage: { input_tokens: 50, output_tokens: 4 },
    };
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      fetch: mockFetch(mockResponse),
    });

    const result = await client.systemOne({
      model: 'tev1:4b',
      state: 'test',
      questions: { urgent: { type: 'noul', instructions: 'Urgent?' } },
    });

    expect(result.answers.urgent.type).toBe('noul');
    if (result.answers.urgent.type === 'noul') {
      expect(result.answers.urgent.noul).toBe(0.87);
    }
  });

  it('score answer with legend and probabilities (correct upstream wire format)', async () => {
    // Wave 13 correction: score is a probability-weighted average (number),
    // legend is Record<string, string>, probabilities is Record<string, number>,
    // confidence is a bare number. All fields required.
    const mockResponse: SystemOneResponse = {
      model: 'tev1:4b',
      answers: {
        difficulty: {
          type: 'score',
          score: 2.73,
          legend: {
            '0': 'trivial',
            '1': 'simple',
            '2': 'moderate',
            '3': 'complex',
            '4': 'very_complex',
          },
          probabilities: { '0': 0.05, '1': 0.1, '2': 0.2, '3': 0.55, '4': 0.1 },
          confidence: 0.78,
        },
      },
      usage: { input_tokens: 80, output_tokens: 6 },
    };
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      fetch: mockFetch(mockResponse),
    });

    const result = await client.systemOne({
      model: 'tev1:4b',
      state: 'test',
      questions: {
        difficulty: {
          type: 'score',
          instructions: 'Rate',
          criteria: ['trivial', 'simple', 'moderate', 'complex', 'very_complex'],
        },
      },
    });

    expect(result.answers.difficulty.type).toBe('score');
    if (result.answers.difficulty.type === 'score') {
      expect(result.answers.difficulty.score).toBe(2.73);
      expect(result.answers.difficulty.legend['3']).toBe('complex');
      expect(Object.keys(result.answers.difficulty.probabilities)).toHaveLength(5);
      expect(result.answers.difficulty.confidence).toBe(0.78);
    }
  });

  it('usage carries input_tokens/output_tokens (not prompt_tokens)', async () => {
    const mockResponse: SystemOneResponse = {
      model: 'tev1:4b',
      answers: { q: { type: 'noul', noul: 0.99 } },
      usage: { input_tokens: 142, output_tokens: 8 },
    };
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      fetch: mockFetch(mockResponse),
    });

    const result = await client.systemOne({
      model: 'tev1:4b',
      state: 'test',
      questions: { q: { type: 'noul', instructions: '?' } },
    });

    expect(result.usage.input_tokens).toBe(142);
    expect(result.usage.output_tokens).toBe(8);
    // Should NOT have prompt_tokens or completion_tokens.
    expect(result.usage).not.toHaveProperty('prompt_tokens');
    expect(result.usage).not.toHaveProperty('completion_tokens');
    expect(result.usage).not.toHaveProperty('total_tokens');
  });
});

describe('Wave 13: System One — runtime guards', () => {
  it('allows cloud-mode calls since the 2026-10-16 upstream cloud launch', async () => {
    // Upstream launched System One in Ollama's cloud (clef:cloud models)
    // on 2026-10-16 — the environment guard no longer rejects it. A
    // client pointed at a cloud host must get past the guard and issue
    // the request (version probe passes at 0.41.0).
    let calls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/api/version')) {
        return new Response(JSON.stringify({ version: '0.41.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      calls += 1;
      return new Response(
        JSON.stringify({
          model: 'clef:cloud',
          answers: { q: { type: 'noul', noul: 0.95 } },
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;
    const client = new OllamaClient({
      baseUrl: 'https://api.ollama.com',
      fetch: fetchImpl,
    });
    await client.systemOne({
      model: 'clef:cloud',
      state: 'test',
      questions: { q: { type: 'noul', instructions: '?' } },
    });
    expect(calls).toBe(1);
  });

  it('still rejects genuinely local-only operations in cloud mode', async () => {
    // The environment guard itself stays — only System One was promoted
    // to cloud-capable. Model management (pull) remains local-only.
    const http = new HttpClient({
      baseUrl: 'https://api.ollama.com',
      fetch: mockFetch({}),
    });
    const runtime = new OllamaRuntime({ http, localMode: false, enforceVersion: 'off' });
    const api = new NativeApi(runtime);
    await expect(api.pull({ model: 'tev1:4b' } as never)).rejects.toThrow(
      /local-only and not supported in cloud mode/,
    );
  });

  it('rejects when server version is too old', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: mockFetch({ version: '0.34.0' }),
    });
    const runtime = new OllamaRuntime({ http, serverVersion: '0.34.0' });
    const api = new NativeApi(runtime);

    await expect(
      api.systemOne({
        model: 'tev1:4b',
        state: 'test',
        questions: { q: { type: 'noul', instructions: '?' } },
      }),
    ).rejects.toThrow(/requires Ollama >= 0.35.0/);
  });

  it('systemOneOp declares transport: json, streaming: false', () => {
    expect(systemOneOp.transport.mode).toBe('json');
    expect(systemOneOp.transport.streaming).toBe(false);
    expect(systemOneOp.transport.streamingDefault).toBeUndefined();
  });

  it('NativeApi.systemOne has no streaming overload', () => {
    // The generated method should accept a plain SystemOneRequest and
    // return Promise<SystemOneResponse> — no stream overload since
    // System One doesn't stream.
    type Method = typeof NativeApi.prototype.systemOne;
    // If streaming were supported, there'd be an overload accepting
    // { stream: true }. The non-streaming signature takes the base type.
    type Params = Method extends (request: infer R) => Promise<unknown> ? R : never;
    // The parameter should NOT require a `stream` field.
    type HasStream = Params extends { stream: true } ? true : false;
    expect<HasStream>(false as HasStream).toBe(false);
  });
});

describe('Wave 13: System One — request size limits', () => {
  it('rejects text-and-schema >64 KiB without images', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: mockFetch({}),
    });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });
    const api = new NativeApi(runtime);

    const oversized = 'x'.repeat(80 * 1024);
    await expect(
      api.systemOne({
        model: 'tev1:4b',
        state: oversized,
        questions: { q: { type: 'noul', instructions: '?' } },
      }),
    ).rejects.toBeInstanceOf(OllamaRequestTooLargeError);
  });

  it('rejects text-and-schema >64 KiB even when images are present (dual cap)', async () => {
    // 2026-10-16 upstream clarification: the 64 KiB cap bounds the text
    // and schema portion (images excluded) — attaching images raises
    // the whole-request ceiling to 32 MiB but never relaxes the text
    // cap. 70 KiB of state + a small image is under 32 MiB overall, yet
    // the text portion alone busts 64 KiB → client-side 413. (Under the
    // pre-refresh either/or reading this request slipped through.)
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: mockFetch({}),
    });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });
    const api = new NativeApi(runtime);

    await expect(
      api.systemOne({
        model: 'clef:4b',
        state: 'x'.repeat(70 * 1024),
        images: ['base64data'],
        questions: { q: { type: 'noul', instructions: '?' } },
      }),
    ).rejects.toMatchObject({
      code: 'request_too_large',
      status: 413,
      maxBytes: 65536,
    });
  });

  it('allows image-bearing bodies while text stays under the cap', async () => {
    // Small text + 100 KiB of image bytes: whole body ~100 KiB (well
    // under the 32 MiB whole-request cap), text portion tiny — passes.
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          model: 'clef:4b',
          answers: { q: { type: 'noul', noul: 0.95 } },
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });
    const api = new NativeApi(runtime);

    await api.systemOne({
      model: 'clef:4b',
      state: 'small',
      images: ['a'.repeat(100 * 1024)],
      questions: { q: { type: 'noul', instructions: '?' } },
    });
    expect(calls).toBe(1);
  });

  it('rejects whole requests >32 MiB even with images', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: mockFetch({}),
    });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });
    const api = new NativeApi(runtime);

    // 33 MiB body with images — exceeds even the 32 MiB images limit.
    const oversized = 'x'.repeat(33 * 1024 * 1024);
    await expect(
      api.systemOne({
        model: 'clef:4b',
        state: oversized,
        images: ['base64data'],
        questions: { q: { type: 'noul', instructions: '?' } },
      }),
    ).rejects.toBeInstanceOf(OllamaRequestTooLargeError);
  });

  it('systemOneOp declares both limits', () => {
    expect(systemOneOp.constraints?.maxRequestBytes).toBe(65536);
    expect(systemOneOp.constraints?.maxRequestBytesWithImages).toBe(33554432);
  });
});

describe('Wave 13: System One — OllamaClient.systemOne() ergonomic method', () => {
  it('delegates to the generated NativeApi and returns a typed response', async () => {
    const mockResponse: SystemOneResponse = {
      model: 'tev1:4b',
      answers: {
        intent: {
          type: 'choice',
          choice: 'refund',
          probabilities: { refund: 0.9, other: 0.1 },
          confidence: 0.9,
        },
      },
      usage: { input_tokens: 50, output_tokens: 4 },
    };
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      fetch: mockFetch(mockResponse),
    });

    const result = await client.systemOne({
      model: 'tev1:4b',
      state: 'charged twice',
      questions: {
        intent: {
          type: 'choice',
          instructions: 'What is the intent?',
          criteria: { refund: 'Refund', other: 'Other' },
        },
      },
    });

    // Key-safe: 'intent' is the only key we asked about.
    expect(result.answers.intent.type).toBe('choice');
    expect(result.model).toBe('tev1:4b');
  });

  it('the native getter is cached', () => {
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
    const a = client.native;
    const b = client.native;
    expect(a).toBe(b);
  });
});

describe('System One cloud-model version gate (ADR 0036)', () => {
  /**
   * Closes the docs-vs-runtime gap: since the 2026-10-16 upstream cloud
   * launch the docs promised "cloud models require Ollama >= 0.40.5,
   * enforced automatically" — but only the blanket 0.35.0 IR constraint
   * was ever enforced. The gate now lives in OllamaClient.systemOne:
   * cloud model (ends with :cloud) + local-mode client → probe /api/version
   * (cached per client) and throw OllamaCloudModelVersionError below 0.40.5.
   * Hosted ollama.com endpoints always support cloud models (no gate).
   */
  const systemOneOk = {
    model: 'clef:cloud',
    answers: { q: { type: 'noul', noul: 0.95 } },
    usage: { input_tokens: 10, output_tokens: 2 },
  };

  function routedFetch(version: string | null): {
    fetchImpl: typeof globalThis.fetch;
    versionCalls: () => number;
    systemOneCalls: () => number;
  } {
    let versionCalls = 0;
    let systemOneCalls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/api/version')) {
        versionCalls += 1;
        if (version === null) {
          return new Response('server exploded', { status: 500 });
        }
        return new Response(JSON.stringify({ version }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      systemOneCalls += 1;
      return new Response(JSON.stringify(systemOneOk), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;
    return { fetchImpl, versionCalls: () => versionCalls, systemOneCalls: () => systemOneCalls };
  }

  it('isCloudModel and compareOllamaVersions basics (numeric, not lexicographic)', async () => {
    const { isCloudModel, compareOllamaVersions, CLOUD_MODEL_MIN_OLLAMA_VERSION } =
      await import('../src/system-one.js');
    expect(isCloudModel('clef:cloud')).toBe(true);
    expect(isCloudModel('tev1:4b')).toBe(false);
    expect(isCloudModel('cloud')).toBe(false); // suffix must be a tag, not the whole name
    expect(CLOUD_MODEL_MIN_OLLAMA_VERSION).toBe('0.40.5');
    // '0.9.0' < '0.40.5' NUMERICALLY (9 < 40) — the classic lexicographic trap.
    expect(compareOllamaVersions('0.9.0', '0.40.5')).toBeLessThan(0);
    expect(compareOllamaVersions('0.40.5', '0.40.5')).toBe(0);
    expect(compareOllamaVersions('0.41.0', '0.40.5')).toBeGreaterThan(0);
    expect(compareOllamaVersions('1.0.0', '0.40.5')).toBeGreaterThan(0);
  });

  it('throws OllamaCloudModelVersionError before any request when the local server is too old', async () => {
    const { OllamaCloudModelVersionError } = await import('../src/errors.js');
    const { fetchImpl, systemOneCalls } = routedFetch('0.39.0');
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });

    const error = await client
      .systemOne({
        model: 'clef:cloud',
        state: 'test',
        questions: { q: { type: 'noul', instructions: '?' } },
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(OllamaCloudModelVersionError);
    const typed = error as InstanceType<typeof OllamaCloudModelVersionError>;
    expect(typed.model).toBe('clef:cloud');
    expect(typed.serverVersion).toBe('0.39.0');
    expect(typed.minRequiredVersion).toBe('0.40.5');
    expect(typed.code).toBe('cloud_model_version');
    expect(typed.retryable).toBe(false);
    expect(typed.message).toContain('0.40.5');
    // The whole point: no /v1/systemone round-trip was wasted.
    expect(systemOneCalls()).toBe(0);
  });

  it('allows cloud models on a local server at exactly 0.40.5', async () => {
    const { fetchImpl, systemOneCalls } = routedFetch('0.40.5');
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });

    const result = await client.systemOne({
      model: 'clef:cloud',
      state: 'test',
      questions: { q: { type: 'noul', instructions: '?' } },
    });

    expect(result.answers.q?.type).toBe('noul');
    expect(systemOneCalls()).toBe(1);
  });

  it('does not gate non-cloud models on the same too-old server (model-dependent, not blanket)', async () => {
    // Same server reporting 0.39.0 as the rejection test above — but a
    // local model sails through (0.39 >= the blanket 0.35.0 floor).
    const { fetchImpl, systemOneCalls } = routedFetch('0.39.0');
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });

    const result = await client.systemOne({
      model: 'tev1:4b',
      state: 'test',
      questions: { q: { type: 'noul', instructions: '?' } },
    });

    expect(result.model).toBe('clef:cloud'); // mock echoes; the point is: no throw
    expect(systemOneCalls()).toBe(1);
  });

  it('hosted ollama.com endpoints bypass the gate even on an "old" version', async () => {
    // Same 0.39.0 — but pointed at Ollama's hosted endpoint, which always
    // fronts cloud models. No OllamaCloudModelVersionError may fire.
    const { fetchImpl, systemOneCalls } = routedFetch('0.39.0');
    const client = new OllamaClient({ baseUrl: 'https://api.ollama.com', fetch: fetchImpl });

    await client.systemOne({
      model: 'clef:cloud',
      state: 'test',
      questions: { q: { type: 'noul', instructions: '?' } },
    });

    expect(systemOneCalls()).toBe(1);
  });

  it('fails open when the version probe errors (auto policy)', async () => {
    const { fetchImpl, systemOneCalls } = routedFetch(null);
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });

    await client.systemOne({
      model: 'clef:cloud',
      state: 'test',
      questions: { q: { type: 'noul', instructions: '?' } },
    });

    // The server's own response is the next signal — request went through.
    expect(systemOneCalls()).toBe(1);
  });

  it('caches the version probe per client (one probe per cache, not per call)', async () => {
    const { fetchImpl, versionCalls, systemOneCalls } = routedFetch('0.40.5');
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });

    await client.systemOne({
      model: 'clef:cloud',
      state: 'test',
      questions: { q: { type: 'noul', instructions: '?' } },
    });
    await client.systemOne({
      model: 'clef:cloud',
      state: 'test',
      questions: { q: { type: 'noul', instructions: '?' } },
    });

    // Two probes total after two calls: the client-side gate cache and the
    // runtime's own 0.35.0-constraint cache — NOT one per call (that would
    // be 4+), proving both caches held.
    expect(versionCalls()).toBe(2);
    expect(systemOneCalls()).toBe(2);
  });
});

describe('Wave 13: System One — contract integrity', () => {
  it('/v1/systemone is discoverable from the OpenAPI source (not just documented-endpoints)', () => {
    // The OpenAPI source now declares /v1/systemone as a path, so the
    // bidirectional discovery validator finds it from the OpenAPI
    // source directly. The documented-endpoints.json exception is no
    // longer needed for System One.
    const openapi = readFileSync(
      resolve(process.cwd(), 'contracts/sources/ollama.openapi.yaml'),
      'utf8',
    );
    expect(openapi).toContain('/v1/systemone:');
    expect(openapi).toContain('SystemOneRequest');
    expect(openapi).toContain('SystemOneNoulQuestion');
    expect(openapi).toContain('SystemOneContent');
  });

  it('/v1/systemone is NOT in documented-endpoints.json (removed in Wave 13)', () => {
    const documented = JSON.parse(
      readFileSync(resolve(process.cwd(), 'contracts/sources/documented-endpoints.json'), 'utf8'),
    ) as { endpoints: { path: string }[] };
    const paths = documented.endpoints.map((e) => e.path);
    expect(paths).not.toContain('/v1/systemone');
    // web_search and web_fetch are still there (not in OpenAPI).
    expect(paths).toContain('/api/web_search');
    expect(paths).toContain('/api/web_fetch');
  });

  it('the overlay uses openapi: reference (not path:/method: workaround)', () => {
    const overlay = readFileSync(
      resolve(process.cwd(), 'contracts/overlays/systemone.yaml'),
      'utf8',
    );
    expect(overlay).toMatch(/openapi:\s*\/v1\/systemone/);
    expect(overlay).not.toMatch(/^ {4}path:\s*\/v1\/systemone/m);
    // The inline schemas block should be gone.
    expect(overlay).not.toContain('SystemOneChoiceQuestion:');
    expect(overlay).not.toContain('SystemOneYesNoQuestion:');
  });
});

describe('System One — caller cancellation (ADR 0037)', () => {
  const localRequest: SystemOneRequest = {
    model: 'tev1:4b',
    state: 'test',
    questions: { q: { type: 'noul', instructions: '?' } },
  };
  const cloudRequest: SystemOneRequest = { ...localRequest, model: 'clef:cloud' };
  const jsonHeaders = { 'content-type': 'application/json' };
  const versionReply = (version: string): Response =>
    new Response(JSON.stringify({ version }), { status: 200, headers: jsonHeaders });

  /**
   * Answers `/api/version` with 0.41.0 and stalls every request whose URL
   * contains `path` until its signal aborts, like a real fetch would.
   */
  function fetchStalling(
    path: string,
    onStall: (signal: AbortSignal) => void,
  ): typeof globalThis.fetch {
    return ((url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes(path)) return Promise.resolve(versionReply('0.41.0'));
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        onStall(signal);
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as unknown as typeof globalThis.fetch;
  }

  it('cancels the wire request when the caller aborts', async () => {
    let stalled!: () => void;
    const onStall = new Promise<void>((resolve) => {
      stalled = resolve;
    });
    let wireSignal: AbortSignal | undefined;
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      retries: 0,
      timeoutMs: 0,
      fetch: fetchStalling('/v1/systemone', (signal) => {
        wireSignal = signal;
        stalled();
      }),
    });
    const controller = new AbortController();

    const pending = client.systemOne(localRequest, { signal: controller.signal });
    await onStall;
    controller.abort(new Error('caller gave up'));

    await expect(pending).rejects.toThrow();
    expect(wireSignal?.aborted).toBe(true);
  });

  it('bounds a stalled cloud-version probe by the caller signal, and never sends the request', async () => {
    let probeRequested!: () => void;
    const probeSeen = new Promise<void>((resolve) => {
      probeRequested = resolve;
    });
    const systemOneUrls: string[] = [];
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes('/api/version')) {
        systemOneUrls.push(String(url));
        return Promise.resolve(versionReply('0.41.0'));
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        probeRequested();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as unknown as typeof globalThis.fetch;
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      retries: 0,
      timeoutMs: 0,
      fetch: fetchImpl,
    });
    const controller = new AbortController();

    const pending = client.systemOne(cloudRequest, { signal: controller.signal });
    await probeSeen;
    controller.abort(new Error('deadline'));

    await expect(pending).rejects.toBeInstanceOf(OllamaAbortError);
    expect(systemOneUrls).toEqual([]);
  });

  it('an aborted caller does not poison the shared version probe for the next call', async () => {
    let probeRequested!: () => void;
    const probeSeen = new Promise<void>((resolve) => {
      probeRequested = resolve;
    });
    let releaseProbe!: (version: string) => void;
    const probeReply = new Promise<string>((resolve) => {
      releaseProbe = resolve;
    });
    let systemOneCalls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).includes('/api/version')) {
        probeRequested();
        const version = await probeReply;
        return versionReply(version);
      }
      systemOneCalls += 1;
      return new Response(JSON.stringify({ model: 'clef:cloud', answers: {} }), {
        status: 200,
        headers: jsonHeaders,
      });
    }) as unknown as typeof globalThis.fetch;
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      retries: 0,
      timeoutMs: 0,
      fetch: fetchImpl,
    });
    const impatient = new AbortController();

    const first = client.systemOne(cloudRequest, { signal: impatient.signal });
    await probeSeen;
    impatient.abort(new Error('gave up'));
    await expect(first).rejects.toBeInstanceOf(OllamaAbortError);

    // The probe was never cancelled, so its answer is cached and gates this call.
    releaseProbe('0.39.0');
    await expect(client.systemOne(cloudRequest)).rejects.toBeInstanceOf(
      OllamaCloudModelVersionError,
    );
    expect(systemOneCalls).toBe(0);
  });

  it('applies to every runtime operation that takes a signal, not only systemOne', async () => {
    let stalled!: () => void;
    const onStall = new Promise<void>((resolve) => {
      stalled = resolve;
    });
    let wireSignal: AbortSignal | undefined;
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      retries: 0,
      timeoutMs: 0,
      fetch: fetchStalling('/api/tags', (signal) => {
        wireSignal = signal;
        stalled();
      }),
    });
    const controller = new AbortController();

    const pending = client.native.tags({ signal: controller.signal });
    await onStall;
    controller.abort(new Error('stop listing models'));

    await expect(pending).rejects.toThrow();
    expect(wireSignal?.aborted).toBe(true);
  });
});
