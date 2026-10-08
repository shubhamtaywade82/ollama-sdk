import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import {
  DEFAULT_EMBED_CONCURRENCY,
  batchEmbed,
  findOversizedEmbedInputs,
} from '../src/embed-batch.js';
import { NOOP_LOGGER } from '../src/logger.js';

/**
 * Batch-constrained embedding pipeline (src/embed-batch.ts + OllamaClient.embedBatch):
 * chunked worker pool over /api/embed with bounded concurrency, order
 * preservation, fail-fast sibling cancellation, and per-string context-window
 * pre-flight.
 */

interface CapturedBody {
  model: string;
  input: string[];
  truncate?: boolean;
  dimensions?: number;
  keep_alive?: string | number;
  options?: { num_ctx?: number; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Signal-aware fetch mock: tracks calls, in-flight concurrency, and rejects
 * in-flight requests when the transport aborts them (mirrors real fetch
 * semantics, which the sibling-cancellation and destroy tests depend on).
 */
function embedFetchMock(
  config: {
    handler?: (input: string[], callIndex: number) => { embeddings: number[][] } | Response;
    delayMs?: (input: string[], callIndex: number) => number;
  } = {},
) {
  const calls: CapturedBody[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let completed = 0;

  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as CapturedBody;
    calls.push(body);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const signal = (init?.signal ?? undefined) as AbortSignal | undefined;
    try {
      const delay = config.delayMs?.(body.input, calls.length - 1) ?? 0;
      if (delay > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      completed++;
      const result =
        config.handler?.(body.input, calls.length - 1) ??
        ({ embeddings: body.input.map((text) => [Number(text)]) } as { embeddings: number[][] });
      if (result instanceof Response) return result;
      return { ok: true, status: 200, json: async () => ({ model: body.model, ...result }) };
    } finally {
      inFlight--;
    }
  });

  return {
    fetchMock,
    calls,
    get maxInFlight(): number {
      return maxInFlight;
    },
    get completed(): number {
      return completed;
    },
  };
}

function makeClient(fetchMock: ReturnType<typeof embedFetchMock>['fetchMock'], config = {}) {
  return new OllamaClient({
    fetch: fetchMock as never,
    endpoints: [{ name: 'a', baseUrl: 'http://a.local' }],
    ...config,
  });
}

describe('batchEmbed: chunking and ordering', () => {
  it('splits input into batchSize slices and preserves corpus order', async () => {
    const mock = embedFetchMock({ delayMs: (input) => (Number(input[0]) % 2 === 0 ? 25 : 0) });
    const client = makeClient(mock.fetchMock);

    const input = Array.from({ length: 10 }, (_, i) => String(i));
    const result = await batchEmbed(client, {
      model: 'nomic-embed-text',
      input,
      batchSize: 3,
      concurrency: 2,
    });

    // 10 inputs / batchSize 3 -> 4 batches (3+3+3+1)
    expect(result.batchCount).toBe(4);
    expect(mock.calls.map((c) => c.input)).toEqual([
      ['0', '1', '2'],
      ['3', '4', '5'],
      ['6', '7', '8'],
      ['9'],
    ]);
    // Even with even-numbered batches finishing last, embeddings[i] === [i]
    expect(result.embeddings).toEqual(input.map((i) => [Number(i)]));
  });

  it('returns an empty result without touching the network for empty input', async () => {
    const mock = embedFetchMock();
    const client = makeClient(mock.fetchMock);

    const result = await batchEmbed(client, { model: 'm', input: [] });

    expect(result).toEqual({ model: 'm', embeddings: [], batchCount: 0 });
    expect(mock.fetchMock).not.toHaveBeenCalled();
  });

  it('defaults to 32-input batches with 3 in flight', async () => {
    const mock = embedFetchMock({ delayMs: () => 5 });
    const client = makeClient(mock.fetchMock);

    const input = Array.from({ length: 65 }, (_, i) => String(i));
    const result = await batchEmbed(client, { model: 'm', input });

    expect(result.batchCount).toBe(3); // 32 + 32 + 1
    expect(mock.calls.map((c) => c.input.length)).toEqual([32, 32, 1]);
    expect(mock.maxInFlight).toBeLessThanOrEqual(DEFAULT_EMBED_CONCURRENCY);
    expect(mock.maxInFlight).toBeGreaterThan(1); // genuinely parallel, not sequential
  });

  it('caps observed concurrency at the configured limit', async () => {
    const mock = embedFetchMock({ delayMs: () => 20 });
    const client = makeClient(mock.fetchMock);

    const input = Array.from({ length: 20 }, (_, i) => String(i));
    await batchEmbed(client, { model: 'm', input, batchSize: 2, concurrency: 3 });

    expect(mock.calls.length).toBe(10);
    expect(mock.maxInFlight).toBeLessThanOrEqual(3);
    expect(mock.maxInFlight).toBeGreaterThan(1);
  });

  it('runs strictly sequentially at concurrency 1', async () => {
    const mock = embedFetchMock({ delayMs: () => 5 });
    const client = makeClient(mock.fetchMock);

    await batchEmbed(client, {
      model: 'm',
      input: ['0', '1', '2', '3'],
      batchSize: 1,
      concurrency: 1,
    });

    expect(mock.maxInFlight).toBe(1);
  });

  it('passes through truncate, dimensions, keep_alive, and model options on every batch', async () => {
    const mock = embedFetchMock();
    const client = makeClient(mock.fetchMock);

    await batchEmbed(client, {
      model: 'm',
      input: ['0', '1'],
      batchSize: 1,
      truncate: true,
      dimensions: 256,
      keep_alive: '10m',
      options: { num_ctx: 4096 },
    });

    expect(mock.calls.length).toBe(2);
    for (const call of mock.calls) {
      expect(call.truncate).toBe(true);
      expect(call.dimensions).toBe(256);
      expect(call.keep_alive).toBe('10m');
      expect(call.options?.num_ctx).toBe(4096);
    }
  });

  it('reports progress after each successful batch', async () => {
    const mock = embedFetchMock();
    const client = makeClient(mock.fetchMock);

    const seen: Array<[number, number]> = [];
    await batchEmbed(client, {
      model: 'm',
      input: Array.from({ length: 7 }, (_, i) => String(i)),
      batchSize: 3,
      onBatchComplete: (done, total) => seen.push([done, total]),
    });

    expect(seen.length).toBe(3);
    expect(seen.every(([done, total]) => total === 3 && done >= 1 && done <= 3)).toBe(true);
    expect(seen.map(([done]) => done).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('rejects invalid batchSize / concurrency before any request is sent', async () => {
    const mock = embedFetchMock();
    const client = makeClient(mock.fetchMock);

    await expect(
      batchEmbed(client, { model: 'm', input: ['0'], batchSize: 0 }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      batchEmbed(client, { model: 'm', input: ['0'], concurrency: -1 }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(mock.fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a per-batch embedding-count mismatch as invalid_response', async () => {
    const mock = embedFetchMock({
      handler: (input) => ({ embeddings: input.slice(0, 1).map((t) => [Number(t)]) }),
    });
    const client = makeClient(mock.fetchMock);

    await expect(
      batchEmbed(client, { model: 'm', input: ['0', '1'], batchSize: 2 }),
    ).rejects.toMatchObject({
      code: 'invalid_response',
      message: expect.stringContaining('batch of 2'),
    });
  });
});

describe('batchEmbed: fail-fast and cancellation', () => {
  it('rejects with the original error and cancels sibling in-flight batches', async () => {
    const mock = embedFetchMock({
      handler: (input) => {
        if (input.includes('boom')) {
          return new Response(JSON.stringify({ error: 'boom: bad input' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return { embeddings: input.map((t) => [Number(t)]) };
      },
      delayMs: (input) => (input.includes('boom') ? 5 : 30),
    });
    const client = makeClient(mock.fetchMock);

    // 6 batches of 1, concurrency 3: 'boom' (batch 2) fails fast while the
    // slow sibling in flight is aborted and the remaining batches never start.
    await expect(
      batchEmbed(client, {
        model: 'm',
        input: ['0', 'boom', '2', '3', '4', '5'],
        batchSize: 1,
        concurrency: 3,
      }),
    ).rejects.toMatchObject({ message: 'boom: bad input' });

    expect(mock.completed).toBeLessThan(6);
    expect(mock.calls.length).toBeLessThanOrEqual(4); // 3 started, at most 1 extra raced the abort
  });

  it('rejects with code aborted when the caller signal fires mid-flight', async () => {
    const mock = embedFetchMock({ delayMs: () => 40 });
    const client = makeClient(mock.fetchMock);
    const controller = new AbortController();

    const promise = batchEmbed(client, {
      model: 'm',
      input: Array.from({ length: 8 }, (_, i) => String(i)),
      batchSize: 1,
      concurrency: 2,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);

    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    expect(mock.calls.length).toBeLessThan(8); // queued batches were never dispatched
  });

  it('is torn down by client.destroy() mid-batch', async () => {
    const mock = embedFetchMock({ delayMs: () => 40 });
    const client = makeClient(mock.fetchMock);

    const promise = client.embedBatch({
      model: 'm',
      input: Array.from({ length: 6 }, (_, i) => String(i)),
      batchSize: 1,
      concurrency: 2,
    });
    setTimeout(() => {
      const aborted = client.destroy('worker thread exiting');
      expect(aborted).toBeGreaterThan(0);
    }, 10);

    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('findOversizedEmbedInputs', () => {
  it('flags inputs whose estimate exceeds the window, with no margin', () => {
    const input = ['tiny', 'x'.repeat(400), '你好世界', 'ok']; // 400 chars ~ 100 tokens
    const oversized = findOversizedEmbedInputs(input, 50);

    expect(oversized).toEqual([{ index: 1, estimate: 100 }]);
  });

  it('counts CJK content at ~1 token per character', () => {
    const cjk = '你好世界'; // 4 tokens
    expect(findOversizedEmbedInputs([cjk], 3).length).toBe(1);
    expect(findOversizedEmbedInputs([cjk], 4)).toEqual([]);
  });
});

describe('OllamaClient.embedBatch: context-window pre-flight', () => {
  it('warns through the logger when an input exceeds defaultContextLength but still sends', async () => {
    const warn = vi.fn();
    const mock = embedFetchMock();
    const client = makeClient(mock.fetchMock, {
      defaultContextLength: 10,
      logger: { ...NOOP_LOGGER, warn },
    });

    const result = await client.embedBatch({
      model: 'm',
      input: ['short', 'y'.repeat(500)], // ~125 tokens > 10
    });

    expect(result.embeddings.length).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toContain('exceed the 10-token context window');
    expect(String(warn.mock.calls[0])).toContain('#1');
    // The injected num_ctx made the window explicit on the wire.
    expect(mock.calls[0]?.options?.num_ctx).toBe(10);
  });

  it('throws client-side under onContextOverflow: throw before any request', async () => {
    const mock = embedFetchMock();
    const client = makeClient(mock.fetchMock, {
      defaultContextLength: 8,
      onContextOverflow: 'throw',
    });

    await expect(
      client.embedBatch({ model: 'm', input: ['fine', 'z'.repeat(200)] }),
    ).rejects.toMatchObject({ code: 'context_overflow' });
    expect(mock.fetchMock).not.toHaveBeenCalled();
  });

  it('does not warn when no window is resolvable (no defaultContextLength, no num_ctx)', async () => {
    const warn = vi.fn();
    const mock = embedFetchMock();
    const client = makeClient(mock.fetchMock, { logger: { ...NOOP_LOGGER, warn } });

    await client.embedBatch({ model: 'm', input: ['x'.repeat(5000)] });

    expect(warn).not.toHaveBeenCalled();
  });

  it('respects an explicit num_ctx over defaultContextLength for both guard and wire', async () => {
    const warn = vi.fn();
    const mock = embedFetchMock();
    const client = makeClient(mock.fetchMock, {
      defaultContextLength: 5,
      logger: { ...NOOP_LOGGER, warn },
    });

    await client.embedBatch({ model: 'm', input: ['x'.repeat(40)], options: { num_ctx: 1000 } });

    expect(warn).not.toHaveBeenCalled(); // ~10 tokens < explicit 1000 window
    expect(mock.calls[0]?.options?.num_ctx).toBe(1000);
  });
});
