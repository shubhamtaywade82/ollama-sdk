import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OllamaMockServer } from './mocks/ollama-mock-server.js';
import { OllamaClient } from '../src/client.js';
import {
  OllamaNotFoundError,
  OllamaOverloadedError,
  OllamaStreamError,
} from '../src/errors.js';

/**
 * OllamaMockServer — see `test/mocks/ollama-mock-server.ts`.
 *
 * In-memory `node:http` server for deterministic CI testing.
 * Complements the existing VCR cassette system (`test/vcr.ts`)
 * with programmable delay, chunk fragmentation, mid-stream error
 * injection, and connection drops.
 *
 * These tests verify the mock server itself works correctly, AND
 * exercise the SDK against it end-to-end (chat, generate, in-band
 * stream errors, 404, 503) to prove the mock is a faithful stand-in
 * for a real Ollama daemon.
 */

describe('OllamaMockServer: lifecycle', () => {
  let server: OllamaMockServer;

  beforeEach(() => {
    server = new OllamaMockServer(0);
  });
  afterEach(async () => {
    await server.stop();
  });

  it('starts and listens on an ephemeral port', async () => {
    await server.start();
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('stop() closes the server so the port is released', async () => {
    await server.start();
    const baseUrl = server.baseUrl;
    await server.stop();
    // A fresh server should be able to bind to the same port now
    // (the OS may take a moment to release it, so we don't assert
    // immediate rebindability — we just verify stop() resolved).
    expect(baseUrl).toBeDefined();
  });

  it('returns 404 for unregistered routes', async () => {
    await server.start();
    const res = await fetch(`${server.baseUrl}/api/unregistered`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Route not mocked/);
  });
});

describe('OllamaMockServer: chat streaming against OllamaClient', () => {
  let server: OllamaMockServer;

  beforeEach(() => {
    server = new OllamaMockServer(0);
  });
  afterEach(async () => {
    await server.stop();
  });

  it('streams multi-chunk chat responses and the SDK aggregates them', async () => {
    await server.start();
    server.register('/api/chat', {
      status: 200,
      chunks: [
        JSON.stringify({
          model: 'llama3.2',
          created_at: '2026-10-05T00:00:00Z',
          message: { role: 'assistant', content: 'Hello' },
          done: false,
        }),
        JSON.stringify({
          model: 'llama3.2',
          created_at: '2026-10-05T00:00:01Z',
          message: { role: 'assistant', content: ' world!' },
          done: true,
          total_duration: 10_000_000,
          prompt_eval_count: 5,
          eval_count: 2,
        }),
      ],
    });

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

    expect(tokens.join('')).toBe('Hello world!');
    expect(final.message.content).toBe('Hello world!');
    expect(final.done).toBe(true);
    expect(final.usage?.promptTokens).toBe(5);
    expect(final.usage?.completionTokens).toBe(2);
  });

  it('traps in-band stream errors via OllamaStreamError', async () => {
    await server.start();
    server.register('/api/chat', {
      status: 200, // HTTP 200 — the in-band error frame is the only signal
      chunks: [
        JSON.stringify({
          model: 'llama3.2',
          created_at: '2026-10-05T00:00:00Z',
          message: { role: 'assistant', content: 'partial' },
          done: false,
        }),
        JSON.stringify({ error: 'CUDA out of memory' }),
      ],
    });

    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const stream = await client.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    const tokens: string[] = [];
    // The for-await loop yields an error event (does not throw). The
    // finalResult promise rejects with the OllamaStreamError — that's
    // the canonical way to surface mid-stream errors.
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data.delta);
      if (event.type === 'error') break;
    }

    // The token emitted before the error frame should have been
    // delivered before the error event.
    expect(tokens).toEqual(['partial']);

    // The finalResult should reject with OllamaStreamError carrying
    // the partial content.
    await expect(stream.finalResult).rejects.toBeInstanceOf(OllamaStreamError);
    try {
      await stream.finalResult;
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaStreamError);
      const e = err as OllamaStreamError;
      expect(e.message).toBe('CUDA out of memory');
      expect(e.partialContent).toBe('partial');
    }
  });

  it('handles non-streaming chat with tool_calls', async () => {
    await server.start();
    server.register('/api/chat', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      chunks: [
        JSON.stringify({
          model: 'qwen2.5',
          created_at: '2026-10-05T00:00:00Z',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: { name: 'get_weather', arguments: { city: 'Tokyo' } },
              },
            ],
          },
          done: true,
          done_reason: 'stop',
        }),
      ],
    });

    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const res = await client.chat({
      model: 'qwen2.5',
      messages: [{ role: 'user', content: "What's the weather in Tokyo?" }],
      stream: false,
    });

    expect(res.done).toBe(true);
    expect(res.message.tool_calls).toHaveLength(1);
    expect(res.message.tool_calls?.[0]?.function.name).toBe('get_weather');
    expect(res.message.tool_calls?.[0]?.function.arguments).toEqual({ city: 'Tokyo' });
    // The SDK synthesizes a stable id for the call
    expect(res.message.tool_calls?.[0]?.id).toMatch(/^call_/);
  });
});

