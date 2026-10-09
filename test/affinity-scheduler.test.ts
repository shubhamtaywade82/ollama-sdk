import { describe, expect, it, vi } from 'vitest';
import { ModelAffinityScheduler } from '../src/affinity.js';
import type { ModelAffinityClient } from '../src/affinity.js';
import { OllamaClientError } from '../src/errors.js';

/**
 * Model-affinity scheduling (src/affinity.ts): per-model serial queues,
 * distinct-model caps, affinity-sticky dispatch order, and loaded-model
 * candidate selection via a TTL-cached /api/ps.
 */

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type PsResult = { models: { name: string }[] };

function stubClient(psImpl?: () => Promise<PsResult>): {
  client: ModelAffinityClient;
  ps: ReturnType<typeof vi.fn>;
} {
  const ps = vi.fn(psImpl ?? (async () => ({ models: [] }) as PsResult));
  const client = { models: { ps: ps as unknown as () => Promise<PsResult> } };
  return { client: client as unknown as ModelAffinityClient, ps };
}

const flush = async (times = 4) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

describe('ModelAffinityScheduler dispatch', () => {
  it('serializes tasks on the same model (never overlaps, FIFO order)', async () => {
    const { client } = stubClient();
    const scheduler = new ModelAffinityScheduler(client);
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const gate = deferred<void>();

    const p1 = scheduler.run('a', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push('t1');
      await gate.promise;
      active -= 1;
    });
    await flush();
    const p2 = scheduler.run('a', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push('t2');
      active -= 1;
    });
    await flush();

    expect(order).toEqual(['t1']); // t2 waits while t1 is in flight
    gate.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['t1', 't2']);
    expect(maxActive).toBe(1);
  });

  it('caps distinct active models at concurrentModels (default 1)', async () => {
    const { client } = stubClient();
    const scheduler = new ModelAffinityScheduler(client);
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const gate = deferred<void>();

    const pa = scheduler.run('a', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push('a');
      await gate.promise;
      active -= 1;
    });
    await flush();
    const pb = scheduler.run('b', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push('b');
      active -= 1;
    });
    await flush();

    expect(order).toEqual(['a']); // b waits: one model hot at a time
    gate.resolve();
    await Promise.all([pa, pb]);
    expect(order).toEqual(['a', 'b']);
    expect(maxActive).toBe(1);
  });

  it('is affinity-sticky: deepens the active model before starting the next one', async () => {
    const { client } = stubClient();
    const scheduler = new ModelAffinityScheduler(client);
    const order: string[] = [];
    const gate = deferred<void>();

    const pa1 = scheduler.run('a', async () => {
      order.push('a1');
      await gate.promise;
    });
    await flush();
    const pb = scheduler.run('b', async () => {
      order.push('b');
    });
    const pa2 = scheduler.run('a', async () => {
      order.push('a2');
    });
    await flush();

    expect(order).toEqual(['a1']);
    gate.resolve();
    await Promise.all([pa1, pb, pa2]);
    // a2 (same model as the active one) runs BEFORE b — the anti-thrashing order.
    expect(order).toEqual(['a1', 'a2', 'b']);
  });

  it('lets same-model tasks run in parallel up to perModelConcurrency', async () => {
    const { client } = stubClient();
    const scheduler = new ModelAffinityScheduler(client, {
      concurrentModels: 1,
      perModelConcurrency: 2,
    });
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const gate = deferred<void>();

    const pa1 = scheduler.run('a', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push('a1');
      await gate.promise;
      active -= 1;
    });
    await flush();
    const pa2 = scheduler.run('a', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push('a2');
      active -= 1;
    });
    const pb = scheduler.run('b', async () => {
      order.push('b');
    });
    await flush();

    expect(order).toEqual(['a1', 'a2']); // both a-tasks in flight, b still waiting
    gate.resolve();
    await Promise.all([pa1, pa2, pb]);
    expect(order).toEqual(['a1', 'a2', 'b']);
    expect(maxActive).toBe(2);
  });

  it('a rejected task rejects its own run() but never poisons the queues', async () => {
    const { client } = stubClient();
    const scheduler = new ModelAffinityScheduler(client);

    await expect(
      scheduler.run('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const after = await scheduler.run('a', async () => 'ok');
    expect(after).toBe('ok');
    expect(scheduler.stats.queuedTasks).toBe(0);
  });
});

