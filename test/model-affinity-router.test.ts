import { describe, expect, it, vi } from 'vitest';
import {
  ModelAffinityRouter,
  type AffinityRunningModel,
} from '../src/providers/model-affinity-router.js';
import { isModelResident } from '../src/context-discovery.js';
import type { OllamaEndpoint } from '../src/providers/endpoint-registry.js';

const ep = (name: string): OllamaEndpoint => ({ name, baseUrl: `http://${name}` });
const A = ep('a');
const B = ep('b');
const C = ep('c');

function setup(
  loaded: Record<string, readonly AffinityRunningModel[] | Error>,
  options: { ttlMs?: number; failureRetryMs?: number } = {},
) {
  let clock = 1_000;
  const fetchPs = vi.fn(async (endpoint: OllamaEndpoint) => {
    const value = loaded[endpoint.name];
    if (value instanceof Error) throw value;
    return value ?? [];
  });
  const router = new ModelAffinityRouter(fetchPs, { ...options, now: () => clock });
  return {
    router,
    fetchPs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const names = (eps: readonly OllamaEndpoint[]) => eps.map((e) => e.name);

describe('ModelAffinityRouter.reorder', () => {
  it('returns the input unchanged on a cold cache and kicks a background refresh', () => {
    const { router, fetchPs } = setup({ b: [{ name: 'llama3:latest' }] });
    const input = [A, B];
    expect(router.reorder(input, 'llama3')).toBe(input);
    expect(fetchPs).toHaveBeenCalledTimes(2);
  });

  it('moves hosts with the model resident to the front once every snapshot is fresh', async () => {
    const { router } = setup({
      a: [],
      b: [{ name: 'llama3:latest' }],
      c: [{ model: 'llama3:latest' }],
    });
    await router.warm([A, B, C]);
    expect(names(router.reorder([A, B, C], 'llama3'))).toEqual(['b', 'c', 'a']);
  });

  it('preserves relative order within the resident and non-resident groups', async () => {
    const { router } = setup({ a: [{ name: 'm:1' }], b: [], c: [{ name: 'm:1' }] });
    await router.warm([A, B, C]);
    expect(names(router.reorder([C, B, A], 'm:1'))).toEqual(['c', 'a', 'b']);
  });

  it('leaves order unchanged when all or none of the candidates hold the model', async () => {
    const all = setup({ a: [{ name: 'm' }], b: [{ name: 'm' }] });
    await all.router.warm([A, B]);
    const input = [A, B];
    expect(all.router.reorder(input, 'm')).toBe(input);

    const none = setup({ a: [], b: [] });
    await none.router.warm([A, B]);
    expect(none.router.reorder(input, 'm')).toBe(input);
  });

  it('does not reorder on partial knowledge (one snapshot missing)', async () => {
    const { router } = setup({ b: [{ name: 'm' }] });
    await router.warm([B]);
    const input = [A, B];
    expect(router.reorder(input, 'm')).toBe(input);
  });

  it('is a no-op without a model or with fewer than two candidates', () => {
    const { router, fetchPs } = setup({});
    const two = [A, B];
    const one = [A];
    expect(router.reorder(two, undefined)).toBe(two);
    expect(router.reorder(one, 'm')).toBe(one);
    expect(fetchPs).not.toHaveBeenCalled();
  });

  it('stops reordering once snapshots exceed ttlMs, and refreshes them', async () => {
    const { router, fetchPs, advance } = setup({ a: [], b: [{ name: 'm' }] }, { ttlMs: 100 });
    await router.warm([A, B]);
    expect(names(router.reorder([A, B], 'm'))).toEqual(['b', 'a']);
    advance(101);
    fetchPs.mockClear();
    const input = [A, B];
    expect(router.reorder(input, 'm')).toBe(input);
    expect(fetchPs).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent refreshes for the same endpoint', () => {
    const { router, fetchPs } = setup({});
    router.reorder([A, B], 'm');
    router.reorder([A, B], 'm');
    router.reorder([A, B], 'm');
    expect(fetchPs).toHaveBeenCalledTimes(2);
  });
});

describe('ModelAffinityRouter failure handling', () => {
  it('backs off a failing endpoint for failureRetryMs and never caches the failure', async () => {
    const { router, fetchPs, advance } = setup(
      { a: new Error('ECONNREFUSED'), b: [{ name: 'm' }] },
      { failureRetryMs: 50 },
    );
    await router.warm([A, B]);
    fetchPs.mockClear();

    router.reorder([A, B], 'm');
    expect(fetchPs.mock.calls.map(([e]) => e.name)).toEqual([]);
    expect(router.status([A]).at(0)?.fetchedAt).toBeUndefined();

    advance(51);
    router.reorder([A, B], 'm');
    expect(fetchPs.mock.calls.map(([e]) => e.name)).toEqual(['a']);
  });

  it('warm() bypasses the backoff and never rejects', async () => {
    const { router, fetchPs } = setup({ a: new Error('down') }, { failureRetryMs: 60_000 });
    await expect(router.warm([A])).resolves.toBeUndefined();
    await expect(router.warm([A])).resolves.toBeUndefined();
    expect(fetchPs).toHaveBeenCalledTimes(2);
  });
});

describe('ModelAffinityRouter.status', () => {
  it('reports loaded models, fetch time and freshness per endpoint', async () => {
    const { router, advance } = setup({ a: [{ name: 'm:1' }, { model: 'n:2' }] }, { ttlMs: 10 });
    await router.warm([A]);
    expect(router.status([A, B])).toEqual([
      {
        endpointName: 'a',
        baseUrl: 'http://a',
        loadedModels: ['m:1', 'n:2'],
        fetchedAt: 1_000,
        fresh: true,
      },
      {
        endpointName: 'b',
        baseUrl: 'http://b',
        loadedModels: [],
        fetchedAt: undefined,
        fresh: false,
      },
    ]);
    advance(11);
    expect(router.status([A]).at(0)?.fresh).toBe(false);
  });
});

describe('isModelResident', () => {
  const ps = [{ name: 'llama3:latest' }, { model: 'qwen2.5:7b' }];
  it.each([
    ['llama3', true],
    ['llama3:latest', true],
    ['qwen2.5:7b', true],
    ['qwen2.5', true],
    ['llama', false],
    ['llama3.1', false],
    ['qwen2.5:14b', false],
  ])('%s -> %s', (model, expected) => {
    expect(isModelResident(ps, model)).toBe(expected);
  });
});
