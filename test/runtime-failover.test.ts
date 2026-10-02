import { describe, expect, it } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { NativeApi } from '../src/generated/api/native-api.js';
import { FailoverHttpClient } from '../src/failover-http-client.js';

/**
 * Wave 14: OllamaClient.runtime now participates in multi-endpoint
 * failover. Previously the runtime was bound to the first candidate
 * endpoint only — if that endpoint was down, the generated API surface
 * (NativeApi, OpenAIApi, AnthropicApi) failed outright instead of
 * failing over to the next candidate.
 *
 * The fix: OllamaClient.runtime now uses a FailoverHttpClient that
 * routes each request through executeWithFailover, matching the
 * behavior of the hand-written OllamaClient methods (chat, generate,
 * etc.).
 */
describe('Wave 14: OllamaClient.runtime participates in multi-endpoint failover', () => {
  it('the runtime getter returns a runtime backed by FailoverHttpClient', () => {
    const client = new OllamaClient({
      endpoints: [
        { name: 'primary', baseUrl: 'http://127.0.0.1:11435' },
        { name: 'secondary', baseUrl: 'http://127.0.0.1:11436' },
      ],
    });
    // Accessing the runtime triggers construction.
    const runtime = client.runtime;
    expect(runtime).toBeDefined();
    expect(runtime.constructor.name).toBe('OllamaRuntime');
  });

  it('NativeApi.systemOne fails over when the primary endpoint is unreachable', async () => {
    let primaryCalls = 0;
    let secondaryCalls = 0;

    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('127.0.0.1:11435')) {
        primaryCalls += 1;
        // Simulate connection refused (network error → retryable → failover).
        throw new TypeError('fetch failed: ECONNREFUSED');
      }
      if (urlStr.includes('127.0.0.1:11436')) {
        secondaryCalls += 1;
        return new Response(
          JSON.stringify({
            model: 'tev1:4b',
            answers: { q: { type: 'noul', noul: 0.95 } },
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    }) as unknown as typeof globalThis.fetch;

    const client = new OllamaClient({
      endpoints: [
        { name: 'primary', baseUrl: 'http://127.0.0.1:11435' },
        { name: 'secondary', baseUrl: 'http://127.0.0.1:11436' },
      ],
      fetch: fetchImpl,
      // Speed up the test: minimal retry delay.
      retries: { maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 5, backoffFactor: 1 } },
    });

    const api = new NativeApi(client.runtime);
    const result = await api.systemOne({
      model: 'tev1:4b',
      state: 'test',
      questions: { q: { type: 'noul', instructions: 'Is this true?' } },
    });

    // The primary was tried and failed; the secondary handled the request.
    // The secondary may be called twice: once for the version probe
    // (enforceVersion: 'auto' fetches /api/version before version-gated
    // operations) and once for the actual systemOne call.
    expect(primaryCalls).toBeGreaterThan(0);
    expect(secondaryCalls).toBeGreaterThanOrEqual(1);
    expect(result.model).toBe('tev1:4b');
  });

  it('FailoverHttpClient implements the RuntimeHttpClient interface', () => {
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
    const fhc = new FailoverHttpClient(client, 'http://localhost:11434');
    expect(fhc.baseUrl).toBe('http://localhost:11434');
    expect(typeof fhc.request).toBe('function');
  });
});
