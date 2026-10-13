import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { OllamaStreamError } from '../src/errors.js';
import {
  createMockOllamaServer,
  mockChatChunk,
  mockTextChunks,
  mockToolCallChunks,
  OllamaMockServer,
} from '../src/testing/index.js';

/**
 * The public testing utility (`@nemesis-oss/ollama-sdk/testing`, ADR 0029):
 * the SDK's own mock engine promoted to a consumer-facing entry point, plus
 * the day-one conveniences — default liveness/version routes, request
 * recording, in-band mid-stream error injection, and NDJSON chunk builders
 * for chat text and (parallel) tool calls.
 *
 * The internal fixture (`test/mocks/ollama-mock-server.ts`) re-exports this
 * module, so mock-server.test.ts keeps the engine honest; this file pins
 * the *public* additions and the consumer round trips through OllamaClient.
 */

let server: OllamaMockServer;

beforeEach(() => {
  server = createMockOllamaServer();
});

afterEach(async () => {
  await server.stop();
});

describe('default routes', () => {
  it('answers the official liveness probe: client.ping() is healthy out of the box', async () => {
    await server.start();
    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const result = await client.ping();
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.baseUrl).toBe(server.baseUrl);
  });

  it('GET / answers the plain-text body "Ollama is running"', async () => {
    await server.start();
    const res = await fetch(server.baseUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('Ollama is running');
  });

  it('GET /api/version reports the configured version as JSON', async () => {
    const custom = createMockOllamaServer({ version: '0.99.9' });
    await custom.start();
    try {
      const res = await fetch(`${custom.baseUrl}/api/version`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ version: '0.99.9' });
    } finally {
      await custom.stop();
    }
  });

  it('defaults to version 0.14.0', async () => {
    await server.start();
    const res = await fetch(`${server.baseUrl}/api/version`);
    expect(await res.json()).toEqual({ version: '0.14.0' });
  });

  it('a registered route overrides the default (register() always wins)', async () => {
    await server.start();
    server.register('/api/version', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      chunks: [JSON.stringify({ version: 'custom-build' })],
    });
    const res = await fetch(`${server.baseUrl}/api/version`);
    expect(await res.json()).toEqual({ version: 'custom-build' });
  });

  it('defaultRoutes: false disables the built-ins (404 like any unregistered path)', async () => {
    const bare = createMockOllamaServer({ defaultRoutes: false });
    await bare.start();
    try {
      const version = await fetch(`${bare.baseUrl}/api/version`);
      expect(version.status).toBe(404);
      const root = await fetch(bare.baseUrl);
      expect(root.status).toBe(404);
      const ping = await fetch(bare.baseUrl, { method: 'HEAD' });
      expect(ping.status).toBe(404);
    } finally {
      await bare.stop();
    }
  });
});

describe('request recording', () => {
  it('records method, path, and parsed body in arrival order', async () => {
    await server.start();
    server.register('/api/chat', {
      chunks: [mockChatChunk({ content: 'hi', done: true })],
    });
    const client = new OllamaClient({ baseUrl: server.baseUrl });
    await client.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'q' }] });

    expect(server.requests).toHaveLength(1);
    const record = server.requests[0];
    expect(record?.method).toBe('POST');
    expect(record?.path).toBe('/api/chat');
    expect(record?.body).toMatchObject({ model: 'llama3.2', stream: false });
    expect(typeof record?.timestamp).toBe('string');
  });

  it('records default-route hits and 404s too (everything the client put on the wire)', async () => {
    await server.start();
    await fetch(server.baseUrl, { method: 'HEAD' }); // default route
    await fetch(`${server.baseUrl}/api/nope`); // 404
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'HEAD /',
      'GET /api/nope',
    ]);
    server.clearRequests();
    expect(server.requests).toHaveLength(0);
  });
});

