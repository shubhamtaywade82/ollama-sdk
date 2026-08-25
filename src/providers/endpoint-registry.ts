/**
 * Multi-endpoint registry with priority routing and circuit breaker failover.
 */

import { OllamaAbortError } from '../errors.js';

export interface OllamaEndpoint {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly priority?: number | undefined;
  /**
   * Restricts this endpoint/credential to a specific set of models — for the common case
   * of several Ollama Cloud API keys, each entitled to a different model. When set,
   * `EndpointRegistry.candidates(model)` only returns this endpoint for a request whose
   * `model` is in the list, so cross-endpoint failover never retries a request against a
   * credential that isn't authorized for the requested model. Omit (the default) to make
   * the endpoint eligible for every model, preserving prior behavior.
   */
  readonly models?: readonly string[] | undefined;
}

export interface EndpointHealth {
  readonly endpoint: OllamaEndpoint;
  readonly failureCount: number;
  readonly lastFailureTimestamp?: number | undefined;
  readonly isCoolingDown: boolean;
  /** In-flight requests currently attempting this endpoint — see `acquire`/`release`. */
  readonly activeRequests: number;
}

export interface EndpointRegistryOptions {
  readonly failureThreshold?: number | undefined;
  readonly cooldownMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  /**
   * How candidates that share the same `priority` are ordered within `candidates()`.
   * `'priority'` (the default) keeps them in registration order, so the same candidate is
   * always tried first while it stays healthy. `'round-robin'` rotates each same-priority
   * group by one position per `candidates()` call — i.e. per `chat`/`generate`/etc. call —
   * so consecutive requests spread across a pool of interchangeable endpoints/credentials
   * instead of always preferring the first one (the common case: several Ollama Cloud keys
   * registered with no `models` restriction, meant to be used interchangeably). Endpoints
   * at different priorities are unaffected either way — a higher-priority one is still
   * always tried first, and failover to the rest of the group still applies if the
   * rotated-to-front candidate fails.
   *
   * `'least-connections'` instead orders each same-priority group by ascending in-flight
   * request count (tracked via `acquire`/`release`, ties broken by registration order),
   * so a request always prefers whichever candidate currently has the fewest requests
   * still in progress. Unlike `'round-robin'`, this remains correct under uneven or
   * overlapping request durations — e.g. several Ollama Cloud accounts each limited to 1
   * concurrent request: firing several requests at once (`Promise.all`) deterministically
   * lands each on a different account rather than risking two landing on the same
   * still-busy one, because `candidates()` and the subsequent `acquire()` for the chosen
   * candidate run synchronously with no `await` in between — JS's single-threaded
   * execution means no two concurrent calls can observe the same "0 active" snapshot for
   * the same candidate.
   */
  readonly strategy?: 'priority' | 'round-robin' | 'least-connections' | undefined;
  /**
   * Caps in-flight requests per endpoint (tracked via `acquire`/`release`). Unset (the
   * default) means no cap — candidates are never treated as saturated. When set, a
   * request whose every otherwise-eligible candidate is already at this cap waits
   * (`waitForCapacity`, FIFO per candidate) for one of them to free up, instead of being
   * sent to an already-saturated candidate. Pairs naturally with `strategy:
   * 'least-connections'` for a pool of accounts each limited to N concurrent requests —
   * e.g. `maxConcurrentPerEndpoint: 1` for several Ollama Cloud free-tier accounts, so
   * `N + 1` concurrent calls against `N` such accounts run `N` immediately and queue the
   * rest, rather than the `(N+1)`th overrunning whichever account looks "least busy" at
   * that instant. Waiting is bounded by the request's own timeout/`AbortSignal`, same as
   * any other in-flight request — it never blocks indefinitely on its own.
   */
  readonly maxConcurrentPerEndpoint?: number | undefined;
}

interface CapacityWaiter {
  readonly names: readonly string[];
  readonly resolve: () => void;
  cleanup: () => void;
}

