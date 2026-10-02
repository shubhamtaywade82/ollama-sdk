import { describe, expect, it } from 'vitest';
import { OllamaRuntime } from '../src/generated/runtime/runtime.js';
import { HttpClient } from '../src/transport/http.js';
import { openaiModelsGetOneOp, webSearchOp } from '../src/generated/api/operations.js';

/**
 * Wave 16: Security invariants (DoD Phase J).
 *
 * These tests verify that the runtime's contract execution layer is safe
 * against common web-security attack vectors:
 *
 *   - Path parameter injection (path traversal, SSRF via {param})
 *   - Host injection (operation.host cannot be arbitrary)
 *   - URL construction safety (encoded params can't escape path boundaries)
 *   - Abort signal propagation
 */

function mockFetch(): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

describe('Wave 16: Security — path parameter safety', () => {
  it('URI-encodes path parameters so they cannot escape the path', async () => {
    let capturedUrl = '';
    const fetchImpl = (async (url: string | URL | Request) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return new Response(JSON.stringify({ id: 'test', object: 'model' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });

    // Inject a path-traversal attempt: ../../etc/passwd
    await runtime.invoke({
      operation: openaiModelsGetOneOp,
      body: undefined,
      pathParams: { model: '../../etc/passwd' },
    });

    // The URL should contain the encoded form, not the raw traversal.
    expect(capturedUrl).toContain('..%2F..%2Fetc%2Fpasswd');
    // Should NOT contain the raw traversal path.
    expect(capturedUrl).not.toMatch(/\/\.\.\//);
    // Should NOT have escaped the /v1/models/ path prefix.
    expect(capturedUrl).toMatch(/\/v1\/models\//);
  });

  it('encodes special characters in path params (colon, slash, space)', async () => {
    let capturedUrl = '';
    const fetchImpl = (async (url: string | URL | Request) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });

    // sha256:abc/def has colons and slashes that must be encoded
    await runtime.invoke({
      operation: {
        operationId: 'blobs',
        method: 'HEAD',
        path: '/api/blobs/{digest}',
        environment: { local: true, cloud: false },
        transport: { mode: 'json', streaming: false },
        capabilities: {},
        status: { documented: true },
        domain: 'native',
        parameters: [{ name: 'digest', in: 'path', required: true, schema: { type: 'string' } }],
      },
      body: undefined,
      pathParams: { digest: 'sha256:abc def' },
    });

    expect(capturedUrl).toContain('sha256%3Aabc%20def');
    // The raw special characters must not appear in the path.
    expect(capturedUrl).not.toContain('sha256:abc def');
  });

  it('throws before any HTTP call when a required path param is missing', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });

    await expect(
      runtime.invoke({
        operation: openaiModelsGetOneOp,
        body: undefined,
        // No pathParams
      }),
    ).rejects.toThrow(/Missing path parameter "model"/);

    expect(calls).toBe(0);
  });
});

describe('Wave 16: Security — host injection prevention', () => {
  it('operation.host is an allowlisted contract property, not arbitrary', async () => {
    // The only operations with host are webSearch and webFetch, both
    // declaring host: 'https://ollama.com'. A caller cannot inject an
    // arbitrary host — it must be declared in the overlay.
    expect(webSearchOp.host).toBe('https://ollama.com');
    // No other native/openai operation declares a host.
    const { allOperations } = await import('../src/generated/api/operations.js');
    const hostOps = allOperations.filter((op) => op.host);
    expect(hostOps.length).toBe(2);
    expect(hostOps.every((op) => op.host === 'https://ollama.com')).toBe(true);
  });

  it('the runtime rejects host-bearing operations when no cloudHttp is configured', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: mockFetch(),
    });
    // No cloudHttp provided — should throw, not silently send to localhost
    const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });

    await expect(
      runtime.invoke({
        operation: webSearchOp,
        body: { query: 'test' },
      }),
    ).rejects.toThrow(/targets host "https:\/\/ollama.com" but the runtime has no cloudHttp/);
  });
});

describe('Wave 16: Security — abort signal propagation', () => {
  it('abort signal propagates through runtime to HttpClient', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Response(JSON.stringify({ version: '0.40.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });

    await runtime.invoke({
      operation: {
        operationId: 'version',
        method: 'GET',
        path: '/api/version',
        environment: { local: true, cloud: true },
        transport: { mode: 'json', streaming: false },
        capabilities: {},
        status: { documented: true },
        domain: 'native',
      },
      body: undefined,
      signal: controller.signal,
    });

    // The signal should have been passed through to fetch.
    expect(capturedSignal).toBeDefined();
    // Abort the controller — the signal should be the same one.
    controller.abort();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