describe('in-band mid-stream error injection (injectErrorFrame)', () => {
  it('appends the error frame after all chunks by default; the SDK raises OllamaStreamError', async () => {
    await server.start();
    server.register('/api/chat', {
      chunks: mockTextChunks('partial answer'),
      injectErrorFrame: { message: 'CUDA out of memory' },
    });

    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const stream = await client.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data.delta);
      if (event.type === 'error') break;
    }
    expect(tokens.join('')).toBe('partial answer');
    await expect(stream.finalResult).rejects.toBeInstanceOf(OllamaStreamError);
    await expect(stream.finalResult).rejects.toThrow('CUDA out of memory');
  });

  it('injects the frame mid-stream at `after: 1` and never emits the remaining chunks', async () => {
    await server.start();
    server.register('/api/chat', {
      chunks: [
        mockChatChunk({ content: 'first' }),
        mockChatChunk({ content: ' second' }),
        mockChatChunk({ content: ' third', done: true }),
      ],
      injectErrorFrame: { after: 1, message: 'driver reset' },
    });

    // Wire-level: status stays 200; the raw body is frame, error-frame, END.
    const raw = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ model: 'm' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(raw.status).toBe(200);
    const lines = (await raw.text()).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? '')).toEqual({ error: 'driver reset' });

    // Client-level: only the first frame's content is delivered.
    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const stream = await client.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data.delta);
      if (event.type === 'error') break;
    }
    expect(tokens).toEqual(['first']);
    await expect(stream.finalResult).rejects.toThrow('driver reset');
  });

  it('after: 0 emits the error frame before any content', async () => {
    await server.start();
    server.register('/api/chat', {
      chunks: mockTextChunks('never seen'),
      injectErrorFrame: { after: 0, message: 'model not loaded' },
    });
    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const stream = await client.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data.delta);
      if (event.type === 'error') break;
    }
    expect(tokens).toEqual([]);
    await expect(stream.finalResult).rejects.toThrow('model not loaded');
  });
});

describe('chunk builders', () => {
  it('mockChatChunk: sensible defaults (model, created_at, done:false, empty content)', () => {
    const frame = JSON.parse(mockChatChunk({})) as {
      model: string;
      created_at: string;
      message: { role: string; content: string };
      done: boolean;
    };
    expect(frame.model).toBe('mock-model');
    expect(Number.isNaN(Date.parse(frame.created_at))).toBe(false);
    expect(frame.message).toEqual({ role: 'assistant', content: '' });
    expect(frame.done).toBe(false);
  });

  it('mockChatChunk: tool calls are stringified with stable generated ids', () => {
    const frame = JSON.parse(
      mockChatChunk({
        toolCalls: [{ name: 'get_weather', arguments: { city: 'Tokyo' } }],
      }),
    ) as {
      message: { tool_calls: { id: string; function: { name: string; arguments: string } }[] };
    };
    expect(frame.message.tool_calls).toHaveLength(1);
    expect(frame.message.tool_calls[0]?.id).toBe('call-0');
    expect(frame.message.tool_calls[0]?.function.name).toBe('get_weather');
    expect(JSON.parse(frame.message.tool_calls[0]?.function.arguments ?? '')).toEqual({
      city: 'Tokyo',
    });
  });

  it('mockChatChunk: the done frame carries usage counters for telemetry paths', () => {
    const frame = JSON.parse(
      mockChatChunk({
        done: true,
        evalCount: 7,
        evalDurationNs: 70_000_000,
        promptEvalCount: 10,
        promptEvalCachedCount: 4,
        totalDurationNs: 150_000_000,
      }),
    ) as Record<string, unknown>;
    expect(frame['done']).toBe(true);
    expect(frame['eval_count']).toBe(7);
    expect(frame['eval_duration']).toBe(70_000_000);
    expect(frame['prompt_eval_count']).toBe(10);
    expect(frame['prompt_eval_cached_count']).toBe(4);
    expect(frame['total_duration']).toBe(150_000_000);
  });

  it('mockTextChunks splits by chunkSize and ends with a done frame; content reassembles', () => {
    const chunks = mockTextChunks('Hello, world!', { chunkSize: 5 });
    const parsed = chunks.map(
      (c) => JSON.parse(c) as { message: { content: string }; done: boolean },
    );
    // The final done frame carries no content — reassemble from the rest.
    expect(parsed.slice(0, -1).map((p) => p.message.content)).toEqual(['Hello', ', wor', 'ld!']);
    expect(parsed.slice(0, -1).every((p) => p.done === false)).toBe(true);
    expect(parsed.at(-1)?.done).toBe(true);
  });

  it('mockToolCallChunks: one frame carries the complete parallel tool_calls array, then done', () => {
    const chunks = mockToolCallChunks([
      { name: 'get_weather', arguments: { city: 'Tokyo' } },
      { id: 'explicit-id', name: 'get_time', arguments: { tz: 'Asia/Tokyo' } },
    ]);
    expect(chunks).toHaveLength(2);
    const first = JSON.parse(chunks[0] ?? '') as {
      message: { tool_calls: { id: string; function: { name: string; arguments: string } }[] };
      done: boolean;
    };
    expect(first.message.tool_calls).toHaveLength(2);
    expect(first.message.tool_calls[0]?.id).toBe('call-0');
    expect(first.message.tool_calls[1]?.id).toBe('explicit-id');
    expect(first.done).toBe(false);
    expect((JSON.parse(chunks[1] ?? '') as { done: boolean }).done).toBe(true);
  });
});

