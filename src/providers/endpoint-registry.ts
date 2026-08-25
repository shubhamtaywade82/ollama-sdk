/**
 * Multi-endpoint registry with priority routing and circuit breaker failover.
 */

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
   */
  readonly strategy?: 'priority' | 'round-robin' | undefined;
}

export class EndpointRegistry {
  private readonly endpoints: readonly OllamaEndpoint[];
  private readonly failureCounts = new Map<string, number>();
  private readonly lastFailures = new Map<string, number>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly strategy: 'priority' | 'round-robin';
  private roundRobinCounter = 0;

  constructor(endpoints: readonly OllamaEndpoint[], options: EndpointRegistryOptions = {}) {
    this.endpoints =
      endpoints.length > 0 ? endpoints : [{ name: 'default', baseUrl: 'http://localhost:11434' }];
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.strategy = options.strategy ?? 'priority';
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
      return this.strategy === 'round-robin' ? this.applyRoundRobin(sorted) : sorted;
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
      };
    });
  }
}
