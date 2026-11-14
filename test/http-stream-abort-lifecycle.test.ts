import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/transport/http.js';
import { OllamaAbortError, OllamaNetworkError } from '../src/errors.js';

/**
 * Regression pins for AbortSignal listener lifecycle on stream initialization
 * (review finding F2).
 *
 * The transport bridges the caller's signal into a private AbortController by
 * registering an `abort` listener BEFORE awaiting fetch. Pre-fix, a rejected
 * fetch left that listener attached to the caller's long-lived signal, because
 * the cleanup handle was scoped inside the `try` block. These tests spy on the
 * real signal's listener registration and assert add/remove pairing.
 */

const BASE_URL = 'http://localhost:11434';

/** Wraps a real AbortSignal so every listener add/remove is observable. */
function observedSignal(): {
  signal: AbortSignal;
  controller: AbortController;
  added: Array<{ type: string; listener: unknown }>;
  removed: Array<{ type: string; listener: unknown }>;
} {
  const controller = new AbortController();
  const added: Array<{ type: string; listener: unknown }> = [];
  const removed: Array<{ type: string; listener: unknown }> = [];
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  vi.spyOn(controller.signal, 'addEventListener').mockImplementation(
    (type: string, listener: never, options?: never) => {
      added.push({ type, listener });
      originalAdd(type, listener, options);
    },
  );
  vi.spyOn(controller.signal, 'removeEventListener').mockImplementation(
    (type: string, listener: never, options?: never) => {
      removed.push({ type, listener });
      originalRemove(type, listener, options);
    },
  );
  return { signal: controller.signal, controller, added, removed };
}

function rejectingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockRejectedValue(new TypeError('fetch failed'));
}

describe('HttpClient stream initialization releases caller abort listeners (F2)', () => {
  it('SSE: a rejected fetch detaches the abort listener exactly once', async () => {
    const http = new HttpClient({ baseUrl: BASE_URL, fetch: rejectingFetch() as never });
    const { signal, added, removed } = observedSignal();

    const error = await http
      .requestSseStream({ path: '/v1/chat/completions', body: {}, signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaNetworkError);
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toEqual(added[0]);
  });

  it('NDJSON: a rejected fetch detaches the abort listener exactly once', async () => {
    const http = new HttpClient({ baseUrl: BASE_URL, fetch: rejectingFetch() as never });
    const { signal, added, removed } = observedSignal();

    const error = await http
      .requestStream({ path: '/api/chat', body: {}, signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaNetworkError);
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toEqual(added[0]);
  });

  it('repeated initialization failures on one long-lived signal leave no listeners behind', async () => {
    const http = new HttpClient({ baseUrl: BASE_URL, fetch: rejectingFetch() as never });
    const { signal, added, removed } = observedSignal();

    for (let i = 0; i < 50; i += 1) {
      await http.requestSseStream({ path: '/v1/chat/completions', body: {}, signal }).catch(() => {
        /* expected rejection */
      });
      await http.requestStream({ path: '/api/chat', body: {}, signal }).catch(() => {
        /* expected rejection */
      });
    }

    expect(added).toHaveLength(100);
    expect(removed).toHaveLength(100);
    expect(removed.map((r) => r.listener)).toEqual(added.map((a) => a.listener));
  });

  it('a non-2xx initialization response detaches the abort listener exactly once', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => new Response('busy', { status: 503, statusText: 'x' }));
    const http = new HttpClient({ baseUrl: BASE_URL, fetch: fetch as never });
    const { signal, added, removed } = observedSignal();

    await http
      .requestSseStream({ path: '/v1/chat/completions', body: {}, signal })
      .catch(() => undefined);

    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toEqual(added[0]);
  });

  it('an already-aborted signal rejects with OllamaAbortError and registers no listener', async () => {
    const fetch = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const http = new HttpClient({ baseUrl: BASE_URL, fetch: fetch as never });
    const { signal, controller, added, removed } = observedSignal();
    controller.abort();
    added.length = 0;

    const error = await http
      .requestSseStream({ path: '/v1/chat/completions', body: {}, signal })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OllamaAbortError);
    expect(added).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });

  it('a successful SSE stream keeps the listener until consumption finishes, then removes it once', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response('data: {"n":1}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
      );
    const http = new HttpClient({ baseUrl: BASE_URL, fetch: fetch as never });
    const { signal, added, removed } = observedSignal();

    const stream = await http.requestSseStream({
      path: '/v1/chat/completions',
      body: {},
      signal,
    });

    // Header receipt must not detach: the listener guards the live body.
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(0);

    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toEqual(added[0]);
  });

  it('abort() on a live SSE stream detaches the listener once and aborts the transport', async () => {
    const fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const http = new HttpClient({ baseUrl: BASE_URL, fetch: fetch as never });
    const { signal, added, removed } = observedSignal();

    const stream = await http.requestSseStream({ path: '/v1/chat/completions', body: {}, signal });
    stream.abort();

    expect(removed).toHaveLength(1);
    expect(removed[0]).toEqual(added[0]);
  });
});