describe('consumer round trips through OllamaClient', () => {
  it('chat stream over mockTextChunks assembles the full reply', async () => {
    await server.start();
    server.register('/api/chat', { chunks: mockTextChunks('Hello, world!', { chunkSize: 5 }) });
    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const stream = await client.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data.delta);
    }
    const final = await stream.finalResult;
    expect(tokens.join('')).toBe('Hello, world!');
    expect(final.message.content).toBe('Hello, world!');
  });

  it('non-streaming chat returns the parallel tool_calls exactly as registered', async () => {
    await server.start();
    server.register('/api/chat', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      chunks: [
        JSON.stringify({
          model: 'llama3.2',
          created_at: '2026-10-12T00:00:00Z',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'get_weather', arguments: { city: 'Tokyo' } } },
              { function: { name: 'get_time', arguments: { tz: 'Asia/Tokyo' } } },
            ],
          },
          done: true,
          done_reason: 'stop',
        }),
      ],
    });
    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const res = await client.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'weather and time in Tokyo?' }],
    });
    const calls = res.message.tool_calls ?? [];
    expect(calls).toHaveLength(2);
    expect(calls[0]?.function.name).toBe('get_weather');
    expect(calls[0]?.function.arguments).toEqual({ city: 'Tokyo' });
    expect(calls[1]?.function.name).toBe('get_time');
    expect(calls[1]?.function.arguments).toEqual({ tz: 'Asia/Tokyo' });
  });

  it('streaming chat over mockToolCallChunks aggregates the parallel calls into finalResult', async () => {
    await server.start();
    server.register('/api/chat', {
      chunks: mockToolCallChunks([
        { name: 'get_weather', arguments: { city: 'Tokyo' } },
        { name: 'get_time', arguments: { tz: 'Asia/Tokyo' } },
      ]),
    });
    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const stream = await client.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'weather and time in Tokyo?' }],
      stream: true,
    });
    // Consume the stream (it's lazy — finalResult resolves after iteration).
    const toolCallEvents: string[] = [];
    for await (const event of stream) {
      if (event.type === 'tool_call') toolCallEvents.push(event.data.toolCall.function.name);
    }
    expect(toolCallEvents).toEqual(['get_weather', 'get_time']);
    const final = await stream.finalResult;
    const calls = final.message.tool_calls ?? [];
    expect(calls).toHaveLength(2);
    expect(calls[0]?.function.name).toBe('get_weather');
    // Streaming aggregation preserves the wire's string-encoded arguments.
    expect(JSON.parse(String(calls[0]?.function.arguments))).toEqual({ city: 'Tokyo' });
    expect(calls[1]?.function.name).toBe('get_time');
    expect(JSON.parse(String(calls[1]?.function.arguments))).toEqual({ tz: 'Asia/Tokyo' });
  });

  it('healthCheck-style flows work against the default version route', async () => {
    await server.start();
    const res = await fetch(`${server.baseUrl}/api/version`);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ version: '0.14.0' });
  });
});

