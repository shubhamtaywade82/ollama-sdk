/**
 * Multi-host model-affinity routing — prefer the endpoint already holding the
 * requested model in VRAM.
 *
 * Ollama daemons keep a bounded set of models resident (`OLLAMA_MAX_LOADED_MODELS`).
 * With several interchangeable endpoints serving the same models, sending a request
 * to a host that doesn't currently hold the model forces an unload/cold-load swap
 * on that host — the thrashing `ModelAffinityScheduler` avoids for a *single*
 * client's task queues. This router brings the same affinity to the *multi-host*
 * request path: given the candidate endpoints `executeWithFailover` would try
 * anyway, it reorders them so hosts whose `GET /api/ps` shows the requested model
 * resident come first.
 *
 * Design constraints (see ADR 0028):
 *
 * - **Zero added request latency.** Reordering is synchronous and consults only
 *   cached `/api/ps` snapshots. A request never waits for a probe: when a
 *   snapshot is missing or stale, the request proceeds with the unchanged
 *   candidate order and the refresh happens in the background, warming the cache
 *   for subsequent requests.
 * - **Race-free with `least-connections`.** The reorder runs entirely between the
 *   registry's synchronous `candidates()`/`filterWithCapacity()` and the
 *   endpoint's `acquire()` — no `await` in between — so the strategy's
 *   no-two-calls-pick-the-same-idle-endpoint guarantee is untouched. Affinity
 *   only reorders *within each priority tier* of the runnable set: a
 *   higher-priority endpoint is always tried before a lower-priority one, and
 *   per-strategy ordering is kept inside the resident/non-resident groups.
 * - **Best-effort, never blocking, never failing a request.** A probe failure is
 *   recorded with a short backoff (`failureRetryMs`) and never cached as data;
 *   the affected endpoint is simply treated as unknown until a probe succeeds.
 * - **Fresh-data-only decisions.** Only snapshots within `ttlMs` reorder
 *   requests — `/api/ps` can change at any moment (evictions, other clients),
 *   so stale data is treated as no data. Last-known snapshots are still exposed
 *   via `status()` for observability.
 */

import { isModelResident } from '../context-discovery.js';
import type { OllamaEndpoint } from './endpoint-registry.js';

/**
 * One `/api/ps` running-model entry, as the router consumes it — name/model only.
 * Optional to match the generated `Ps` wire shape; hand-written `ModelResponse`
 * values (required fields) are assignable as-is.
 */
export interface AffinityRunningModel {
  readonly name?: string | undefined;
  readonly model?: string | undefined;
}

/**
 * Options for dynamic model-affinity routing across endpoints. Configured under
 * `OllamaClientConfig.endpointHealth.modelAffinity`; implemented by
 * `OllamaClient`'s request path (`executeWithFailover`), which has HTTP access —
 * the `EndpointRegistry` itself ignores this key.
 */
export interface ModelAffinityRoutingOptions {
  /**
   * How long a `GET /api/ps` snapshot stays fresh enough to reorder requests
   * (default 30_000ms). Mirrors `ModelAffinityScheduler`'s `psCacheTtlMs`.
   */
  readonly ttlMs?: number | undefined;
  /**
   * How long a failed `/api/ps` probe suppresses retries against that endpoint
   * (default 5_000ms) — a dead host isn't probed on every request while it's
   * down, and comes back automatically once it recovers. Failures are never
   * cached as data.
   */
  readonly failureRetryMs?: number | undefined;
}

/** Introspection snapshot for one endpoint's affinity cache. */
export interface ModelAffinitySnapshot {
  readonly endpointName: string;
  readonly baseUrl: string;
  /** Model names reported resident by the last successful probe (may be stale). */
  readonly loadedModels: readonly string[];
  /** When the last successful probe completed — `undefined` if it never succeeded. */
  readonly fetchedAt: number | undefined;
  /** Whether the snapshot is within `ttlMs` and therefore still drives reordering. */
  readonly fresh: boolean;
}

interface CacheEntry {
  readonly models: readonly AffinityRunningModel[];
  readonly fetchedAt: number;
}

/** Test seam: injectable clock — defaults to `Date.now`. */
export type NowFn = () => number;

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_FAILURE_RETRY_MS = 5_000;

/**
 * Cache-and-reorder engine for multi-host model affinity. See the module docs for
 * the design constraints; `OllamaClient` constructs one (only when
 * `endpointHealth.modelAffinity` is set) and calls {@link reorder} synchronously
 * inside its request path.
 */
