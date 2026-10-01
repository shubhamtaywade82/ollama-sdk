import { describe, expect, it } from 'vitest';
import { NativeApi } from '../../src/generated/api/native-api.js';
import { OllamaRuntime } from '../../src/generated/runtime/runtime.js';
import { HttpClient } from '../../src/transport/http.js';
import {
  OllamaRequestTooLargeError,
  OllamaServerVersionUnknownError,
} from '../../src/errors.js';
import { systemOneOp } from '../../src/generated/api/operations.js';

/**
 * Wave 12 (P0 #5): behavioral constraints declared in the IR must be
 * enforced by the runtime, not just metadata. Two specific gaps were
 * called out:
 *
 *   - `maxRequestBytes` (System One: 64 KiB) was in the IR but never
 *     checked. The server returned 413; the runtime should fail fast
 *     client-side with a structured error.
 *   - `minOllamaVersion` was only checked when `serverVersion` was
 *     manually supplied. The runtime now lazily fetches `/api/version`
 *     so the constraint is actually enforced in real-world usage.
 */
describe('Wave 12: runtime enforces maxRequestBytes', () => {
  it('throws OllamaRequestTooLargeError (status 413) when body exceeds the limit', async () => {
    // Mock fetch — should never be called because the runtime must fail
    // before issuing the request.
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });
    const api = new NativeApi(runtime);

    // systemOne's contract declares maxRequestBytes: 65536. Build a body
    // that, when JSON-serialized, exceeds that. A single string field of
    // ~80 KiB is enough — the JSON envelope adds a small overhead.
    const oversized = 'x'.repeat(80 * 1024);
    await expect(
      api.systemOne({ model: 'm', state: oversized } as never),
    ).rejects.toBeInstanceOf(OllamaRequestTooLargeError);

    // The runtime must NOT have hit the network.
    expect(calls).toBe(0);

    // And the error should carry the structured fields.
    await expect(
      api.systemOne({ model: 'm', state: oversized } as never),
    ).rejects.toMatchObject({
      code: 'request_too_large',
      status: 413,
      operationId: 'systemOne',
      maxBytes: 65536,
    });
  });

  it('lets requests under the limit through', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ model: 'm', answers: {}, usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });
    const api = new NativeApi(runtime);

    await api.systemOne({ model: 'm', state: 'small' } as never);
    expect(calls).toBe(1);
  });
});

describe('Wave 12: runtime auto-fetches server version for minOllamaVersion gating', () => {
  it('enforceVersion: off — does not probe /api/version', async () => {
    let versionCalls = 0;
    let systemOneCalls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.endsWith('/api/version')) {
        versionCalls += 1;
        return new Response(JSON.stringify({ version: '0.34.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      systemOneCalls += 1;
      return new Response(JSON.stringify({ model: 'm', answers: {}, usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });
    const api = new NativeApi(runtime);

    // With enforceVersion off and no explicit serverVersion, systemOne
    // should be allowed through without a probe — the server will reject
    // if it can't handle it.
    await api.systemOne({ model: 'm', state: 's' } as never);
    expect(versionCalls).toBe(0);
    expect(systemOneCalls).toBe(1);
  });

  it('enforceVersion: strict — throws when /api/version is unreachable', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.endsWith('/api/version')) {
        // Real Ollama returns a JSON error body; mirror that so the
        // HttpClient's error-body parser doesn't trip over a non-JSON
        // 500 (which would mask the version-unknown error we're testing).
        return new Response(JSON.stringify({ error: 'internal server error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ model: 'm', answers: {}, usage: {} }), {
        status: 200,
      });
    }) as unknown as typeof globalThis.fetch;

    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'strict' });
    const api = new NativeApi(runtime);

    await expect(api.systemOne({ model: 'm', state: 's' } as never)).rejects.toBeInstanceOf(
      OllamaServerVersionUnknownError,
    );
  });

  it('enforceVersion: auto — caches /api/version across invocations', async () => {
    let versionCalls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.endsWith('/api/version')) {
        versionCalls += 1;
        return new Response(JSON.stringify({ version: '0.36.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ model: 'm', answers: {}, usage: {} }), {
        status: 200,
      });
    }) as unknown as typeof globalThis.fetch;

    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'auto' });
    const api = new NativeApi(runtime);

    await api.systemOne({ model: 'm', state: 's' } as never);
    await api.systemOne({ model: 'm', state: 's' } as never);
    await api.systemOne({ model: 'm', state: 's' } as never);
    // The version probe must happen exactly once across three calls.
    expect(versionCalls).toBe(1);
  });

  it('systemOneOp declares both constraints used in these tests', () => {
    // Pin the contract so this test file fails loud if the IR changes.
    expect(systemOneOp.constraints?.minOllamaVersion).toBe('0.35.0');
    expect(systemOneOp.constraints?.maxRequestBytes).toBe(65536);
  });
});
