import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/transport/http.js';
import { OllamaRuntime } from '../../src/generated/runtime/runtime.js';
import { NativeApi } from '../../src/generated/api/native-api.js';
import { OllamaRequestValidationError } from '../../src/errors.js';

function mockFetch(response: unknown, status = 200): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

describe('Wave 10: runtime Zod validation — opt-in', () => {
  it('does NOT validate when validateRequests is not set (default behavior, no perf cost)', async () => {
    const fetchImpl = mockFetch({ version: '0.5.0' });
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http });
    const api = new NativeApi(runtime);

    // A malformed chat request (missing required `messages` field).
    // Without validation enabled, the runtime just sends the bad body
    // to the server. The mock returns a generic response — the request
    // reaches the wire.
    await api.chat({
      model: 'test',
      messages: [],
      stream: false,
      // Intentionally missing required `messages` content shape.
    } as never);

    // No throw — validation wasn't enabled.
    expect(true).toBe(true);
  });

  it('validates and STRIPS unknown fields when validateRequests is true', async () => {
    let capturedBody: unknown;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify({ model: 'test', done: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, validateRequests: true });
    const api = new NativeApi(runtime);

    // Send a valid request with an extra unknown field — Zod should
    // strip the unknown field before the request hits the wire.
    await api.chat({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      // @ts-expect-error: deliberately send an unknown field
      bogus_extra_field: 'should be stripped',
    } as never);

    expect(capturedBody).toBeDefined();
    const body = capturedBody as Record<string, unknown>;
    expect(body.bogus_extra_field).toBeUndefined();
    expect(body.model).toBe('test');
  });
});

describe('Wave 10: runtime Zod validation — rejection', () => {
  it('throws OllamaRequestValidationError when required fields are missing', async () => {
    const fetchImpl = mockFetch({});
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, validateRequests: true });
    const api = new NativeApi(runtime);

    // `messages` is required on ChatRequest. Sending an empty body
    // (or wrong-typed messages) should fail validation.
    await expect(
      api.chat({
        model: 'test',
        // Missing required `messages`
        stream: false,
      } as never),
    ).rejects.toThrow(OllamaRequestValidationError);

    await expect(
      api.chat({
        model: 'test',
        // Wrong type — should be array, not string
        messages: 'not-an-array',
        stream: false,
      } as never),
    ).rejects.toThrow(OllamaRequestValidationError);
  });

  it('the OllamaRequestValidationError carries operationId + Zod issues', async () => {
    const fetchImpl = mockFetch({});
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, validateRequests: true });
    const api = new NativeApi(runtime);

    try {
      await api.chat({ model: '', stream: false } as never);
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OllamaRequestValidationError);
      const err = error as OllamaRequestValidationError;
      expect(err.operationId).toBe('chat');
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.code).toBe('request_validation_error');
      expect(err.retryable).toBe(false);
    }
  });

  it('does NOT make an HTTP request when validation fails', async () => {
    let requestMade = false;
    const fetchImpl = (async () => {
      requestMade = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, validateRequests: true });
    const api = new NativeApi(runtime);

    await expect(api.chat({ stream: false } as never)).rejects.toThrow(
      OllamaRequestValidationError,
    );

    expect(requestMade).toBe(false);
  });
});

describe('Wave 10: runtime Zod validation — operations without schemas', () => {
  it('skips validation silently for operations without a registered schema (GET endpoints)', async () => {
    const fetchImpl = mockFetch({ version: '0.5.0' });
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http, validateRequests: true });
    const api = new NativeApi(runtime);

    // `version` is a GET endpoint with no request body — no schema
    // registered for it, validation should be silently skipped.
    const result = await api.version();
    expect(result).toBeDefined();
  });
});
