import { describe, expect, it, vi } from 'vitest';
import { ModelAffinityRouter } from '../src/providers/model-affinity-router.js';
import type { AffinityRunningModel } from '../src/providers/model-affinity-router.js';
import type { OllamaEndpoint } from '../src/providers/endpoint-registry.js';
import { OllamaClient } from '../src/client.js';

/**
 * Dynamic multi-host model-affinity routing (Oct-10 digest gap, and the
 * digest's "tomorrow's focus" item): reorder each request's candidate
 * endpoints so hosts whose GET /api/ps shows the requested model already
 * resident in VRAM are tried first. Zero added request latency (synchronous,
 * cache-only reorder + background refresh), best-effort (failures never block
 * or fail a request), and race-free with the 'least-connections' strategy
 * (no await between candidate selection and acquire). See ADR 0028.
 */

function endpoint(name: string, baseUrl: string): OllamaEndpoint {
  return { name, baseUrl };
}

const EPS: readonly OllamaEndpoint[] = [
  endpoint('gpu-a', 'http://gpu-a:11434'),
  endpoint('gpu-b', 'http://gpu-b:11434'),
  endpoint('gpu-c', 'http://gpu-c:11434'),
];

const names = (eps: readonly OllamaEndpoint[]): readonly string[] => eps.map((e) => e.name);

function psOf(...modelNames: readonly string[]): readonly AffinityRunningModel[] {
  return modelNames.map((name) => ({ name, model: name }));
}

