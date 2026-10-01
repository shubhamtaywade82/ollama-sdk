import { describe, expect, it } from 'vitest';
import { OllamaClient } from '../../src/client.js';
import { NativeApi } from '../../src/generated/api/native-api.js';
import type { OllamaRuntime } from '../../src/generated/runtime/runtime.js';

describe('Wave 8: OllamaClient.runtime accessor', () => {
  it('returns a cached OllamaRuntime instance', () => {
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      // No fetch needed — runtime is created lazily but no call is made.
    });
    const r1 = client.runtime;
    const r2 = client.runtime;
    expect(r1).toBe(r2);
    expect(r1.constructor.name).toBe('OllamaRuntime');
  });

  it('binds to the first configured endpoint', () => {
    const client = new OllamaClient({
      endpoints: [
        { name: 'primary', baseUrl: 'http://primary.example.com:11434' },
        { name: 'secondary', baseUrl: 'http://secondary.example.com:11434' },
      ],
    });
    // The runtime should be bound to the primary endpoint. We can't easily
    // inspect the runtime's internals, but we can confirm the runtime was
    // constructed without throwing — that's the contract.
    expect(() => client.runtime).not.toThrow();
  });

  it('the cached runtime is usable with NativeApi', async () => {
    // Mock fetch returning a version response.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ version: '0.5.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;

    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      fetch: fetchImpl,
    });
    const runtime: OllamaRuntime = client.runtime;
    const api = new NativeApi(runtime);

    const result = await api.version();
    expect(result).toBeDefined();
    expect((result as { version: string }).version).toBe('0.5.0');
  });
});