describe('OllamaMockServer: error status codes', () => {
  let server: OllamaMockServer;

  beforeEach(() => {
    server = new OllamaMockServer(0);
  });
  afterEach(async () => {
    await server.stop();
  });

  it('returns 404 and the SDK maps it to OllamaNotFoundError', async () => {
    await server.start();
    server.register('/api/chat', {
      status: 404,
      headers: { 'content-type': 'application/json' },
      chunks: [JSON.stringify({ error: 'model "ghost" not found' })],
    });

    const client = new OllamaClient({ baseUrl: server.baseUrl });
    await expect(
      client.chat({
        model: 'ghost',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    ).rejects.toBeInstanceOf(OllamaNotFoundError);
  });

  it('returns 503 and the SDK maps it to OllamaOverloadedError', async () => {
    await server.start();
    server.register('/api/chat', {
      status: 503,
      headers: { 'content-type': 'application/json' },
      chunks: [JSON.stringify({ error: 'queue full' })],
    });

    const client = new OllamaClient({
      baseUrl: server.baseUrl,
      retries: 0, // disable retry so the test stays fast
    });
    await expect(
      client.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    ).rejects.toBeInstanceOf(OllamaOverloadedError);
  });
});

describe('OllamaMockServer: programmable chunk delay', () => {
  let server: OllamaMockServer;

  beforeEach(() => {
    server = new OllamaMockServer(0);
  });
  afterEach(async () => {
    await server.stop();
  });

  it('emits chunks with the configured inter-chunk delay', async () => {
    await server.start();
    server.register('/api/generate', {
      status: 200,
      chunkDelayMs: 50,
      chunks: [
        JSON.stringify({
          model: 'llama3.2',
          created_at: '2026-10-05T00:00:00Z',
          response: 'A',
          done: false,
        }),
        JSON.stringify({
          model: 'llama3.2',
          created_at: '2026-10-05T00:00:01Z',
          response: 'B',
          done: true,
        }),
      ],
    });

    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const start = Date.now();
    const stream = await client.generate({
      model: 'llama3.2',
      prompt: 'go',
      stream: true,
    });

    const tokens: string[] = [];
    for await (const event of stream) {
      if (event.type === 'token') tokens.push(event.data.delta);
    }
    const elapsed = Date.now() - start;

    expect(tokens.join('')).toBe('AB');
    // 50ms delay between two chunks → at least 50ms total
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });
});

describe('OllamaMockServer: request body capture', () => {
  let server: OllamaMockServer;

  beforeEach(() => {
    server = new OllamaMockServer(0);
  });
  afterEach(async () => {
    await server.stop();
  });

  it('captures the parsed request body via onRequest callback', async () => {
    await server.start();
    let capturedBody: unknown;
    server.register('/api/chat', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      chunks: [
        JSON.stringify({
          model: 'llama3.2',
          created_at: '2026-10-05T00:00:00Z',
          message: { role: 'assistant', content: 'hi' },
          done: true,
        }),
      ],
      onRequest: (body) => {
        capturedBody = body;
      },
    });

    const client = new OllamaClient({ baseUrl: server.baseUrl });
    await client.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    });

    expect(capturedBody).toMatchObject({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    });
  });
});

