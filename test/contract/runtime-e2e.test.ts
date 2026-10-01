import { describe, expect, it } from 'vitest';
import { NativeApi } from '../../src/generated/api/native-api.js';
import { OllamaRuntime } from '../../src/generated/runtime/runtime.js';
import { HttpClient } from '../../src/transport/http.js';
import type { OllamaContract } from '../../generator/types.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const IR_PATH = resolve(PROJECT_ROOT, 'contracts/ir/ollama.ir.json');

function loadIR(): OllamaContract {
  return JSON.parse(readFileSync(IR_PATH, 'utf8')) as OllamaContract;
}

/**
 * Stand up a mock fetch that responds to a single recorded request.
 * Returns the captured request so the test can assert method/path/body.
 */
function mockFetch(
  response: unknown,
  status = 200,
): {
  fetchImpl: typeof globalThis.fetch;
  lastRequest: () => { method: string; url: string; body: string | undefined };
} {
  let captured: { method: string; url: string; body: string | undefined } | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    captured = {
      method: init?.method ?? 'GET',
      url: urlStr,
      body: init?.body !== undefined ? String(init.body) : undefined,
    };
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return {
    fetchImpl,
    lastRequest: () => {
      if (!captured) throw new Error('No request was captured');
      return captured;
    },
  };
}

describe('generated NativeApi: end-to-end runtime integration', () => {
  it('chat() sends POST /api/chat with the request body', async () => {
    const mock = mockFetch({
      model: 'gpt-4',
      message: { role: 'assistant', content: 'hi' },
      done: true,
    });
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: mock.fetchImpl,
    });
    const runtime = new OllamaRuntime({ http });
    const api = new NativeApi(runtime);

    await api.chat({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    });

    const req = mock.lastRequest();
    expect(req.method).toBe('POST');
    expect(req.url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(req.body ?? '{}') as { model: string; stream: boolean };
    expect(body.model).toBe('gpt-4');
    expect(body.stream).toBe(false);
  });

  it('embed() sends POST /api/embed with a non-streaming body', async () => {
    const mock = mockFetch({ model: 'nomic-embed-text', embeddings: [[0.1, 0.2, 0.3]] });
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: mock.fetchImpl });
    const runtime = new OllamaRuntime({ http });
    const api = new NativeApi(runtime);

    const result = await api.embed({
      model: 'nomic-embed-text',
      input: 'hello world',
    });

    expect(result).toBeDefined();
    const req = mock.lastRequest();
    expect(req.method).toBe('POST');
    expect(req.url).toBe('http://localhost:11434/api/embed');
    // embed() has no streamingDefault — body should NOT have `stream: true`.
    const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
    expect(body.stream).toBeUndefined();
  });

  it('version() sends GET /api/version with no request body', async () => {
    const mock = mockFetch({ version: '0.5.0' });
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: mock.fetchImpl });
    const runtime = new OllamaRuntime({ http });
    const api = new NativeApi(runtime);

    await api.version();

    const req = mock.lastRequest();
    expect(req.method).toBe('GET');
    expect(req.url).toBe('http://localhost:11434/api/version');
    expect(req.body).toBeUndefined();
  });
});

describe('generated NativeApi: contract guards', () => {
  it('rejects a local-only operation when the runtime is in cloud mode', async () => {
    const ir = loadIR();
    const systemOne = ir.operations.find((op) => op.id === 'systemOne');
    expect(systemOne?.environment.cloud).toBe(false);

    const mock = mockFetch({});
    const http = new HttpClient({ baseUrl: 'https://api.example.com', fetch: mock.fetchImpl });
    const runtime = new OllamaRuntime({ http, localMode: false });
    const api = new NativeApi(runtime);

    await expect(api.systemOne({ prompt: 'hello' } as never)).rejects.toThrow(
      /local-only and not supported in cloud mode/,
    );
  });

  it('rejects an operation requiring a newer server version', async () => {
    const mock = mockFetch({});
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: mock.fetchImpl });
    const runtime = new OllamaRuntime({ http, serverVersion: '0.34.0' });
    const api = new NativeApi(runtime);

    // systemOne requires minOllamaVersion 0.35.0 — should fail with 0.34.0.
    await expect(api.systemOne({ prompt: 'hello' } as never)).rejects.toThrow(
      /requires Ollama >= 0.35.0/,
    );
  });
});
