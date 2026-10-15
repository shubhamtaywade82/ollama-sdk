import { describe, expect, it } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { OllamaAbortError } from '../src/errors.js';
import {
  createMockOllamaServer,
  mockTextChunks,
  type OllamaMockServer,
} from '../src/testing/index.js';

/**
 * STR-03 invariant pin (Oct-15 audit): aborting an active stream while a
 * `reader.read()` is pending must terminate the consumer cleanly — the
 * mapped {@link OllamaAbortError} is delivered as an event, the endpoint's
 * concurrency slot is released, and NO `unhandledRejection` surfaces at
 * the process level from the internally-held `finalResult` promise.
 *
 * The audit digest claimed an unhandled-rejection race in this path; the
 * seams it pointed at are each guarded (requestStream's abortable
 * controller, `disposableReader`'s swallowed cancel rejections, and
 * `executeWithFailover`'s `holdUntil` chain attaching a catch handler to
 * `finalResult` before the stream is ever returned). These tests pin the
 * invariant so a future refactor cannot silently regress it — the same
 * BUF-01 precedent as v1.17.0: stale claim, real invariant, pinned.
 */

let server: OllamaMockServer;

/** Register a deliberately slow streaming chat route (50ms between frames). */
function registerSlowChatStream(text: string): void {
  server.register('/api/chat', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
    chunks: mockTextChunks(text, { chunkSize: 4 }),
    chunkDelayMs: 50,
  });
}

/** Let every pending rejection chain flush through the macro-task queue. */
async function settleRejectionChains(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('STR-03 pin: aborting mid-read never surfaces unhandled rejections', () => {
  it('iterator mode — caller signal abort while a frame is in flight', async () => {
    server = createMockOllamaServer();
    registerSlowChatStream('this frame stream is long enough to abort mid-flight');
    await server.start();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const controller = new AbortController();
    const client = new OllamaClient({
      baseUrl: server.baseUrl,
      endpointHealth: { maxConcurrentPerEndpoint: 1 },
    });

    try {
      const stream = await client.chat({
        model: 'llama4',
        messages: [{ role: 'user', content: 'say hi' }],
        stream: true,
        signal: controller.signal,
      });

      expect(client.endpointStatus()[0]?.activeRequests).toBe(1);

      let firstFrameArrived!: () => void;
      const firstFrame = new Promise<void>((resolve) => {
        firstFrameArrived = resolve;
      });

      // The consumer loop runs detached; after the first frame it parks in
      // `await next()` → `await reader.read()` with the next frame 50ms out.
      // That parked read() is the exact in-flight microtask the STR-03
      // digest described — the abort must reject it cleanly.
      const iteration = (async () => {
        let sawToken = false;
        let sawError = false;
        for await (const event of stream) {
          if (event.type === 'token') {
            sawToken = true;
            firstFrameArrived();
          }
          if (event.type === 'error') {
            sawError = true;
            expect(event.data.error).toBeInstanceOf(OllamaAbortError);
          }
        }
        return { sawToken, sawError };
      })();

      await firstFrame;
      controller.abort(); // mid-read: the next frame is still in flight
      const { sawToken, sawError } = await iteration;

      // The consumer-visible termination is the mapped abort error…
      await expect(stream.finalResult).rejects.toMatchObject({ code: 'aborted' });

      await settleRejectionChains();
      expect(sawToken).toBe(true);
      expect(sawError).toBe(true);
      expect(unhandled).toEqual([]);

      // …and the endpoint slot frees once finalResult settles.
      expect(client.endpointStatus()[0]?.activeRequests).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await client.destroy();
      await server.stop();
    }
  });

  it('events mode — stream.abort() while pump() awaits the next frame', async () => {
    server = createMockOllamaServer();
    registerSlowChatStream('events mode abort target with several frames');
    await server.start();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const client = new OllamaClient({
      baseUrl: server.baseUrl,
      endpointHealth: { maxConcurrentPerEndpoint: 1 },
    });

    try {
      const stream = await client.chat({
        model: 'llama4',
        messages: [{ role: 'user', content: 'say hi' }],
        stream: true,
      });

      const errors: unknown[] = [];
      stream.on('error', (event) => {
        errors.push(event.data.error);
      });

      // Abort while the pump is suspended in reader.read() awaiting the
      // next 50ms-delayed frame.
      await new Promise((resolve) => setTimeout(resolve, 75));
      stream.abort();

      await expect(stream.finalResult).rejects.toMatchObject({ code: 'aborted' });
      await settleRejectionChains();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(OllamaAbortError);
      expect(unhandled).toEqual([]);
      expect(client.endpointStatus()[0]?.activeRequests).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await client.destroy();
      await server.stop();
    }
  });

  it('the freed slot admits a follow-up request immediately (holdUntil chain settled)', async () => {
    server = createMockOllamaServer();
    registerSlowChatStream('slot probe payload with multiple delayed frames');
    // /api/version is answered by the mock server's default route (0.14.0).
    await server.start();

    const client = new OllamaClient({
      baseUrl: server.baseUrl,
      endpointHealth: { maxConcurrentPerEndpoint: 1 },
    });

    try {
      const controller = new AbortController();
      const stream = await client.chat({
        model: 'llama4',
        messages: [{ role: 'user', content: 'say hi' }],
        stream: true,
        signal: controller.signal,
      });

      const drained: string[] = [];
      const iteration = (async () => {
        for await (const event of stream) {
          if (event.type === 'token') drained.push(event.data.delta);
          if (drained.length >= 1) break;
        }
      })();
      await new Promise((resolve) => setTimeout(resolve, 60));
      controller.abort();
      await iteration;
      await expect(stream.finalResult).rejects.toMatchObject({ code: 'aborted' });

      // With maxConcurrentPerEndpoint: 1, this can only complete if the
      // aborted stream released its slot.
      const version = await client.version();
      expect(version.version).toBe('0.14.0');
    } finally {
      await client.destroy();
      await server.stop();
    }
  });
});
