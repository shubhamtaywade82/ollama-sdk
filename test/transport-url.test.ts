import { describe, expect, it, vi } from 'vitest';
import { joinUrlPath } from '../src/transport/url.js';
import { HttpClient } from '../src/transport/http.js';
import { OllamaClient } from '../src/client.js';

/**
 * URL-01 hardening: reverse-proxy subpath bases must survive request-URL
 * assembly. The transport never uses `new URL(path, base)` (WHATWG semantics
 * discard the base's path segments for absolute paths); `joinUrlPath` owns
 * the join with an exactly-one-slash invariant, and these tests pin that
 * behavior at the unit, transport, and client levels — including the exact
 * `https://gateway.internal.corp/ai/ollama` scenario from the audit.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('joinUrlPath', () => {
  it.each([
    ['http://127.0.0.1:11434', '/api/chat', 'http://127.0.0.1:11434/api/chat'],
    // The audit's exact scenario: a gateway mount prefix must be preserved.
    [
      'https://gateway.internal.corp/ai/ollama',
      '/api/chat',
      'https://gateway.internal.corp/ai/ollama/api/chat',
    ],
    // Trailing slash on the base collapses instead of doubling.
    [
      'https://gateway.internal.corp/ai/ollama/',
      '/api/chat',
      'https://gateway.internal.corp/ai/ollama/api/chat',
    ],
    // Multiple slashes on either side collapse to exactly one.
    [
      'https://gateway.internal.corp/ai/ollama//',
      '//api/chat',
      'https://gateway.internal.corp/ai/ollama/api/chat',
    ],
    // A path missing its leading slash is still joined (hardening for future
    // call sites; every current call site passes a leading slash).
    ['https://gw.example/ollama', 'api/chat', 'https://gw.example/ollama/api/chat'],
    // Query strings ride along after the join untouched.
    [
      'https://gw.example/ollama/',
      '/api/usage?bucket=24h&range=7d',
      'https://gw.example/ollama/api/usage?bucket=24h&range=7d',
    ],
    // Empty path yields the base with trailing slashes stripped.
    ['https://gw.example/ollama/', '', 'https://gw.example/ollama'],
    // WHATWG hazard regression pin: unlike `new URL(path, base)`, the join
    // keeps `/ai/ollama` even though the path is absolute.
    [
      'http://proxy.internal:8080/ollama',
      '/api/chat',
      'http://proxy.internal:8080/ollama/api/chat',
    ],
  ])('joinUrlPath(%j, %j) → %j', (base, path, expected) => {
    expect(joinUrlPath(base, path)).toBe(expected);
  });

  it('is the inverse hazard of the WHATWG URL constructor it replaces', () => {
    // Documented in code review: the naive construction the audit warned
    // about. This test exists so the hazard stays visible.
    const base = 'https://gateway.internal.corp/ai/ollama';
    expect(new URL('/api/chat', base).toString()).toBe('https://gateway.internal.corp/api/chat');
    expect(joinUrlPath(base, '/api/chat')).toBe('https://gateway.internal.corp/ai/ollama/api/chat');
  });
});

describe('HttpClient URL assembly', () => {
  it('preserves a reverse-proxy subpath on request()', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    const http = new HttpClient({ baseUrl: 'https://gw.example/ai/ollama', fetch: fetchMock });
    await http.request({ path: '/api/chat', body: {} });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://gw.example/ai/ollama/api/chat');
  });

  it('preserves a reverse-proxy subpath and query strings together', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    const http = new HttpClient({ baseUrl: 'https://gw.example/ollama/', fetch: fetchMock });
    await http.request({ path: '/api/usage?bucket=24h&range=7d' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://gw.example/ollama/api/usage?bucket=24h&range=7d',
    );
  });

  it('preserves a reverse-proxy subpath on requestStream()', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          `${JSON.stringify({ model: 'm', message: { role: 'assistant', content: 'hi' }, done: true })}\n`,
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
        ),
      );
    const http = new HttpClient({ baseUrl: 'https://gw.example/ai/ollama', fetch: fetchMock });
    const stream = await http.requestStream({ path: '/api/chat', body: {} });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://gw.example/ai/ollama/api/chat');
    stream.abort?.();
  });
});

describe('OllamaClient end-to-end URL assembly through a gateway subpath', () => {
  it('routes native /api/chat under the mount prefix', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'llama3.2',
        created_at: '2026-10-09T00:00:00Z',
        message: { role: 'assistant', content: 'ok' },
        done: true,
      }),
    );
    const client = new OllamaClient({
      baseUrl: 'https://gateway.internal.corp/ai/ollama',
      fetch: fetchMock,
    });
    await client.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://gateway.internal.corp/ai/ollama/api/chat',
    );
  });

  it('routes native /api/generate under the mount prefix', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'llama3.2',
        created_at: '2026-10-09T00:00:00Z',
        response: 'ok',
        done: true,
      }),
    );
    const client = new OllamaClient({
      baseUrl: 'https://gateway.internal.corp/ai/ollama',
      fetch: fetchMock,
    });
    await client.generate({ model: 'llama3.2', prompt: 'hi' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://gateway.internal.corp/ai/ollama/api/generate',
    );
  });

  it('routes OpenAI-compat /v1/chat/completions under the mount prefix', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1760000000,
        model: 'llama3.2',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    const client = new OllamaClient({
      baseUrl: 'https://gateway.internal.corp/ai/ollama',
      fetch: fetchMock,
    });
    await client.openai.chatCompletions({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://gateway.internal.corp/ai/ollama/v1/chat/completions',
    );
  });

  it('normalizes a scheme-less gateway host with a subpath before joining', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'llama3.2',
        created_at: '2026-10-09T00:00:00Z',
        message: { role: 'assistant', content: 'ok' },
        done: true,
      }),
    );
    const client = new OllamaClient({ baseUrl: 'proxy.internal:8080/ollama/', fetch: fetchMock });
    await client.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://proxy.internal:8080/ollama/api/chat');
  });
});
