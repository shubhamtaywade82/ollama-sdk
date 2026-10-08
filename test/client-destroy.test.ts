import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';

/**
 * OllamaClient.destroy() (audit THD-01): clean teardown for worker threads
 * and short-lived processes — every in-flight request, active stream, and
 * queued capacity waiter is aborted with OllamaAbortError, endpoint slots are
 * released, and subsequent destroy() calls are idempotent no-ops.
 */

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Fetch mock whose requests never resolve on their own — they reject only
 * when the transport aborts them, mirroring real fetch semantics for
 * in-flight requests.
 */
function hangingFetch() {
  const fetchMock = vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init?.signal ?? undefined) as AbortSignal | undefined;
        if (!signal) return; // hangs forever
        if (signal.aborted) {
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }),
  );
  return fetchMock;
}

function abortableNdjsonBody(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `{"model":"llama3","created_at":"t","message":{"role":"assistant","content":"hi"},"done":false}\n`,
        ),
      );
      // Never closes on its own — but errors when the transport aborts the
      // request, so in-flight reads reject exactly like a real fetch body.
      const onAbort = (): void =>
        controller.error(signal?.reason ?? new DOMException('aborted', 'AbortError'));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    },
  });
}

describe('OllamaClient.destroy: in-flight requests', () => {
  it('aborts an in-flight chat with OllamaAbortError carrying the reason', async () => {
    const fetchMock = hangingFetch();
    const client = new OllamaClient({
      endpoints: [{ name: 'a', baseUrl: 'http://a.local' }],
      fetch: fetchMock as never,
    });

    const promise = client.chat({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // Wait for the request to actually dispatch — chat's telemetry wrapper
    // cold-loads @opentelemetry/api via dynamic import, which may straddle a
    // macrotask, so a fixed number of flushes is not deterministic.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(client.destroy('worker thread exiting')).toBe(1);
    await expect(promise).rejects.toMatchObject({
      code: 'aborted',
      message: 'worker thread exiting',
    });
  });

  it('aborts in-flight embed requests too', async () => {
    const fetchMock = hangingFetch();
    const client = new OllamaClient({
      endpoints: [{ name: 'a', baseUrl: 'http://a.local' }],
      fetch: fetchMock as never,
    });

    const promise = client.embed({ model: 'nomic-embed-text', input: ['hello'] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(client.destroy()).toBe(1);
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
  });

  it('aborts Ollama Cloud requests (usage/balance) the same way', async () => {
    const fetchMock = hangingFetch();
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      apiKey: 'cloud-key',
      fetch: fetchMock as never,
    });

    const promise = client.usage();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(client.destroy()).toBe(1);
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
  });

  it('aborts every concurrent operation and returns the count', async () => {
    const fetchMock = hangingFetch();
    const client = new OllamaClient({
      endpoints: [{ name: 'a', baseUrl: 'http://a.local' }],
      fetch: fetchMock as never,
    });

    const p1 = client.chat({ model: 'm', messages: [{ role: 'user', content: 'a' }] });
    const p2 = client.chat({ model: 'm', messages: [{ role: 'user', content: 'b' }] });
    const p3 = client.embed({ model: 'e', input: ['c'] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(client.destroy()).toBe(3);
    await expect(p1).rejects.toMatchObject({ code: 'aborted' });
    await expect(p2).rejects.toMatchObject({ code: 'aborted' });
    await expect(p3).rejects.toMatchObject({ code: 'aborted' });
  });

  it('aborts requests still queued behind maxConcurrentPerEndpoint', async () => {
    const fetchMock = hangingFetch();
    const client = new OllamaClient({
      endpoints: [{ name: 'a', baseUrl: 'http://a.local' }],
      endpointHealth: { maxConcurrentPerEndpoint: 1 },
      fetch: fetchMock as never,
    });

    const dispatched = client.chat({ model: 'm', messages: [{ role: 'user', content: 'a' }] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const queued = client.chat({ model: 'm', messages: [{ role: 'user', content: 'b' }] });
    await flush(); // the queued request's scope registers on the microtask queue

    expect(fetchMock).toHaveBeenCalledTimes(1); // second request is capacity-queued
    expect(client.destroy()).toBe(2); // both the dispatched AND the queued scope
    await expect(dispatched).rejects.toMatchObject({ code: 'aborted' });
    await expect(queued).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('OllamaClient.destroy: active streams', () => {
  it('aborts an unconsumed stream, rejects finalResult, and releases the endpoint slot', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => ({
      ok: true,
      status: 200,
      body: abortableNdjsonBody(init?.signal),
    }));
    const client = new OllamaClient({
      endpoints: [{ name: 'a', baseUrl: 'http://a.local' }],
      endpointHealth: { maxConcurrentPerEndpoint: 1 },
      fetch: fetchMock as never,
    });

    const stream = await client.chatStream({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(client.endpointStatus()[0]?.activeRequests).toBe(1);

    expect(client.destroy()).toBe(1);
    await expect(stream.finalResult).rejects.toMatchObject({ code: 'aborted' });

    // The holdUntil release path fires when finalResult settles: slot freed.
    await flush();
    expect(client.endpointStatus()[0]?.activeRequests).toBe(0);
  });

  it('aborts a mid-consumption stream and surfaces the error event to the iterator', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => ({
      ok: true,
      status: 200,
      body: abortableNdjsonBody(init?.signal),
    }));
    const client = new OllamaClient({
      endpoints: [{ name: 'a', baseUrl: 'http://a.local' }],
      fetch: fetchMock as never,
    });

    const stream = await client.chatStream({
      model: 'llama3',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const events: Array<{ type: string }> = [];
    const consuming = (async () => {
      for await (const event of stream) {
        events.push({ type: event.type });
      }
    })();
    await flush();
    client.destroy();
    await consuming; // iterator terminates via the error event, not a hang

    expect(events.some((e) => e.type === 'error')).toBe(true);
    await expect(stream.finalResult).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('OllamaClient.destroy: lifecycle semantics', () => {
  it('is a no-op returning 0 on an idle client, and repeat calls return 0', async () => {
    const client = new OllamaClient({
      endpoints: [{ name: 'a', baseUrl: 'http://a.local' }],
      fetch: hangingFetch() as never,
    });

    expect(client.destroy()).toBe(0);
    expect(client.destroy()).toBe(0);
  });

  it('returns 0 on the second call after aborting in-flight work', async () => {
    const fetchMock = hangingFetch();
    const client = new OllamaClient({
      endpoints: [{ name: 'a', baseUrl: 'http://a.local' }],
      fetch: fetchMock as never,
    });

    const promise = client.chat({ model: 'm', messages: [{ role: 'user', content: 'a' }] });
    await flush();
    expect(client.destroy()).toBe(1);
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    expect(client.destroy()).toBe(0);
  });

  it('leaves the client usable afterward — destroy is a drain, not a disable', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = (init?.signal ?? undefined) as AbortSignal | undefined;
            const onAbort = (): void =>
              reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
            if (signal?.aborted) {
              onAbort();
              return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });
          }),
      )
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ model: 'm', embeddings: [[1, 2, 3]] }),
      });
    const client = new OllamaClient({
      endpoints: [{ name: 'a', baseUrl: 'http://a.local' }],
      fetch: fetchMock as never,
    });

    const first = client.embed({ model: 'm', input: ['a'] });
    await flush();
    client.destroy();
    await expect(first).rejects.toMatchObject({ code: 'aborted' });

    const second = await client.embed({ model: 'm', input: ['b'] });
    expect(second.embeddings[0]).toEqual([1, 2, 3]);
  });

  it('does not abort a request started after destroy completed', async () => {
    const fetchMock = hangingFetch();
    const client = new OllamaClient({
      endpoints: [{ name: 'a', baseUrl: 'http://a.local' }],
      fetch: fetchMock as never,
    });

    client.destroy();
    const promise = client.chat({ model: 'm', messages: [{ role: 'user', content: 'a' }] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Still pending (hanging fetch) — destroy did not poison future requests.
    const status = await Promise.race([
      promise.catch(() => 'rejected'),
      flush().then(() => 'pending'),
    ]);
    expect(status).toBe('pending');
  });
});