export class ModelAffinityRouter {
  private readonly fetchPs: (endpoint: OllamaEndpoint) => Promise<readonly AffinityRunningModel[]>;
  private readonly ttlMs: number;
  private readonly failureRetryMs: number;
  private readonly now: NowFn;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly failedAt = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    fetchPs: (endpoint: OllamaEndpoint) => Promise<readonly AffinityRunningModel[]>,
    options: ModelAffinityRoutingOptions & { readonly now?: NowFn } = {},
  ) {
    this.fetchPs = fetchPs;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.failureRetryMs = options.failureRetryMs ?? DEFAULT_FAILURE_RETRY_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Synchronously reorders `candidates` so that, within each priority tier
   * (run of consecutive equal `priority`), endpoints whose fresh `/api/ps`
   * snapshot shows `model` resident come first (relative order preserved within
   * each group). Never moves an endpoint across tiers. Returns the input unchanged — and kicks a background refresh —
   * when any candidate's snapshot is missing or stale: a wrong reorder is worse
   * than no reorder, and the first request after a cache miss simply isn't
   * reordered. No-op without a `model` or with fewer than two candidates.
   */
  reorder(
    candidates: readonly OllamaEndpoint[],
    model: string | undefined,
  ): readonly OllamaEndpoint[] {
    if (model === undefined || candidates.length < 2) return candidates;

    const currentTime = this.now();
    let allFresh = true;
    for (const endpoint of candidates) {
      const entry = this.cache.get(endpoint.name);
      if (entry === undefined || currentTime - entry.fetchedAt > this.ttlMs) {
        allFresh = false;
        this.kickRefresh(endpoint);
      }
    }
    if (!allFresh) return candidates;

    const isResident = (ep: OllamaEndpoint): boolean => {
      const entry = this.cache.get(ep.name);
      return entry !== undefined && isModelResident(entry.models, model);
    };

    // Affinity only breaks ties *within* a priority tier: a higher-priority
    // endpoint is always tried before a lower-priority one, resident or not.
    // Tiers are runs of consecutive equal `priority` (unset = 0, as in the
    // registry), so whatever order the registry produced between runs —
    // priority-sorted, or the fail-open recovery order — is kept as-is.
    const reordered: OllamaEndpoint[] = [];
    let changed = false;
    for (let start = 0; start < candidates.length;) {
      const tierPriority = candidates[start]!.priority ?? 0;
      let end = start + 1;
      while (end < candidates.length && (candidates[end]!.priority ?? 0) === tierPriority) end++;
      const tier = candidates.slice(start, end);
      const resident = tier.filter(isResident);
      if (resident.length === 0 || resident.length === tier.length) {
        reordered.push(...tier);
      } else {
        const tierOrder = [...resident, ...tier.filter((ep) => !isResident(ep))];
        changed ||= tierOrder.some((ep, i) => ep !== tier[i]);
        reordered.push(...tierOrder);
      }
      start = end;
    }
    return changed ? reordered : candidates;
  }

  /**
   * Forces a refresh of the affinity cache for the given endpoints (deduped with
   * any in-flight refresh; bypasses the failure backoff, because this is an
   * explicit caller request — `client.warmModelAffinity()`). Resolves once every
   * probe has settled — successfully or not; individual failures never reject.
   */
  async warm(endpoints: readonly OllamaEndpoint[]): Promise<void> {
    await Promise.all(endpoints.map((endpoint) => this.refresh(endpoint)));
  }

  /** Introspection snapshots for the given endpoints (defaults to cached ones). */
  status(endpoints?: readonly OllamaEndpoint[]): readonly ModelAffinitySnapshot[] {
    const names =
      endpoints !== undefined
        ? endpoints.map((ep) => ep.name)
        : [...this.cache.keys(), ...this.failedAt.keys()];
    const byName = new Map((endpoints ?? []).map((ep) => [ep.name, ep] as const));
    const currentTime = this.now();
    return names
      .filter((name, i, arr) => arr.indexOf(name) === i)
      .map((name) => {
        const entry = this.cache.get(name);
        return {
          endpointName: name,
          baseUrl: byName.get(name)?.baseUrl ?? '',
          loadedModels:
            entry?.models.map((m) => m.name ?? m.model ?? '').filter((n) => n !== '') ?? [],
          fetchedAt: entry?.fetchedAt,
          fresh: entry !== undefined && currentTime - entry.fetchedAt <= this.ttlMs,
        };
      });
  }

  /**
   * Starts (or joins) a background refresh for `endpoint`, unless one is already
   * in flight or the failure backoff suppresses it. Fire-and-forget: the promise
   * is stored only for dedupe/warm-joins; callers never await it on the request
   * path.
   */
  private kickRefresh(endpoint: OllamaEndpoint): void {
    if (this.inflight.has(endpoint.name)) return; // deduped inside refresh() too
    const lastFailure = this.failedAt.get(endpoint.name);
    if (lastFailure !== undefined && this.now() - lastFailure < this.failureRetryMs) return;
    void this.refresh(endpoint);
  }

  /** Refreshes one endpoint's snapshot; never rejects (failures record a backoff). */
  private refresh(endpoint: OllamaEndpoint): Promise<void> {
    const existing = this.inflight.get(endpoint.name);
    if (existing !== undefined) return existing;

    const attempt = this.fetchPs(endpoint)
      .then((models) => {
        this.cache.set(endpoint.name, { models, fetchedAt: this.now() });
        this.failedAt.delete(endpoint.name);
      })
      .catch(() => {
        // Unreachable host, auth hiccup, timeout — affinity routing is
        // best-effort. Record a backoff so a dead endpoint isn't re-probed on
        // every single request, and never cache a failure as data: the endpoint
        // is simply "unknown" until a probe succeeds. (A previous success stays
        // in the cache for `status()` observability but is too stale to reorder.)
        this.failedAt.set(endpoint.name, this.now());
      })
      .finally(() => {
        this.inflight.delete(endpoint.name);
      });

    this.inflight.set(endpoint.name, attempt);
    return attempt;
  }
}