/** Lets all pending microtasks (probe .then/.catch handlers) settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('ModelAffinityRouter (unit)', () => {
  it('returns candidates unchanged and kicks a background refresh when nothing is cached', async () => {
    const fetchPs = vi.fn().mockResolvedValue(psOf());
    const router = new ModelAffinityRouter(fetchPs, { now: () => 1_000 });

    expect(names(router.reorder(EPS, 'llama3'))).toEqual(names(EPS)); // no reorder on unknown
    expect(fetchPs).toHaveBeenCalledTimes(3); // one probe per candidate, kicked in the background
    await vi.waitFor(() => expect(router.status(EPS).every((s) => s.fresh)).toBe(true));
  });

  it('reorders resident hosts first, preserving relative order within groups', async () => {
    const fetchPs = vi.fn(async (ep: OllamaEndpoint) =>
      ep.name === 'gpu-b' ? psOf('llama3:latest') : psOf(),
    );
    let now = 1_000;
    const router = new ModelAffinityRouter(fetchPs, { now: () => now });
    await router.warm(EPS); // all snapshots stamped at t=1000
    now += 1; // stay within the ttl

    // gpu-b holds llama3 → first; gpu-a/gpu-c keep their relative order after it.
    expect(names(router.reorder(EPS, 'llama3'))).toEqual(['gpu-b', 'gpu-a', 'gpu-c']);
    // A different model nobody holds → unchanged.
    expect(names(router.reorder(EPS, 'mistral'))).toEqual(names(EPS));
  });

  it('reorders by tag-less prefix the way Ollama resolves model names', async () => {
    const fetchPs = vi.fn(async (ep: OllamaEndpoint) =>
      ep.name === 'gpu-c' ? psOf('llama3:8b') : psOf(),
    );
    let now = 1_000;
    const router = new ModelAffinityRouter(fetchPs, { now: () => now });
    await router.warm(EPS);
    now += 1;

    expect(names(router.reorder(EPS, 'llama3'))).toEqual(['gpu-c', 'gpu-a', 'gpu-b']);
  });

  it('does not bleed near-name matches (llama ≠ llama3.1 / llama32)', async () => {
    const fetchPs = vi.fn(async (ep: OllamaEndpoint) =>
      ep.name === 'gpu-a' ? psOf('llama:latest', 'llama3.1:8b') : psOf(),
    );
    let now = 1_000;
    const router = new ModelAffinityRouter(fetchPs, { now: () => now });
    await router.warm(EPS);
    now += 1;

    expect(names(router.reorder(EPS, 'llama'))).toEqual(['gpu-a', 'gpu-b', 'gpu-c']);
    expect(names(router.reorder(EPS, 'llama3'))).toEqual(names(EPS)); // prefix needs the ':'
  });

  it('treats partial knowledge as no knowledge — no reorder while any candidate is stale', async () => {
    const fetchPs = vi.fn(async (ep: OllamaEndpoint) =>
      ep.name === 'gpu-a' ? psOf('llama3:latest') : psOf(),
    );
    let now = 1_000;
    const router = new ModelAffinityRouter(fetchPs, { ttlMs: 10_000, now: () => now });

    // Stagger the snapshot ages: gpu-a/gpu-b warm at t=1000, gpu-c at t=1050.
    await router.warm(EPS.slice(0, 2));
    now += 50;
    await router.warm(EPS.slice(2, 3));

    // At t=11020 the first two are stale (10_020 > ttl) while gpu-c is still
    // fresh (9_970 ≤ ttl): one unknown candidate suppresses the whole reorder —
    // routing on partial residency data risks sending the request to a host
    // that just evicted the model.
    now += 9_970;
    expect(names(router.reorder(EPS, 'llama3'))).toEqual(names(EPS));
    await vi.waitFor(() => expect(router.status(EPS).every((s) => s.fresh)).toBe(true));
    expect(names(router.reorder(EPS, 'llama3'))).toEqual(['gpu-a', 'gpu-b', 'gpu-c']);
  });

  it('never caches probe failures and backs off instead of hammering a dead host', async () => {
    let now = 1_000;
    const fetchPs = vi.fn(async (ep: OllamaEndpoint) => {
      if (ep.name === 'gpu-a') throw new Error('ECONNREFUSED');
      return psOf('llama3:latest');
    });
    const router = new ModelAffinityRouter(fetchPs, {
      ttlMs: 10_000,
      failureRetryMs: 5_000,
      now: () => now,
    });

    // First reorder kicks probes for all three: gpu-a's fails, the others cache.
    router.reorder(EPS, 'llama3');
    await vi.waitFor(() =>
      expect(
        router
          .status(EPS)
          .filter((s) => s.endpointName !== 'gpu-a')
          .every((s) => s.fresh),
      ).toBe(true),
    );
    await flush(); // let gpu-a's failure handler stamp its backoff
    expect(router.status(EPS).find((s) => s.endpointName === 'gpu-a')).toMatchObject({
      fetchedAt: undefined, // failures are never cached as data
      fresh: false,
    });

    // Within the failure backoff window gpu-a is not re-probed…
    now += 1_000;
    router.reorder(EPS, 'llama3');
    router.reorder(EPS, 'llama3');
    expect(fetchPs).toHaveBeenCalledTimes(3); // no new probe for gpu-a

    // …and since one candidate is unknown, the reorder is suppressed.
    expect(names(router.reorder(EPS, 'llama3'))).toEqual(names(EPS));

    // After the backoff, a retry is allowed again.
    now += 4_500;
    router.reorder(EPS, 'llama3');
    await vi.waitFor(() => expect(fetchPs).toHaveBeenCalledTimes(4));
  });

  it('dedupes concurrent refreshes into one probe per endpoint', async () => {
    const fetchPs = vi.fn(async () => psOf());
    const router = new ModelAffinityRouter(fetchPs, { now: () => 1_000 });

    router.reorder(EPS, 'llama3'); // kicks all three probes
    router.reorder(EPS, 'llama3'); // cache still empty → would kick, but deduped
    router.reorder(EPS, 'llama3');
    await router.warm(EPS); // joins the in-flight refreshes instead of adding more

    expect(fetchPs).toHaveBeenCalledTimes(3); // exactly one probe per endpoint
  });

  it('is a no-op without a model or with fewer than two candidates', async () => {
    const fetchPs = vi.fn(async () => psOf());
    const router = new ModelAffinityRouter(fetchPs, { now: () => 1_000 });

    expect(names(router.reorder(EPS, undefined))).toEqual(names(EPS));
    expect(names(router.reorder(EPS.slice(0, 1), 'llama3'))).toEqual(['gpu-a']);
    expect(fetchPs).not.toHaveBeenCalled(); // nothing to learn from a probe
  });

  it('status() reports loaded model names, freshness, and fetch time', async () => {
    let now = 1_000;
    const fetchPs = vi.fn(async (ep: OllamaEndpoint) =>
      ep.name === 'gpu-b' ? psOf('qwen2.5:7b', 'nomic-embed-text') : psOf(),
    );
    const router = new ModelAffinityRouter(fetchPs, { ttlMs: 1_000, now: () => now });
    await router.warm(EPS); // snapshots stamped at t=1000 (clock hasn't moved)
    now += 1;

    const status = router.status(EPS);
    expect(status.find((s) => s.endpointName === 'gpu-b')).toMatchObject({
      baseUrl: 'http://gpu-b:11434',
      loadedModels: ['qwen2.5:7b', 'nomic-embed-text'],
      fetchedAt: 1_000,
      fresh: true,
    });
    now += 2_000;
    expect(router.status(EPS).every((s) => s.fresh)).toBe(false);
  });

  it('warm() bypasses the failure backoff (explicit caller request)', async () => {
    const now = 1_000;
    const fetchPs = vi.fn(async (ep: OllamaEndpoint) => {
      // gpu-a fails on its very first probe only.
      if (ep.name === 'gpu-a' && fetchPs.mock.calls.length <= 1) throw new Error('down');
      return psOf('llama3:latest');
    });
    const router = new ModelAffinityRouter(fetchPs, { failureRetryMs: 60_000, now: () => now });

    router.reorder(EPS, 'llama3'); // gpu-a's probe fails (call 1); b/c succeed (2, 3)
    await flush();

    // Even though the backoff window (60s) hasn't passed, an explicit warm
    // re-probes everything immediately — gpu-a included (calls 4–6).
    await router.warm(EPS);
    expect(fetchPs).toHaveBeenCalledTimes(6);
    expect(router.status(EPS).find((s) => s.endpointName === 'gpu-a')?.fetchedAt).toBe(1_000);
  });
});

describe('OllamaClient model-affinity routing (integration)', () => {
  const chatBody = (model: string): string =>
    JSON.stringify({
      model,
      created_at: '2026-10-10T00:00:00Z',
      message: { role: 'assistant', content: 'ok' },
      done: true,
      done_reason: 'stop',
    });

  /**
   * Fetch mock routing by URL: `/api/chat` (counted per host, answered with a
   * valid chat response), `/api/ps` (per-host scripted running models).
   */
  function routingFetch(residentHost: 'ep1' | 'ep2', psFailureHost?: 'ep1' | 'ep2') {
    const state = {
      chatCalls: { ep1: 0, ep2: 0 },
      psCalls: { ep1: 0, ep2: 0 },
      urls: [] as string[],
    };
    const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
      const url = String(input);
      state.urls.push(url);
      const host = url.includes('ep1') ? 'ep1' : 'ep2';
      if (url.endsWith('/api/ps')) {
        state.psCalls[host] += 1;
        if (host === psFailureHost) {
          return new Response('unreachable', { status: 503 });
        }
        const models =
          host === residentHost
            ? [{ name: 'llama3:latest', model: 'llama3', size: 1, size_vram: 1 }]
            : [];
        return new Response(JSON.stringify({ models }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/chat')) {
        state.chatCalls[host] += 1;
        return new Response(chatBody('llama3'), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
    return { fetchMock, state };
  }

  const endpoints = [
    { name: 'ep1', baseUrl: 'http://ep1:11434' },
    { name: 'ep2', baseUrl: 'http://ep2:11434' },
  ];

  it('issues no /api/ps probes at all unless modelAffinity is configured', async () => {
    const { fetchMock, state } = routingFetch('ep2');
    const client = new OllamaClient({ endpoints, fetch: fetchMock as unknown as typeof fetch });

    await client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });
    await client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'again' }] });

    expect(state.chatCalls.ep1).toBe(2);
    expect(state.chatCalls.ep2).toBe(0);
    expect(state.psCalls.ep1 + state.psCalls.ep2).toBe(0); // zero probes, zero overhead
    expect(client.modelAffinityStatus()).toEqual([]);
    await client.warmModelAffinity(); // no-op, resolves immediately
    expect(state.psCalls.ep1 + state.psCalls.ep2).toBe(0);
  });

  it('self-warms on the first request, then routes to the host holding the model', async () => {
    const { fetchMock, state } = routingFetch('ep2'); // llama3 lives on ep2
    const client = new OllamaClient({
      endpoints,
      fetch: fetchMock as unknown as typeof fetch,
      endpointHealth: { modelAffinity: {} },
    });

    // First request: no affinity knowledge yet → registration order (ep1),
    // and the background refresh probes both hosts.
    await client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });
    expect(state.chatCalls.ep1).toBe(1);
    await vi.waitFor(() => expect(state.psCalls.ep1 + state.psCalls.ep2).toBe(2));

    // Second request: fresh snapshots say ep2 holds llama3 → routed there.
    await client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'again' }] });
    expect(state.chatCalls.ep2).toBe(1);
    expect(state.chatCalls.ep1).toBe(1); // unchanged — no wasted request to ep1

    const status = client.modelAffinityStatus();
    expect(status).toHaveLength(2);
    expect(status.find((s) => s.endpointName === 'ep2')?.loadedModels).toEqual(['llama3:latest']);
    expect(status.every((s) => s.fresh)).toBe(true);
  });

  it('warmModelAffinity() pre-warms so even the first request routes by residency', async () => {
    const { fetchMock, state } = routingFetch('ep2');
    const client = new OllamaClient({
      endpoints,
      fetch: fetchMock as unknown as typeof fetch,
      endpointHealth: { modelAffinity: {} },
    });

    await client.warmModelAffinity();
    expect(state.psCalls.ep1 + state.psCalls.ep2).toBe(2);

    await client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });
    expect(state.chatCalls.ep2).toBe(1); // routed straight to the resident host
    expect(state.chatCalls.ep1).toBe(0);
  });

  it('degrades gracefully when one host cannot answer /api/ps', async () => {
    const { fetchMock, state } = routingFetch('ep2', 'ep2'); // ps fails on ep2
    const client = new OllamaClient({
      endpoints,
      fetch: fetchMock as unknown as typeof fetch,
      endpointHealth: { modelAffinity: { failureRetryMs: 60_000 } },
    });

    await client.warmModelAffinity(); // ep1 succeeds, ep2's probe 503s
    const status = client.modelAffinityStatus();
    expect(status.find((s) => s.endpointName === 'ep2')?.fetchedAt).toBeUndefined();

    // Partial knowledge → no reorder (unchanged order), and the request itself
    // is unaffected by the probe failure: chat succeeds via ep1.
    await client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });
    expect(state.chatCalls.ep1).toBe(1);

    // The failed probe is not retried within the backoff window.
    await client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'again' }] });
    expect(state.psCalls.ep2).toBe(1);
  });

  it('never reorders a singleEndpoint-pinned operation away from its one candidate', async () => {
    const { fetchMock, state } = routingFetch('ep2');
    const client = new OllamaClient({
      endpoints,
      fetch: fetchMock as unknown as typeof fetch,
      endpointHealth: { modelAffinity: {} },
    });
    await client.warmModelAffinity(); // fleet-wide by design — probes BOTH hosts
    state.urls.length = 0;

    // capabilities() is singleEndpoint-pinned (targets one concrete host's
    // state — ADR 0008): affinity must not move it to the second candidate,
    // even though ep2 holds the model.
    try {
      await client.capabilities('llama3');
    } catch {
      // The mock has no real /api/show payload — a rejection here is fine;
      // what matters is which hosts were contacted.
    }
    expect(state.urls.length).toBeGreaterThan(0);
    expect(state.urls.every((u) => u.includes('ep1'))).toBe(true);
    expect(state.psCalls.ep1 + state.psCalls.ep2).toBe(2); // no new probes either
  });
});
