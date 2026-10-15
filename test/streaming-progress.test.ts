import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeProgressPercent,
  createProgressSpeedTracker,
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
    expect(
      computeProgressPercent({ status: 'downloading', total: 0, completed: 0 }),
    ).toBeUndefined();
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

describe('createProgressSpeedTracker', () => {
  // Deterministic timing: mock performance.now() with a manually advanced
  // clock so speed math is exact, not sleep-tolerance-based.
  let mockNow = 0;
  let spy: ReturnType<typeof vi.spyOn> | undefined;

  function tick(ms: number): void {
    mockNow += ms;
  }

  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });

  function installClock(): void {
    mockNow = 0;
    spy = vi.spyOn(performance, 'now').mockImplementation(() => mockNow);
  }

  it('measures cumulative-average speed and ETA across frames of one layer', () => {
    installClock();
    const speed = createProgressSpeedTracker();

    // First byte-bearing frame initializes the epoch — no reading yet.
    expect(
      speed({ status: 'downloading', digest: 'sha256:a', total: 1000, completed: 100 }),
    ).toEqual({});

    tick(500); // 0.5 s later, 500 more bytes → 1000 B/s, 0.4 s remaining…
    expect(
      speed({ status: 'downloading', digest: 'sha256:a', total: 1000, completed: 600 }),
    ).toEqual({
      bytesPerSecond: 1000,
      etaSeconds: 0.4,
    });

    tick(500); // 1.0 s elapsed, 1000 transferred → still 1000 B/s cumulative
    expect(
      speed({ status: 'downloading', digest: 'sha256:a', total: 1000, completed: 1100 }),
    ).toEqual({
      bytesPerSecond: 1000,
      etaSeconds: 0, // completed >= total clamps to 0
    });
  });

  it('starts a fresh epoch when the digest changes (new layer)', () => {
    installClock();
    const speed = createProgressSpeedTracker();

    speed({ status: 'downloading', digest: 'sha256:a', total: 1000, completed: 900 });
    tick(1000);
    expect(
      speed({ status: 'downloading', digest: 'sha256:a', total: 1000, completed: 1000 }),
    ).toEqual({
      bytesPerSecond: 100,
      etaSeconds: 0,
    });

    // Layer 2 begins: completed drops to 50 with a new digest.
    expect(speed({ status: 'downloading', digest: 'sha256:b', total: 500, completed: 50 })).toEqual(
      {},
    );
    tick(100);
    // Speed derives from layer 2's epoch only — never averaged with layer 1.
    expect(
      speed({ status: 'downloading', digest: 'sha256:b', total: 500, completed: 150 }),
    ).toEqual({
      bytesPerSecond: 1000,
      etaSeconds: 0.35,
    });
  });

  it('resets the epoch when completed regresses within the same digest', () => {
    installClock();
    const speed = createProgressSpeedTracker();

    speed({ status: 'downloading', digest: 'sha256:a', total: 1000, completed: 800 });
    tick(1000);
    speed({ status: 'downloading', digest: 'sha256:a', total: 1000, completed: 1000 });

    // Server restarts the same layer's counter (dedup/verification quirk).
    expect(
      speed({ status: 'downloading', digest: 'sha256:a', total: 1000, completed: 10 }),
    ).toEqual({});
    tick(1000);
    expect(
      speed({ status: 'downloading', digest: 'sha256:a', total: 1000, completed: 510 }),
    ).toEqual({
      bytesPerSecond: 500,
      etaSeconds: 0.98,
    });
  });

  it('returns no reading for status-only frames and zero-elapsed duplicates', () => {
    installClock();
    const speed = createProgressSpeedTracker();

    // No completed field — passthrough, epoch untouched.
    expect(speed({ status: 'pulling manifest' })).toEqual({});
    expect(speed({ status: 'verifying sha256 digest', digest: 'sha256:a' })).toEqual({});

    speed({ status: 'downloading', digest: 'sha256:a', total: 1000, completed: 100 });
    // Same-timestamp frame: zero elapsed → no reading.
    expect(
      speed({ status: 'downloading', digest: 'sha256:a', total: 1000, completed: 300 }),
    ).toEqual({});

    // Zero transferred (stalled) → no reading.
    tick(1000);
    expect(
      speed({ status: 'downloading', digest: 'sha256:a', total: 1000, completed: 100 }),
    ).toEqual({});
  });

  it('reports speed with undefined ETA when the frame carries no total', () => {
    installClock();
    const speed = createProgressSpeedTracker();

    speed({ status: 'downloading', digest: 'sha256:a', completed: 100 });
    tick(250);
    expect(speed({ status: 'downloading', digest: 'sha256:a', completed: 350 })).toEqual({
      bytesPerSecond: 1000,
      etaSeconds: undefined,
    });
  });
});

describe('onProgress: transfer speed integration', () => {
  let mockNow = 0;
  let spy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });

  it('carries bytesPerSecond/etaSeconds on callback events once measurable', async () => {
    mockNow = 0;
    spy = vi.spyOn(performance, 'now').mockImplementation(() => mockNow);

    const stream = makeProgressStream([
      '{"status":"pulling manifest"}\n',
      '{"status":"downloading","digest":"sha256:abc","total":1000,"completed":250}\n',
      '{"status":"downloading","digest":"sha256:abc","total":1000,"completed":750}\n',
      '{"status":"success"}\n',
    ]);

    const events: PullProgressEvent[] = [];
    await onProgress(stream, (event) => {
      mockNow += 250; // advance 0.25 s per callback — deterministic per-frame dt
      events.push(event);
    });

    // Frame 0 (manifest): no byte fields.
    expect(events[0]?.bytesPerSecond).toBeUndefined();
    expect(events[0]?.etaSeconds).toBeUndefined();
    // Frame 1 (first byte-bearing frame): epoch starts, no reading yet.
    expect(events[1]?.percent).toBe(25);
    expect(events[1]?.bytesPerSecond).toBeUndefined();
    // Frame 2: 500 bytes in 0.25 s → 2000 B/s, 250 bytes left → 0.125 s.
    expect(events[2]?.percent).toBe(75);
    expect(events[2]?.bytesPerSecond).toBe(2000);
    expect(events[2]?.etaSeconds).toBeCloseTo(0.125, 10);
    // Frame 3 (success): status-only, no reading.
    expect(events[3]?.bytesPerSecond).toBeUndefined();
  });
});
