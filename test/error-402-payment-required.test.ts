import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import {
  OllamaAuthError,
  OllamaGenericClientError,
  OllamaPaymentRequiredError,
} from '../src/errors.js';

/**
 * HTTP 402 → OllamaPaymentRequiredError — see `src/errors.ts`'s
 * `statusToError()`.
 *
 * 402 joined the documented response set on `/v1/systemone` with the
 * 2026-10-16 System One cloud launch (upstream d9b8601): the cloud
 * model isn't included in the Free plan, usage credits are needed, or
 * a payment failed.
 *
 * The dedicated subclass exists for the same reason 502/503 got theirs:
 * callers should branch on the failure mode rather than parse messages.
 * Billing is NOT a credentials problem — the natural recovery flow is
 * an upgrade/add-credits prompt, not an API-key re-prompt, so 402 is
 * deliberately distinct from OllamaAuthError (401/403).
 */

function mockFetchReturning(status: number, errorBody: unknown): typeof globalThis.fetch {
  // Real Response objects so HttpClient's body-reading pipeline works
  // under undici's strict checks (same rationale as the 502/503 tests).
  const fetchImpl: typeof globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(errorBody), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof globalThis.fetch;
  return vi.fn(fetchImpl) as unknown as typeof globalThis.fetch;
}

describe('error hierarchy: HTTP 402 → OllamaPaymentRequiredError', () => {
  it('maps a 402 response to OllamaPaymentRequiredError', async () => {
    const fetchImpl = mockFetchReturning(402, {
      error: "the cloud model isn't included in the Free plan",
    });
    const client = new OllamaClient({ baseUrl: 'http://x', fetch: fetchImpl });
    await expect(
      client.chat({
        model: 'clef:cloud',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    ).rejects.toBeInstanceOf(OllamaPaymentRequiredError);
  });

  it('carries code payment_required, status 402, and is not retryable', async () => {
    const fetchImpl = mockFetchReturning(402, { error: 'payment failed' });
    const client = new OllamaClient({ baseUrl: 'http://x', fetch: fetchImpl });
    const err: unknown = await client
      .chat({ model: 'clef:cloud', messages: [{ role: 'user', content: 'hi' }], stream: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OllamaPaymentRequiredError);
    expect(err).toMatchObject({
      code: 'payment_required',
      status: 402,
      retryable: false,
    });
  });

  it('is NOT an OllamaAuthError — billing, not credentials', async () => {
    const fetchImpl = mockFetchReturning(402, { error: 'add usage credits or upgrade' });
    const client = new OllamaClient({ baseUrl: 'http://x', fetch: fetchImpl });
    const err: unknown = await client
      .chat({ model: 'clef:cloud', messages: [{ role: 'user', content: 'hi' }], stream: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OllamaPaymentRequiredError);
    expect(err).not.toBeInstanceOf(OllamaAuthError);
    expect(err).not.toBeInstanceOf(OllamaGenericClientError);
  });

  it('surfaces on the documented /v1/systemone cloud path', async () => {
    // clef:cloud through /v1/systemone: the version probe passes
    // (0.41.0 ≥ 0.35.0), the decision call answers 402 — the exact
    // documented cloud-launch failure mode.
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/api/version')) {
        return new Response(JSON.stringify({ version: '0.41.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ error: "the cloud model isn't included in the Free plan" }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;
    const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    await expect(
      client.systemOne({
        model: 'clef:cloud',
        state: 'test',
        questions: { q: { type: 'noul', instructions: '?' } },
      }),
    ).rejects.toBeInstanceOf(OllamaPaymentRequiredError);
  });
});