export class EndpointRegistry {
  private readonly endpoints: readonly OllamaEndpoint[];
  private readonly failureCounts = new Map<string, number>();
  private readonly lastFailures = new Map<string, number>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly strategy: 'priority' | 'round-robin' | 'least-connections';
  private roundRobinCounter = 0;
  private readonly activeCounts = new Map<string, number>();
  private readonly maxConcurrentPerEndpoint: number | undefined;
  private readonly waiters: CapacityWaiter[] = [];

  constructor(endpoints: readonly OllamaEndpoint[], options: EndpointRegistryOptions = {}) {
    this.endpoints =
      endpoints.length > 0 ? endpoints : [{ name: 'default', baseUrl: 'http://localhost:11434' }];
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.strategy = options.strategy ?? 'priority';
    this.maxConcurrentPerEndpoint = options.maxConcurrentPerEndpoint;
  }

  /**
   * Marks one more request as in-flight against `name`. Callers (`OllamaClient`) must
   * pair every `acquire` with a `release` once that attempt finishes, success or not —
   * see `OllamaClient.executeWithFailover`. Only affects candidate ordering when
   * `strategy` is `'least-connections'`; harmless (just bookkeeping) otherwise, and
   * always reflected in `status()`'s `activeRequests`.
   */
  acquire(name: string): void {
    this.activeCounts.set(name, (this.activeCounts.get(name) ?? 0) + 1);
  }

  /** Releases one in-flight request marked via `acquire`, waking one waiter for `name` if any. */
  release(name: string): void {
    const next = (this.activeCounts.get(name) ?? 0) - 1;
    if (next <= 0) {
      this.activeCounts.delete(name);
    } else {
      this.activeCounts.set(name, next);
    }
    const idx = this.waiters.findIndex((w) => w.names.includes(name));
    if (idx !== -1) {
      const [waiter] = this.waiters.splice(idx, 1);
      waiter?.cleanup();
      waiter?.resolve();
    }
  }

  /**
   * `candidates` filtered down to those currently under `maxConcurrentPerEndpoint` (all
   * of them, unchanged, if that option is unset).
   */
  filterWithCapacity(candidates: readonly OllamaEndpoint[]): OllamaEndpoint[] {
    const cap = this.maxConcurrentPerEndpoint;
    if (cap === undefined) return [...candidates];
    return candidates.filter((ep) => (this.activeCounts.get(ep.name) ?? 0) < cap);
  }

