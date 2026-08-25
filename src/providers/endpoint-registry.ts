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
}

export class EndpointRegistry {
  private readonly endpoints: readonly OllamaEndpoint[];
  private readonly failureCounts = new Map<string, number>();
  private readonly lastFailures = new Map<string, number>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(endpoints: readonly OllamaEndpoint[], options: EndpointRegistryOptions = {}) {
    this.endpoints =
      endpoints.length > 0 ? endpoints : [{ name: 'default', baseUrl: 'http://localhost:11434' }];
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Endpoints eligible for `model`, sorted healthy-first-by-priority (falling back to
   * soonest-to-recover if every eligible endpoint is cooling down). When `model` is
   * given, endpoints whose `models` allow-list doesn't include it are excluded entirely —
   * see `OllamaEndpoint.models`. Omit `model` to consider every configured endpoint,
   * regardless of any `models` restriction (used for non-model-scoped operations).
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
      return healthy.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
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