describe('ModelAffinityScheduler candidate selection', () => {
  it('prefers the already-loaded candidate via /api/ps', async () => {
    const { client, ps } = stubClient(async () => ({ models: [{ name: 'b:latest' }] }));
    const scheduler = new ModelAffinityScheduler(client, { psCacheTtlMs: 60_000 });

    const chosen = await scheduler.run(['a', 'b:latest'], (model) => Promise.resolve(model));
    expect(chosen).toBe('b:latest');
    expect(ps).toHaveBeenCalledTimes(1);
  });

  it('falls back to the first candidate when none is loaded', async () => {
    const { client } = stubClient(async () => ({ models: [] }));
    const scheduler = new ModelAffinityScheduler(client, { psCacheTtlMs: 60_000 });

    const chosen = await scheduler.run(['a', 'b'], (model) => Promise.resolve(model));
    expect(chosen).toBe('a');
  });

  it('single-model tasks never touch /api/ps', async () => {
    const { client, ps } = stubClient();
    const scheduler = new ModelAffinityScheduler(client);

    await scheduler.run('a', () => Promise.resolve(1));
    await scheduler.run('a:latest', () => Promise.resolve(2));
    expect(ps).not.toHaveBeenCalled();
  });

  it('caches /api/ps for the configured TTL', async () => {
    const { client, ps } = stubClient(async () => ({ models: [] }));
    const scheduler = new ModelAffinityScheduler(client, { psCacheTtlMs: 60_000 });

    await scheduler.run(['a', 'b'], (m) => Promise.resolve(m));
    await scheduler.run(['a', 'b'], (m) => Promise.resolve(m));
    await scheduler.loadedModels();
    expect(ps).toHaveBeenCalledTimes(1);
  });

  it('degrades to the first candidate when /api/ps fails, without caching the failure', async () => {
    let fail = true;
    const { client, ps } = stubClient(async () => {
      if (fail) throw new Error('unreachable');
      return { models: [{ name: 'b' }] };
    });
    const scheduler = new ModelAffinityScheduler(client, { psCacheTtlMs: 60_000 });

    const first = await scheduler.run(['a', 'b'], (m) => Promise.resolve(m));
    expect(first).toBe('a');

    fail = false;
    const second = await scheduler.run(['a', 'b'], (m) => Promise.resolve(m));
    expect(second).toBe('b'); // retried the lookup after the failure
    expect(ps).toHaveBeenCalledTimes(2);
  });
});

describe('ModelAffinityScheduler lifecycle', () => {
  it('exposes live stats: active models and queued task count', async () => {
    const { client } = stubClient();
    const scheduler = new ModelAffinityScheduler(client);
    const gate = deferred<void>();

    const pa = scheduler.run('a', () => gate.promise.then(() => 'a'));
    await flush();
    void scheduler.run('a', async () => 'a2');
    void scheduler.run('b', async () => 'b');
    await flush();

    expect(scheduler.stats).toEqual({ activeModels: ['a'], queuedTasks: 2 });
    gate.resolve();
    await pa;
  });

  it('dispose() resolves only after every queue drains', async () => {
    const { client } = stubClient();
    const scheduler = new ModelAffinityScheduler(client);
    const gate = deferred<void>();

    const pa = scheduler.run('a', () => gate.promise.then(() => 'done'));
    void scheduler.run('b', async () => 'b');
    await flush();

    let disposed = false;
    const disposePromise = scheduler.dispose().then(() => {
      disposed = true;
    });
    await flush();
    expect(disposed).toBe(false);

    gate.resolve();
    await pa;
    await disposePromise;
    expect(disposed).toBe(true);
    expect(scheduler.stats).toEqual({ activeModels: [], queuedTasks: 0 });
  });

  it('validates options and candidates up front', async () => {
    const { client } = stubClient();
    expect(() => new ModelAffinityScheduler(client, { concurrentModels: 0 })).toThrow(
      OllamaClientError,
    );
    expect(() => new ModelAffinityScheduler(client, { perModelConcurrency: 0 })).toThrow(
      OllamaClientError,
    );
    expect(() => new ModelAffinityScheduler(client, { psCacheTtlMs: -1 })).toThrow(
      OllamaClientError,
    );

    const scheduler = new ModelAffinityScheduler(client);
    await expect(scheduler.run([], () => Promise.resolve(1))).rejects.toThrow(OllamaClientError);
    await expect(scheduler.run('', () => Promise.resolve(1))).rejects.toThrow(OllamaClientError);
  });
});
