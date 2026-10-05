import { describe, expect, it } from 'vitest';
import {
  computeProgressPercent,
  onProgress,
  toPullProgressEvent,
  type PullProgressEvent,
} from '../src/streaming/progress.js';
import { normalizeProgressStream } from '../src/streaming/normalize.js';
import { parseNdjsonStream } from '../src/streaming/ndjson.js';
import type { ProgressResponse } from '../src/types.js';

/**
 * `onProgress` and progress-event helpers — see
 * `src/streaming/progress.ts`.
 *
 * The SDK already exposes pull/push progress as a typed
 * {@link OllamaStream} via `models.pull({ stream: true })`. This
 * higher-level helper invokes a callback on every progress event
 * with a pre-computed `percent` field, for callers building
 * download/upload UIs.
 */

/** Build a ReadableStream emitting the given NDJSON chunks in order. */
function ndjsonStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Wrap an NDJSON stream into the OllamaStream shape that onProgress expects. */
function makeProgressStream(chunks: readonly string[]) {
  const raw = ndjsonStream(chunks);
  const iterable = parseNdjsonStream<ProgressResponse>(raw);
  // parseNdjsonStream returns a bare AsyncGenerator; the normalizeProgressStream
  // helper expects an AbortableAsyncIterable. The only field it reads besides
  // [Symbol.asyncIterator] is `abort`, which is optional.
  return normalizeProgressStream(
    { [Symbol.asyncIterator]: () => iterable[Symbol.asyncIterator]() },
    undefined,
  );
}

describe('computeProgressPercent', () => {
  it('returns the percentage with two decimal places', () => {
    expect(computeProgressPercent({ status: 'downloading', total: 1000, completed: 423 })).toBe(
      42.3,
    );
    expect(computeProgressPercent({ status: 'downloading', total: 100, completed: 50 })).toBe(50);
    expect(computeProgressPercent({ status: 'downloading', total: 3, completed: 1 })).toBe(33.33);
  });

  it('returns undefined when total or completed is missing', () => {
    expect(computeProgressPercent({ status: 'pulling manifest' })).toBeUndefined();
    expect(computeProgressPercent({ status: 'downloading', total: 100 })).toBeUndefined();
    expect(computeProgressPercent({ status: 'downloading', completed: 50 })).toBeUndefined();
  });

  it('returns undefined when total is zero or negative (division guard)', () => {
    expect(computeProgressPercent({ status: 'downloading', total: 0, completed: 0 })).toBeUndefined();
    expect(
      computeProgressPercent({ status: 'downloading', total: -10, completed: -5 }),
    ).toBeUndefined();
  });

  it('clamps to [0, 100] when completed > total (server reporting anomaly)', () => {
    expect(computeProgressPercent({ status: 'downloading', total: 100, completed: 150 })).toBe(100);
    expect(computeProgressPercent({ status: 'downloading', total: 100, completed: -50 })).toBe(0);
  });

  it('returns exactly 100 when completed equals total', () => {
    expect(computeProgressPercent({ status: 'writing manifest', total: 42, completed: 42 })).toBe(
      100,
    );
  });
});

describe('toPullProgressEvent', () => {
  it('wraps a chunk with no byte totals (status-only frame)', () => {
    const event = toPullProgressEvent({ status: 'pulling manifest' });
    expect(event.status).toBe('pulling manifest');
    expect(event.digest).toBeUndefined();
    expect(event.total).toBeUndefined();
    expect(event.completed).toBeUndefined();
    expect(event.percent).toBeUndefined();
    expect(event.raw).toEqual({ status: 'pulling manifest' });
  });

  it('wraps a downloading chunk with digest and byte totals', () => {
    const event = toPullProgressEvent({
      status: 'downloading',
      digest: 'sha256:abc123',
      total: 1000,
      completed: 250,
    });
    expect(event.status).toBe('downloading');
    expect(event.digest).toBe('sha256:abc123');
    expect(event.total).toBe(1000);
    expect(event.completed).toBe(250);
    expect(event.percent).toBe(25);
  });

  it('wraps the final success frame', () => {
    const event = toPullProgressEvent({ status: 'success' });
    expect(event.status).toBe('success');
    expect(event.percent).toBeUndefined();
  });
});

describe('onProgress: stream iteration', () => {
  it('invokes the callback for every progress event and resolves with the final result', async () => {
    const stream = makeProgressStream([
      '{"status":"pulling manifest"}\n',
      '{"status":"downloading","digest":"sha256:abc","total":1000,"completed":250}\n',
      '{"status":"downloading","digest":"sha256:abc","total":1000,"completed":750}\n',
      '{"status":"verifying sha256 digest"}\n',
      '{"status":"writing manifest","digest":"sha256:abc","total":42,"completed":42}\n',
      '{"status":"success"}\n',
    ]);

    const events: PullProgressEvent[] = [];
    const result = await onProgress(stream, (event) => {
      events.push(event);
    });

    expect(events).toHaveLength(6);
    expect(events[0]?.status).toBe('pulling manifest');
    expect(events[0]?.percent).toBeUndefined();
    expect(events[1]?.percent).toBe(25);
    expect(events[2]?.percent).toBe(75);
    expect(events[3]?.status).toBe('verifying sha256 digest');
    expect(events[4]?.percent).toBe(100);
    expect(events[5]?.status).toBe('success');

    expect(result.status).toBe('success');
    expect(result.done).toBe(true);
  });

  it('resolves with the final ProgressStreamResult on success', async () => {
    const stream = makeProgressStream([
      '{"status":"pulling manifest"}\n',
      '{"status":"success"}\n',
    ]);

    const result = await onProgress(stream, () => undefined);

    expect(result.status).toBe('success');
    expect(result.done).toBe(true);
  });

  it('rejects when the stream emits an in-band error frame', async () => {
    const stream = makeProgressStream([
      '{"status":"pulling manifest"}\n',
      '{"status":"downloading","digest":"sha256:abc","total":1000,"completed":250}\n',
      '{"error":"network error during pull"}\n',
    ]);

    const events: PullProgressEvent[] = [];
    await expect(
      onProgress(stream, (event) => {
        events.push(event);
      }),
    ).rejects.toThrow('network error during pull');

    // The callback should have been invoked for the two valid chunks
    // before the error frame arrived.
    expect(events).toHaveLength(2);
    expect(events[0]?.status).toBe('pulling manifest');
    expect(events[1]?.percent).toBe(25);
  });

  it('rejects when the stream ends without emitting success (abnormal termination)', async () => {
    const stream = makeProgressStream([
      '{"status":"pulling manifest"}\n',
      // No `success` frame — stream just ends.
      '{"status":"downloading","digest":"sha256:abc","total":1000,"completed":500}\n',
    ]);

    await expect(onProgress(stream, () => undefined)).rejects.toThrow(
      /ended before reporting success/,
    );
  });
});