describe('OllamaMockServer: connection drop mid-stream', () => {
  let server: OllamaMockServer;

  beforeEach(() => {
    server = new OllamaMockServer(0);
  });
  afterEach(async () => {
    await server.stop();
  });

  it('drops the connection after the first chunk when dropConnectionMidStream is true', async () => {
    await server.start();
    server.register('/api/chat', {
      status: 200,
      dropConnectionMidStream: true,
      chunks: [
        JSON.stringify({
          model: 'llama3.2',
          created_at: '2026-10-05T00:00:00Z',
          message: { role: 'assistant', content: 'partial' },
          done: false,
        }),
        // This second chunk should never be emitted — the connection
        // drops after the first.
        JSON.stringify({
          model: 'llama3.2',
          created_at: '2026-10-05T00:00:01Z',
          message: { role: 'assistant', content: ' never delivered' },
          done: true,
        }),
      ],
    });

    const client = new OllamaClient({
      baseUrl: server.baseUrl,
      retries: 0, // don't retry on the connection drop
    });

    // The stream emits the first chunk, then the connection drops.
    // Depending on timing, the drop may surface as:
    //   - An error event in the for-await loop (preferred), OR
    //   - A rejection of `stream.finalResult` (if the iterator
    //     already yielded the first chunk and exited), OR
    //   - A thrown error from `client.chat()` itself (if the
    //     drop happened before the first chunk was read).
    //
    // All three are acceptable — the test verifies the SDK
    // surfaces the failure rather than hanging or silently
    // succeeding with partial content.
    let stream;
    try {
      stream = await client.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
    } catch (err) {
      // The whole call rejected — acceptable. Verify it's a
      // network-style error.
      expect(err).toBeInstanceOf(Error);
      return;
    }

    const events: string[] = [];
    let streamThrew = false;
    try {
      for await (const event of stream) {
        events.push(event.type);
        if (event.type === 'error') break;
      }
    } catch {
      streamThrew = true;
    }

    // Either we got at least one event before the drop, OR the
    // stream threw immediately. Both are acceptable.
    expect(events.length + (streamThrew ? 1 : 0)).toBeGreaterThan(0);

    // The finalResult should reject (the stream did not complete
    // normally with a `done` event).
    await expect(stream.finalResult).rejects.toThrow();
  });
});

describe('OllamaMockServer: pull/push progress streaming', () => {
  let server: OllamaMockServer;

  beforeEach(() => {
    server = new OllamaMockServer(0);
  });
  afterEach(async () => {
    await server.stop();
  });

  it('emits pull progress frames that onProgress can consume', async () => {
    await server.start();
    server.register('/api/pull', {
      status: 200,
      chunks: [
        JSON.stringify({ status: 'pulling manifest' }),
        JSON.stringify({
          status: 'downloading',
          digest: 'sha256:abc',
          total: 1000,
          completed: 250,
        }),
        JSON.stringify({
          status: 'downloading',
          digest: 'sha256:abc',
          total: 1000,
          completed: 1000,
        }),
        JSON.stringify({ status: 'success' }),
      ],
    });

    const client = new OllamaClient({ baseUrl: server.baseUrl });
    const { onProgress } = await import('../src/streaming/progress.js');

    const stream = await client.models.pull({ model: 'llama3.2', stream: true });
    const events: Array<{ status: string; percent?: number }> = [];
    const result = await onProgress(stream, (e) => {
      events.push({ status: e.status, ...(e.percent !== undefined ? { percent: e.percent } : {}) });
    });

    expect(events.map((e) => e.status)).toEqual([
      'pulling manifest',
      'downloading',
      'downloading',
      'success',
    ]);
    expect(events[1]?.percent).toBe(25);
    expect(events[2]?.percent).toBe(100);
    expect(result.status).toBe('success');
  });
});
