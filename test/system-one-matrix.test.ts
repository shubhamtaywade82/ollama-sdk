import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OllamaClient } from '../src/client.js';
import { NativeApi } from '../src/generated/api/native-api.js';
import { OllamaRuntime } from '../src/generated/runtime/runtime.js';
import { HttpClient } from '../src/transport/http.js';
import { OllamaRequestTooLargeError } from '../src/errors.js';
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
 *   - Runtime guards (local-only, version gating, no streaming)
 *   - Request size limits (64 KiB without images, 32 MiB with images)
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
  it('choice answer with confidence', async () => {
    const mockResponse: SystemOneResponse = {
      model: 'tev1:4b',
      answers: {
        intent: {
          type: 'choice',
          choice: 'duplicate_charge',
          confidence: { score: 0.92 },
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
      expect(result.answers.intent.confidence?.score).toBe(0.92);
    }
    // Verify the request was sent correctly.
    const body = getLastBody() as { model: string; questions: unknown };
    expect(body.model).toBe('tev1:4b');
  });

  it('noul answer with probability', async () => {
    const mockResponse: SystemOneResponse = {
      model: 'tev1:4b',
      answers: {
        urgent: {
          type: 'noul',
          bool: true,
          probability: 0.87,
          confidence: { score: 0.85 },
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
      expect(result.answers.urgent.bool).toBe(true);
      expect(result.answers.urgent.probability).toBe(0.87);
    }
  });

  it('score answer with legend and probabilities', async () => {
    const mockResponse: SystemOneResponse = {
      model: 'tev1:4b',
      answers: {
        difficulty: {
          type: 'score',
          score: 3,
          legend: 'complex',
          probabilities: [0.05, 0.1, 0.2, 0.55, 0.1],
          confidence: { score: 0.78 },
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
      expect(result.answers.difficulty.score).toBe(3);
      expect(result.answers.difficulty.legend).toBe('complex');
      expect(result.answers.difficulty.probabilities).toHaveLength(5);
    }
  });

  it('usage carries input_tokens/output_tokens (not prompt_tokens)', async () => {
    const mockResponse: SystemOneResponse = {
      model: 'tev1:4b',
      answers: { q: { type: 'noul', bool: true } },
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
  it('rejects cloud-mode calls (local-only)', async () => {
    const client = new OllamaClient({
      baseUrl: 'https://api.ollama.com',
      fetch: mockFetch({}),
    });
    await expect(
      client.systemOne({
        model: 'tev1:4b',
        state: 'test',
        questions: { q: { type: 'noul', instructions: '?' } },
      }),
    ).rejects.toThrow(/local-only/);
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
  it('rejects bodies >64 KiB without images', async () => {
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

  it('allows bodies >64 KiB when images are present (up to 32 MiB)', async () => {
    // A body with images that's >64 KiB but <32 MiB should be allowed.
    // We don't actually send 32 MiB in the test — we just verify the
    // runtime selects the higher limit when images are present.
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          model: 'clef:4b',
          answers: { q: { type: 'noul', bool: true } },
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });
    const api = new NativeApi(runtime);

    // 80 KiB body WITH images — should pass the 64 KiB base limit
    // because the 32 MiB images limit applies.
    await api.systemOne({
      model: 'clef:4b',
      state: 'x'.repeat(70 * 1024),
      images: ['base64data'],
      questions: { q: { type: 'noul', instructions: '?' } },
    });
    expect(calls).toBe(1);
  });

  it('rejects bodies >32 MiB even with images', async () => {
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
        intent: { type: 'choice', choice: 'refund', confidence: { score: 0.9 } },
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
      readFileSync(
        resolve(process.cwd(), 'contracts/sources/documented-endpoints.json'),
        'utf8',
      ),
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
