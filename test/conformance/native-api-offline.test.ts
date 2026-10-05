/**
 * Offline wire-format conformance tests for Ollama's native REST API.
 *
 * The sibling file `native-api.test.ts` hits a REAL Ollama server
 * (skipping when none is available). Those tests assert TWO things:
 *
 *   1. The wire format matches the IR-generated Zod schema.
 *   2. The model's actual behavior produces a meaningful response
 *      (e.g. `res.message.content` is a non-empty string).
 *
 * (2) requires a real model — only a live server can validate that
 * `qwen3:0.6b` actually generates text in response to a prompt.
 *
 * (1) does NOT require a real model. It only requires that the
 * server emit NDJSON frames whose shape matches the contract. This
 * file uses `OllamaMockServer` (see `test/mocks/ollama-mock-server.ts`)
 * to emit contract-shaped frames without any model inference — so
 * these tests run in every CI environment, including those without
 * an Ollama daemon.
 *
 * ## What this catches
 *
 *   - Schema drift between the IR (`contracts/ir/ollama.ir.json`)
 *     and the generated Zod schemas (`src/generated/models/*.schema.ts`).
 *   - SDK-side response parsing bugs (e.g. a field renamed in the
 *     IR but not in the hand-written type).
 *   - Wire-format violations the SDK should reject (e.g. missing
 *     required fields, wrong types on telemetry fields).
 *
 * ## What this does NOT catch
 *
 *   - Whether a real Ollama server actually emits the documented
 *     shape for a given model. That's the live `native-api.test.ts`
 *     suite's job.
 *   - Whether the model's response is semantically meaningful.
 *     That's not a wire-format concern.
 *
 * ## When to update these tests
 *
 *   - When adding a new field to a response type: add a test that
 *     emits the field via the mock server and asserts the SDK
 *     surfaces it correctly.
 *   - When the OpenAPI spec adds a new endpoint: add an offline
 *     conformance test for it here, mirroring the live test in
 *     `native-api.test.ts`.
 *   - When the schema for an existing endpoint changes: update the
 *     mock fixtures here AND the live test in `native-api.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OllamaMockServer } from '../mocks/ollama-mock-server.js';
import { OllamaClient } from '../../src/index.js';
import { OllamaRuntime } from '../../src/generated/runtime/runtime.js';
import { NativeApi } from '../../src/generated/api/native-api.js';
import { HttpClient } from '../../src/transport/http.js';
import {
  ChatResponseSchema,
  EmbedResponseSchema,
  GenerateResponseSchema,
  ListResponseSchema,
  PsResponseSchema,
  ShowResponseSchema,
  VersionResponseSchema,
} from '../../src/generated/models/schemas.js';
import type {
  ChatResponse,
  EmbedResponse,
  GenerateResponse,
  ListResponse,
  PsResponse,
  ShowResponse,
  VersionResponse,
} from '../../src/generated/models/index.js';

const TEST_MODEL = 'qwen3:0.6b';
const TEST_EMBED_MODEL = 'nomic-embed-text:latest';

let server: OllamaMockServer;
let client: OllamaClient;
let api: NativeApi;

beforeAll(async () => {
  server = new OllamaMockServer(0);
  await server.start();

  // Register static fixtures for the metadata endpoints. These don't
  // depend on the request body, so we register them once for the
  // whole test file.
  server.register('/api/version', {
    status: 200,
    headers: { 'content-type': 'application/json' },
    chunks: [JSON.stringify({ version: '0.5.0' })],
  });
  server.register('/api/tags', {
    status: 200,
    headers: { 'content-type': 'application/json' },
    chunks: [
      JSON.stringify({
        models: [
          {
            name: TEST_MODEL,
            model: TEST_MODEL,
            modified_at: '2026-10-05T00:00:00Z',
            size: 600_000_000,
            digest: 'sha256:abc123',
            details: {
              format: 'gguf',
              family: 'qwen3',
              parameter_size: '0.6B',
              quantization_level: 'Q4_0',
            },
          },
        ],
      } satisfies ListResponse),
    ],
  });
  server.register('/api/ps', {
    status: 200,
    headers: { 'content-type': 'application/json' },
    chunks: [
      JSON.stringify({
        models: [],
      } satisfies PsResponse),
    ],
  });
  server.register('/api/show', {
    status: 200,
    headers: { 'content-type': 'application/json' },
    chunks: [
      JSON.stringify({
        license: 'MIT',
        modelfile: 'FROM qwen3:0.6b',
        parameters: '',
        template: '{{ .Prompt }}',
        system: 'You are a helpful assistant.',
        details: {
          format: 'gguf',
          family: 'qwen3',
          parameter_size: '0.6B',
          quantization_level: 'Q4_0',
        },
        model_info: { 'qwen3.context_length': 32768 },
        capabilities: ['tools', 'completion'],
        modified_at: '2026-10-05T00:00:00Z',
      } satisfies ShowResponse),
    ],
  });

  client = new OllamaClient({ baseUrl: server.baseUrl });
  const http = new HttpClient({ baseUrl: server.baseUrl });
  const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });
  api = new NativeApi(runtime);
});

afterAll(async () => {
  await server.stop();
});

describe('Native REST API offline wire-format conformance', () => {
  it('GET /api/version returns VersionResponse matching the Zod schema', async () => {
    const res = await api.version();
    const parsed = VersionResponseSchema.safeParse(res);
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
    ).toBe(true);
    expect((res as VersionResponse).version).toBe('0.5.0');
    expect(typeof (res as VersionResponse).version).toBe('string');
  });

  it('GET /api/tags returns ListResponse matching the Zod schema', async () => {
    const res = await api.tags();
    const parsed = ListResponseSchema.safeParse(res);
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
    ).toBe(true);
    expect(Array.isArray((res as ListResponse).models)).toBe(true);
    expect((res as ListResponse).models.length).toBe(1);
    expect((res as ListResponse).models[0]?.name).toBe(TEST_MODEL);
  });

  it('GET /api/ps returns PsResponse matching the Zod schema (empty list)', async () => {
    const res = await api.ps();
    const parsed = PsResponseSchema.safeParse(res);
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
    ).toBe(true);
    expect(Array.isArray((res as PsResponse).models)).toBe(true);
    expect((res as PsResponse).models.length).toBe(0);
  });

  it('POST /api/show returns ShowResponse matching the Zod schema', async () => {
    const res = await api.show({ model: TEST_MODEL });
    const parsed = ShowResponseSchema.safeParse(res);
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
    ).toBe(true);
    expect((res as ShowResponse).details).toBeDefined();
    expect(typeof (res as ShowResponse).details.family).toBe('string');
    expect((res as ShowResponse).details.family).toBe('qwen3');
    expect((res as ShowResponse).capabilities).toContain('tools');
    expect((res as ShowResponse).capabilities).toContain('completion');
  });
});

describe('Native REST API offline wire-format conformance — inference endpoints', () => {
  // The chat/generate/embed endpoints emit responses whose `model`
  // field echoes the request's `model`, and whose telemetry fields
  // (total_duration, prompt_eval_count, etc.) are server-reported.
  // The mock server emits contract-shaped frames so we can verify
  // the SDK parses them correctly without needing a real model.

  it('POST /api/chat returns ChatResponse matching the Zod schema', async () => {
    // Register a one-shot chat fixture for this test only.
    server.register('/api/chat', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      chunks: [
        JSON.stringify({
          model: TEST_MODEL,
          created_at: '2026-10-05T00:00:00Z',
          message: { role: 'assistant', content: 'ok' },
          done: true,
          done_reason: 'stop',
          total_duration: 1_000_000_000,
          load_duration: 100_000_000,
          prompt_eval_count: 5,
          prompt_eval_duration: 200_000_000,
          eval_count: 1,
          eval_duration: 700_000_000,
        } satisfies ChatResponse),
      ],
    });

    const res = await api.chat({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly the word "ok".' }],
      stream: false,
      options: { temperature: 0 },
    });
    const parsed = ChatResponseSchema.safeParse(res);
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
    ).toBe(true);
    expect((res as ChatResponse).model).toBe(TEST_MODEL);
    expect((res as ChatResponse).done).toBe(true);
    expect((res as ChatResponse).message?.content).toBe('ok');
    expect((res as ChatResponse).done_reason).toBe('stop');
    // Telemetry fields are present and numeric
    expect(typeof (res as ChatResponse).total_duration).toBe('number');
    expect(typeof (res as ChatResponse).prompt_eval_count).toBe('number');
    expect(typeof (res as ChatResponse).eval_count).toBe('number');
  });

  it('POST /api/generate returns GenerateResponse matching the Zod schema', async () => {
    server.register('/api/generate', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      chunks: [
        JSON.stringify({
          model: TEST_MODEL,
          created_at: '2026-10-05T00:00:00Z',
          response: 'ok',
          done: true,
          done_reason: 'stop',
          context: [1, 2, 3],
          total_duration: 1_000_000_000,
          load_duration: 100_000_000,
          prompt_eval_count: 5,
          prompt_eval_duration: 200_000_000,
          eval_count: 1,
          eval_duration: 700_000_000,
        } satisfies GenerateResponse),
      ],
    });

    const res = await api.generate({
      model: TEST_MODEL,
      prompt: 'Reply with exactly the word "ok".',
      stream: false,
      options: { temperature: 0 },
    });
    const parsed = GenerateResponseSchema.safeParse(res);
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
    ).toBe(true);
    expect((res as GenerateResponse).model).toBe(TEST_MODEL);
    expect((res as GenerateResponse).done).toBe(true);
    expect(typeof (res as GenerateResponse).response).toBe('string');
    expect((res as GenerateResponse).response).toBe('ok');
    expect((res as GenerateResponse).done_reason).toBe('stop');
  });

  it('POST /api/embed returns EmbedResponse matching the Zod schema', async () => {
    server.register('/api/embed', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      chunks: [
        JSON.stringify({
          model: TEST_EMBED_MODEL,
          embeddings: [[0.1, 0.2, 0.3, 0.4]],
          total_duration: 100_000_000,
          load_duration: 50_000_000,
          prompt_eval_count: 2,
        } satisfies EmbedResponse),
      ],
    });

    const res = await api.embed({
      model: TEST_EMBED_MODEL,
      input: 'hello world',
    });
    const parsed = EmbedResponseSchema.safeParse(res);
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
    ).toBe(true);
    expect((res as EmbedResponse).model).toBe(TEST_EMBED_MODEL);
    expect(Array.isArray((res as EmbedResponse).embeddings)).toBe(true);
    expect((res as EmbedResponse).embeddings.length).toBe(1);
    expect((res as EmbedResponse).embeddings[0]?.length).toBe(4);
  });
});

describe('Native REST API offline wire-format conformance — streaming', () => {
  it('POST /api/chat streaming yields ChatResponse-shaped chunks matching the schema', async () => {
    // Multi-chunk streaming response. Each chunk must match the
    // ChatResponseSchema — the SDK should not crash on any
    // intermediate chunk, and the final chunk must carry done:true.
    server.register('/api/chat', {
      status: 200,
      chunks: [
        JSON.stringify({
          model: TEST_MODEL,
          created_at: '2026-10-05T00:00:00Z',
          message: { role: 'assistant', content: 'ok' },
          done: false,
        } satisfies ChatResponse),
        JSON.stringify({
          model: TEST_MODEL,
          created_at: '2026-10-05T00:00:01Z',
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          total_duration: 1_000_000_000,
          prompt_eval_count: 5,
          eval_count: 1,
        } satisfies ChatResponse),
      ],
    });

    const stream = await api.chat({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'Say "ok".' }],
      stream: true,
      options: { temperature: 0 },
    });
    const chunks: unknown[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);

    const last = chunks[chunks.length - 1] as ChatResponse;
    expect(last.done).toBe(true);

    // EVERY chunk (including the final done:true one) must match the
    // ChatResponse Zod schema — this is the wire-format conformance
    // guarantee.
    for (const chunk of chunks) {
      const parsed = ChatResponseSchema.safeParse(chunk);
      expect(
        parsed.success,
        parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
      ).toBe(true);
    }
  });

  it('POST /api/generate streaming yields GenerateResponse-shaped chunks matching the schema', async () => {
    server.register('/api/generate', {
      status: 200,
      chunks: [
        JSON.stringify({
          model: TEST_MODEL,
          created_at: '2026-10-05T00:00:00Z',
          response: 'ok',
          done: false,
        } satisfies GenerateResponse),
        JSON.stringify({
          model: TEST_MODEL,
          created_at: '2026-10-05T00:00:01Z',
          response: '',
          done: true,
          done_reason: 'stop',
          total_duration: 1_000_000_000,
          prompt_eval_count: 5,
          eval_count: 1,
        } satisfies GenerateResponse),
      ],
    });

    const stream = await api.generate({
      model: TEST_MODEL,
      prompt: 'Say "ok".',
      stream: true,
      options: { temperature: 0 },
    });
    const chunks: unknown[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);

    const last = chunks[chunks.length - 1] as GenerateResponse;
    expect(last.done).toBe(true);

    for (const chunk of chunks) {
      const parsed = GenerateResponseSchema.safeParse(chunk);
      expect(
        parsed.success,
        parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
      ).toBe(true);
    }
  });
});

describe('Native REST API offline wire-format conformance — error responses', () => {
  it('POST /api/chat with a 404 response surfaces as OllamaNotFoundError with the server-provided message', async () => {
    server.register('/api/chat', {
      status: 404,
      headers: { 'content-type': 'application/json' },
      chunks: [JSON.stringify({ error: 'model "ghost" not found' })],
    });

    await expect(
      api.chat({
        model: 'ghost',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    ).rejects.toMatchObject({
      name: 'OllamaNotFoundError',
      code: 'not_found',
      status: 404,
      message: 'model "ghost" not found',
    });
  });

  it('POST /api/chat with a 503 response surfaces as OllamaOverloadedError', async () => {
    server.register('/api/chat', {
      status: 503,
      headers: { 'content-type': 'application/json' },
      chunks: [JSON.stringify({ error: 'queue full' })],
    });

    await expect(
      api.chat({
        model: TEST_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    ).rejects.toMatchObject({
      name: 'OllamaOverloadedError',
      code: 'overloaded',
      status: 503,
      retryable: true,
    });
  });

  it('POST /api/chat streaming with an in-band {"error":"..."} frame surfaces as OllamaStreamError', async () => {
    server.register('/api/chat', {
      status: 200,
      chunks: [
        JSON.stringify({
          model: TEST_MODEL,
          created_at: '2026-10-05T00:00:00Z',
          message: { role: 'assistant', content: 'partial' },
          done: false,
        } satisfies ChatResponse),
        JSON.stringify({ error: 'GPU OOM mid-stream' }),
      ],
    });

    const stream = await api.chat({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    // The NativeApi's streaming path returns a raw AsyncGenerator
    // (from parseNdjsonStream), NOT the wrapped OllamaStream shape.
    // When parseNdjsonStream detects an in-band {"error":"..."} frame,
    // it throws OllamaStreamError directly into the for-await loop.
    // The error is NOT wrapped in an event — it's a thrown exception.
    const tokens: string[] = [];
    let caught: unknown;
    try {
      for await (const chunk of stream) {
        if (typeof chunk === 'object' && chunk !== null && 'message' in chunk) {
          const msg = (chunk as ChatResponse).message;
          if (msg?.content) tokens.push(msg.content);
        }
      }
    } catch (err) {
      caught = err;
    }

    // The partial token should have been delivered before the
    // error frame arrived.
    expect(tokens.join('')).toBe('partial');

    // The thrown error is an OllamaStreamError with the server's
    // error message preserved.
    expect(caught).toBeInstanceOf(Error);
    const streamErr = caught as Error & {
      code?: string;
      partialContent?: string;
    };
    expect(streamErr.message).toBe('GPU OOM mid-stream');
    expect(streamErr.code).toBe('stream_error');
    // The raw AsyncGenerator path (NativeApi) does NOT enrich
    // partialContent — that enrichment happens at the OllamaStream
    // wrapper layer (used by OllamaClient.chat, not NativeApi.chat).
    // The field is '' here.
    expect(streamErr.partialContent).toBe('');
  });
});

describe('Native REST API offline wire-format conformance — optional telemetry fields', () => {
  // The Wave 13 conformance fix (CI run #36962280416) flagged
  // optional telemetry fields (`prompt_eval_cached_count`, `thinking`,
  // `done_reason`) as the source of 4 failing annotations. These
  // tests verify the SDK does NOT throw when those fields are absent
  // — the documented wire-format allows them to be omitted.

  it('ChatResponse without prompt_eval_cached_count parses cleanly', async () => {
    server.register('/api/chat', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      chunks: [
        JSON.stringify({
          model: TEST_MODEL,
          created_at: '2026-10-05T00:00:00Z',
          message: { role: 'assistant', content: 'ok' },
          done: true,
          // prompt_eval_cached_count omitted — non-cached prompt
          total_duration: 1_000_000_000,
          prompt_eval_count: 5,
          eval_count: 1,
        } satisfies ChatResponse),
      ],
    });

    const res = await api.chat({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    const parsed = ChatResponseSchema.safeParse(res);
    expect(parsed.success).toBe(true);
    // The optional field is undefined, not null
    expect((res as ChatResponse).prompt_eval_cached_count).toBeUndefined();
  });

  it('ChatResponse without thinking parses cleanly (non-reasoning model)', async () => {
    server.register('/api/chat', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      chunks: [
        JSON.stringify({
          model: TEST_MODEL,
          created_at: '2026-10-05T00:00:00Z',
          message: { role: 'assistant', content: 'ok' },
          done: true,
          // thinking omitted — non-reasoning model
          // done_reason omitted — server didn't include it
          total_duration: 1_000_000_000,
          prompt_eval_count: 5,
          eval_count: 1,
        } satisfies ChatResponse),
      ],
    });

    const res = await api.chat({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    const parsed = ChatResponseSchema.safeParse(res);
    expect(parsed.success).toBe(true);
    expect((res as ChatResponse).message?.thinking).toBeUndefined();
    expect((res as ChatResponse).done_reason).toBeUndefined();
  });

  it('GenerateResponse with all optional fields omitted parses cleanly', async () => {
    server.register('/api/generate', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      chunks: [
        JSON.stringify({
          model: TEST_MODEL,
          created_at: '2026-10-05T00:00:00Z',
          response: 'ok',
          done: true,
          // All optional telemetry fields omitted
        } satisfies GenerateResponse),
      ],
    });

    const res = await api.generate({
      model: TEST_MODEL,
      prompt: 'hi',
      stream: false,
    });
    const parsed = GenerateResponseSchema.safeParse(res);
    expect(parsed.success).toBe(true);
    expect((res as GenerateResponse).thinking).toBeUndefined();
    expect((res as GenerateResponse).done_reason).toBeUndefined();
    expect((res as GenerateResponse).prompt_eval_cached_count).toBeUndefined();
    expect((res as GenerateResponse).logprobs).toBeUndefined();
  });
});

describe('Native REST API offline wire-format conformance — OllamaClient vs NativeApi parity', () => {
  // Mirrors the live parity tests in native-api.test.ts, but using
  // the mock server. Both surfaces should see the same wire format.

  it('chat() returns the same model field from both surfaces', async () => {
    server.register('/api/chat', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      chunks: [
        JSON.stringify({
          model: TEST_MODEL,
          created_at: '2026-10-05T00:00:00Z',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        } satisfies ChatResponse),
      ],
      // Two requests (legacy + generated) hit this route; both
      // get the same response. The mock server replays the same
      // chunks for every request to a registered route.
    });

    const legacy = await client.chat({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'Say "ok".' }],
      stream: false,
      options: { temperature: 0 },
    });
    const generated = await api.chat({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'Say "ok".' }],
      stream: false,
      options: { temperature: 0 },
    });
    expect(legacy.model).toBe(TEST_MODEL);
    expect(generated.model).toBe(TEST_MODEL);
    expect(legacy.done).toBe(true);
    expect(generated.done).toBe(true);
    // Both surfaces should produce identical content
    expect(legacy.message.content).toBe('ok');
    expect((generated as ChatResponse).message?.content).toBe('ok');
  });

  it('version() returns the same version from both surfaces', async () => {
    const legacy = await client.version();
    const generated = await api.version();
    expect(legacy.version).toBe('0.5.0');
    expect(generated.version).toBe('0.5.0');
  });
});

describe('Native REST API offline wire-format conformance — done_reason variants', () => {
  // The Wave 13 conformance fix added KnownDoneReason ('stop' |
  // 'length' | 'load' | 'unload') for safe narrowing. The Zod
  // schema accepts any string for forward-compat. These tests
  // verify each documented variant parses cleanly.

  const variants: ReadonlyArray<{ reason: string; description: string }> = [
    { reason: 'stop', description: 'natural stop token hit' },
    { reason: 'length', description: 'num_predict ceiling reached' },
    { reason: 'load', description: 'model load event in streaming' },
    { reason: 'unload', description: 'model unloaded via keep_alive:0' },
  ];

  for (const { reason, description } of variants) {
    it(`ChatResponse with done_reason="${reason}" parses cleanly (${description})`, async () => {
      server.register('/api/chat', {
        status: 200,
        headers: { 'content-type': 'application/json' },
        chunks: [
          JSON.stringify({
            model: TEST_MODEL,
            created_at: '2026-10-05T00:00:00Z',
            message: { role: 'assistant', content: 'ok' },
            done: true,
            done_reason: reason,
            total_duration: 1_000_000_000,
            prompt_eval_count: 5,
            eval_count: 1,
          } satisfies ChatResponse),
        ],
      });

      const res = await api.chat({
        model: TEST_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      const parsed = ChatResponseSchema.safeParse(res);
      expect(parsed.success).toBe(true);
      expect((res as ChatResponse).done_reason).toBe(reason);
    });
  }

  it('ChatResponse with an undocumented done_reason parses cleanly (forward-compat)', async () => {
    // Future Ollama versions may emit done_reason values not in
    // the KnownDoneReason union. The Zod schema accepts any string
    // for forward-compat — verify this with an unknown value.
    server.register('/api/chat', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      chunks: [
        JSON.stringify({
          model: TEST_MODEL,
          created_at: '2026-10-05T00:00:00Z',
          message: { role: 'assistant', content: 'ok' },
          done: true,
          done_reason: 'future_unknown_reason',
          total_duration: 1_000_000_000,
          prompt_eval_count: 5,
          eval_count: 1,
        } satisfies ChatResponse),
      ],
    });

    const res = await api.chat({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    const parsed = ChatResponseSchema.safeParse(res);
    expect(parsed.success).toBe(true);
    expect((res as ChatResponse).done_reason).toBe('future_unknown_reason');
    // The SDK's isKnownDoneReason type guard returns false for
    // unknown values — callers should use it to safely narrow.
    const { isKnownDoneReason } = await import('../../src/done-reason.js');
    expect(isKnownDoneReason((res as ChatResponse).done_reason)).toBe(false);
  });
});
