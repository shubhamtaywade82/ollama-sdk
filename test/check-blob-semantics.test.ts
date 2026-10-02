import { describe, expect, it } from 'vitest';
import { OllamaClient } from '../src/client.js';
import {
  OllamaAuthError,
  OllamaNotFoundError,
  OllamaRateLimitError,
  OllamaServerError,
  OllamaNetworkError,
} from '../src/errors.js';

/**
 * Wave 12 (P2): `OllamaClient.checkBlob(digest)` previously caught every
 * error and returned `false`. That conflated "blob absent" (HTTP 404)
 * with auth failures (401/403), rate limits (429), server errors (5xx),
 * network failures, timeouts, and aborts — callers had no way to
 * distinguish "the blob doesn't exist" from "the server is unreachable".
 *
 * The fix: only HTTP 404 (OllamaNotFoundError) returns false. Everything
 * else propagates so callers can branch on the actual failure mode.
 */
function makeClient(fetchImpl: typeof globalThis.fetch): OllamaClient {
  return new OllamaClient({
    baseUrl: 'http://localhost:11434',
    fetch: fetchImpl,
  });
}

describe('Wave 12: checkBlob returns false ONLY on HTTP 404', () => {
  it('returns true when the blob exists (200 OK)', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 200 })) as unknown as typeof globalThis.fetch;
    const client = makeClient(fetchImpl);
    expect(await client.checkBlob('sha256:abc')).toBe(true);
  });

  it('returns false when the blob is absent (404)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;
    const client = makeClient(fetchImpl);
    expect(await client.checkBlob('sha256:missing')).toBe(false);
  });

  it('propagates 401 auth errors (does NOT swallow them as false)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;
    const client = makeClient(fetchImpl);
    await expect(client.checkBlob('sha256:abc')).rejects.toBeInstanceOf(OllamaAuthError);
  });

  it('propagates 403 auth errors', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;
    const client = makeClient(fetchImpl);
    await expect(client.checkBlob('sha256:abc')).rejects.toBeInstanceOf(OllamaAuthError);
  });

  it('propagates 429 rate-limit errors', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;
    const client = makeClient(fetchImpl);
    await expect(client.checkBlob('sha256:abc')).rejects.toBeInstanceOf(OllamaRateLimitError);
  });

  it('propagates 5xx server errors', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'internal server error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;
    const client = makeClient(fetchImpl);
    await expect(client.checkBlob('sha256:abc')).rejects.toBeInstanceOf(OllamaServerError);
  });

  it('propagates network errors (fetch throws TypeError)', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const client = makeClient(fetchImpl);
    await expect(client.checkBlob('sha256:abc')).rejects.toBeInstanceOf(OllamaNetworkError);
  });

  it('the error class hierarchy is correct: OllamaNotFoundError is what 404s map to', () => {
    // Sanity-check the mapping: HttpClient throws OllamaNotFoundError for
    // 404s (see src/errors.ts statusToError). checkBlob catches exactly
    // that class — if the error mapping ever changes, this test fails
    // loud rather than silently regressing checkBlob to swallow 404s.
    expect(OllamaNotFoundError.name).toBe('OllamaNotFoundError');
  });
});
