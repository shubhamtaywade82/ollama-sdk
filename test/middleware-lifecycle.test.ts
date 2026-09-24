import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { HttpClient } from '../src/transport/http.js';
import type { Middleware } from '../src/middleware.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('HTTP middleware', () => {
  it('runs request/response middleware around native requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'qwen3',
        created_at: 't',
        message: { role: 'assistant', content: 'hello' },
        done: true,
      }),
    );
    const phases: string[] = [];
    const middleware: Middleware = async ({ request, next }) => {
      phases.push(`before:${request.method}:${new URL(request.url).pathname}`);
      const response = await next();
      phases.push(`after:${response.status}`);
      return response;
    };

    const client = new OllamaClient({
      middleware: [middleware],
      fetch: fetchMock as never,
    });

    const result = await client.chat({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.message.content).toBe('hello');
    expect(phases).toEqual(['before:POST:/api/chat', 'after:200']);
  });

  it('applies middleware to OpenAI compatibility requests through the shared runner', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'chat_1',
        object: 'chat.completion',
        created: 1,
        model: 'qwen3',
        choices: [],
      }),
    );
    const seen: string[] = [];
    const middleware: Middleware = async ({ request, next }) => {
      seen.push(new URL(request.url).pathname);
      return next();
    };

    const client = new OllamaClient({
      middleware: [middleware],
      fetch: fetchMock as never,
    });

    await client.openai.chatCompletions({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(seen).toEqual(['/v1/chat/completions']);
  });

  it('can transform response metadata and body', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      middleware: [
        async ({ next }) => {
          const response = await next();
          return {
            ...response,
            status: 202,
            headers: { ...response.headers, 'X-Middleware': 'applied' },
            body: new Response(JSON.stringify({ ok: 'middleware' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          };
        },
      ],
      fetch: vi.fn().mockResolvedValue(jsonResponse({ ok: 'original' })) as never,
    });

    await expect(http.request<{ ok: string }>({ path: '/api/version' })).resolves.toEqual({
      ok: 'middleware',
    });
  });

  it('detects invalid middleware next() re-entry', async () => {
    const middleware: Middleware = async ({ next }) => {
      const first = await next();
      await expect(next()).rejects.toThrow('next() called multiple times in middleware');
      return first;
    };

    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      middleware: [middleware],
      fetch: vi.fn().mockResolvedValue(jsonResponse({ ok: true })) as never,
    });

    await expect(http.request({ path: '/api/version' })).resolves.toEqual({ ok: true });
  });
});

describe('Request lifecycle hooks', () => {
  it('emits start and success with one request id for an HTTP request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const events: Array<{ type: string; requestId: string }> = [];

    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      onLifecycleEvent: (event) => events.push({ type: event.type, requestId: event.requestId }),
      fetch: fetchMock as never,
    });

    await http.request({ path: '/api/version' });

    expect(events.map((event) => event.type)).toEqual(['start', 'success']);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
  });

  it('assigns a fresh lifecycle id to each standalone HttpClient request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const ids: string[] = [];
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      onLifecycleEvent: (event) => ids.push(event.requestId),
      fetch: fetchMock as never,
    });

    await http.request({ path: '/api/version' });
    await http.request({ path: '/api/version' });

    expect(new Set(ids).size).toBe(2);
  });

  it('emits retry events with the same logical id across retries', async () => {
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: 'temporary' }, 503);
      return jsonResponse({ ok: true });
    });

    const events: Array<{ type: string; requestId: string; attempt?: number }> = [];
    const client = new OllamaClient({
      retries: {
        maxRetries: 1,
        backoff: { initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 },
      },
      onLifecycleEvent: (event) =>
        events.push({
          type: event.type,
          requestId: event.requestId,
          ...('attempt' in event ? { attempt: event.attempt } : {}),
        }),
      fetch: fetchMock as never,
    });

    await client.chat({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(events.map((event) => event.type)).toEqual(['start', 'error', 'retry', 'start', 'success']);
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
    expect(events.find((event) => event.type === 'retry')?.attempt).toBe(1);
  });

  it('emits error when the transport fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    const events: string[] = [];

    const client = new OllamaClient({
      retries: 0,
      onLifecycleEvent: (event) => events.push(event.type),
      fetch: fetchMock as never,
    });

    await expect(
      client.chat({
        model: 'qwen3',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toThrow();

    expect(events).toContain('start');
    expect(events).toContain('error');
  });
});