describe('lifecycle', () => {
  it('factory + start/stop; stop() is idempotent', async () => {
    expect(server.requests).toHaveLength(0);
    await server.start();
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await server.stop();
    await server.stop(); // no ERR_SERVER_NOT_RUNNING
  });

  it('constructor accepts a plain port number for back-compatibility', async () => {
    const numeric = new OllamaMockServer(0);
    await numeric.start();
    try {
      expect(numeric.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await numeric.stop();
    }
  });
});

describe('request-aware routes (responder)', () => {
  it('computes the response from the request body (draft-aware payloads)', async () => {
    await server.start();
    server.register('/api/generate', {
      responder: (record) => {
        const draft =
          (record.body as { options?: { draft_num_predict?: number } }).options
            ?.draft_num_predict ?? 0;
        return {
          chunks: [
            JSON.stringify({
              model: 'm',
              created_at: '2026-10-13T00:00:00.000Z',
              response: draft > 0 ? 'drafted' : 'plain',
              done: true,
            }),
          ],
        };
      },
    });

    const post = (draft: number) =>
      fetch(`${server.baseUrl}/api/generate`, {
        method: 'POST',
        body: JSON.stringify({ model: 'm', options: { draft_num_predict: draft } }),
        headers: { 'content-type': 'application/json' },
      });

    expect(await (await post(0)).json()).toMatchObject({ response: 'plain' });
    expect(await (await post(8)).json()).toMatchObject({ response: 'drafted' });
  });

  it('returning undefined falls back to the static route fields (fail twice, then serve)', async () => {
    await server.start();
    let hits = 0;
    server.register('/api/chat', {
      chunks: [mockChatChunk({ content: 'recovered', done: true })],
      responder: () =>
        hits++ < 2 ? { status: 503, chunks: ['{"error":"server queue is full"}'] } : undefined,
    });

    const post = () =>
      fetch(`${server.baseUrl}/api/chat`, {
        method: 'POST',
        body: JSON.stringify({ model: 'm' }),
        headers: { 'content-type': 'application/json' },
      });

    expect((await post()).status).toBe(503);
    expect((await post()).status).toBe(503);
    const third = await post();
    expect(third.status).toBe(200);
    expect(await third.json()).toMatchObject({ message: { content: 'recovered' } });
  });

  it('composes with injectErrorFrame — responder-supplied frames still crash mid-stream', async () => {
    await server.start();
    server.register('/api/chat', {
      responder: () => ({
        chunks: mockTextChunks('partial answer'),
        injectErrorFrame: { message: 'CUDA out of memory' },
      }),
    });

    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const stream = await client.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data.delta);
      if (event.type === 'error') break;
    }
    expect(tokens.join('')).toBe('partial answer');
    await expect(stream.finalResult).rejects.toThrow('CUDA out of memory');
  });

  it('recording and onRequest still fire for responder routes', async () => {
    await server.start();
    const seen: unknown[] = [];
    server.register('/api/chat', {
      onRequest: (body) => seen.push(body),
      responder: () => ({ chunks: [mockChatChunk({ content: 'hi', done: true })] }),
    });

    const client = new OllamaClient({ baseUrl: server.baseUrl });
    await client.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'q' }] });

    expect(seen).toHaveLength(1);
    const record = server.requests.at(-1);
    expect(record?.method).toBe('POST');
    expect(record?.path).toBe('/api/chat');
    expect(record?.body).toMatchObject({ model: 'llama3.2', stream: false });
  });

  it('default routes keep answering while a responder route is registered elsewhere', async () => {
    await server.start();
    server.register('/api/generate', {
      responder: () => ({
        chunks: [JSON.stringify({ model: 'm', response: 'x', done: true })],
      }),
    });

    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const ping = await client.ping();
    expect(ping.healthy).toBe(true);
  });
});