  /**
   * Resolves once any endpoint named in `names` has spare capacity under
   * `maxConcurrentPerEndpoint` (a no-op resolve if that option is unset, or if one
   * already does). Otherwise queues (FIFO per name) until a matching `release()` frees a
   * slot, or rejects if `signal` aborts first — mirroring whatever aborted it
   * (`OllamaTimeoutError`/the caller's own abort reason) so callers see the same error
   * shape as any other in-flight request that times out or is cancelled. FIFO order is
   * best-effort (a newly-arriving request can still win a race for a slot that just
   * freed) — the capacity cap itself, not fairness, is the guarantee this exists for.
   */
  waitForCapacity(names: readonly string[], signal?: AbortSignal): Promise<void> {
    const cap = this.maxConcurrentPerEndpoint;
    if (cap === undefined) return Promise.resolve();
    if (names.some((n) => (this.activeCounts.get(n) ?? 0) < cap)) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const waiter: CapacityWaiter = { names, resolve, cleanup: () => undefined };
      const onAbort = (): void => {
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new OllamaAbortError('Aborted while waiting for endpoint capacity'),
        );
      };
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.waiters.push(waiter);
    });
  }

  /**
   * Rotates each same-`priority` group in `sorted` (already sorted highest-priority-first)
   * by one position further per call, wrapping around within the group. Priority tiers
   * themselves are never reordered — only candidates that were already tied.
   */
  private applyRoundRobin(sorted: readonly OllamaEndpoint[]): OllamaEndpoint[] {
    const offset = this.roundRobinCounter++;
    const result: OllamaEndpoint[] = [];
    let i = 0;
    while (i < sorted.length) {
      const priority = sorted[i]?.priority ?? 0;
      let j = i + 1;
      while (j < sorted.length && (sorted[j]?.priority ?? 0) === priority) j++;
      const tier = sorted.slice(i, j);
      const rotation = offset % tier.length;
      result.push(...tier.slice(rotation), ...tier.slice(0, rotation));
      i = j;
    }
    return result;
  }

  /**
   * Reorders each same-`priority` group in `sorted` by ascending in-flight request count
   * (from `acquire`/`release`); a stable sort, so candidates tied on active count keep
   * their relative (priority-then-registration) order. Priority tiers themselves are
   * never reordered.
   */
  private applyLeastConnections(sorted: readonly OllamaEndpoint[]): OllamaEndpoint[] {
    const result: OllamaEndpoint[] = [];
    let i = 0;
    while (i < sorted.length) {
      const priority = sorted[i]?.priority ?? 0;
      let j = i + 1;
      while (j < sorted.length && (sorted[j]?.priority ?? 0) === priority) j++;
      const tier = [...sorted.slice(i, j)].sort(
        (a, b) => (this.activeCounts.get(a.name) ?? 0) - (this.activeCounts.get(b.name) ?? 0),
      );
      result.push(...tier);
      i = j;
    }
    return result;
  }

  /**
   * Endpoints eligible for `model`, sorted healthy-first-by-priority (falling back to
   * soonest-to-recover if every eligible endpoint is cooling down); same-priority
   * candidates are further reordered per `options.strategy` (see
   * `EndpointRegistryOptions.strategy`). When `model` is given, endpoints whose `models`
   * allow-list doesn't include it are excluded entirely — see `OllamaEndpoint.models`.
   * Omit `model` to consider every configured endpoint, regardless of any `models`
   * restriction (used for non-model-scoped operations).
   */
  candidates(model?: string): OllamaEndpoint[] {
    const currentTime = this.now();
    const scoped =
      model === undefined
        ? this.endpoints
        : this.endpoints.filter((ep) => ep.models === undefined || ep.models.includes(model));
    const healthy: OllamaEndpoint[] = [];
    const coolingDown: Array<{ endpoint: OllamaEndpoint; recoveredAt: number }> = [];

    for (const ep of scoped) {
      const failures = this.failureCounts.get(ep.name) ?? 0;
      const lastFail = this.lastFailures.get(ep.name) ?? 0;
      const isCooling =
        failures >= this.failureThreshold && currentTime - lastFail < this.cooldownMs;

      if (!isCooling) {
        healthy.push(ep);
      } else {
        coolingDown.push({ endpoint: ep, recoveredAt: lastFail + this.cooldownMs });
      }
    }

    if (healthy.length > 0) {
      const sorted = healthy.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      if (this.strategy === 'round-robin') return this.applyRoundRobin(sorted);
      if (this.strategy === 'least-connections') return this.applyLeastConnections(sorted);
      return sorted;
    }

    // Fail-open: sort by soonest-to-recover
    return coolingDown.sort((a, b) => a.recoveredAt - b.recoveredAt).map((c) => c.endpoint);
  }

  reportSuccess(name: string): void {
    this.failureCounts.delete(name);
    this.lastFailures.delete(name);
  }

  reportFailure(name: string): void {
    const current = (this.failureCounts.get(name) ?? 0) + 1;
    this.failureCounts.set(name, current);
    this.lastFailures.set(name, this.now());
  }

  list(): readonly OllamaEndpoint[] {
    return this.endpoints;
  }

  /** True if any configured endpoint restricts itself to a `models` allow-list. */
  hasModelScopedEndpoints(): boolean {
    return this.endpoints.some((ep) => ep.models !== undefined);
  }

  status(): EndpointHealth[] {
    const currentTime = this.now();
    return this.endpoints.map((ep) => {
      const failures = this.failureCounts.get(ep.name) ?? 0;
      const lastFail = this.lastFailures.get(ep.name);
      const isCoolingDown =
        failures >= this.failureThreshold &&
        lastFail !== undefined &&
        currentTime - lastFail < this.cooldownMs;

      return {
        endpoint: ep,
        failureCount: failures,
        ...(lastFail !== undefined ? { lastFailureTimestamp: lastFail } : {}),
        isCoolingDown,
        activeRequests: this.activeCounts.get(ep.name) ?? 0,
      };
    });
  }
}
