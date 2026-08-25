/**
 * Configuration options and constants for OllamaClient.
 */

import type { Logger, RequestLifecycleHook } from './logger.js';
import type { Middleware } from './middleware.js';
import type { RetryConfig } from './transport/retry.js';
import type { FetchLike } from './transport/http.js';
import type { EndpointRegistryOptions, OllamaEndpoint } from './providers/endpoint-registry.js';

export const DEFAULT_BASE_URL = 'http://localhost:11434';
export const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Fixed host for Ollama's hosted web tools (`/api/web_search`, `/api/web_fetch`) — see
 * `OllamaClient.webSearch`/`webFetch`. These are an Ollama Cloud service reachable only
 * at this host, independent of any locally-configured `baseUrl`/`endpoints`.
 */
export const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com';

/**
 * Reads a process environment variable, if any. Guarded with `typeof process` rather
 * than importing `node:process` so this stays safe to call from Edge Runtimes (Cloudflare
 * Workers, Vercel Edge) where `process` doesn't exist — it just returns `undefined` there.
 */
function readEnv(name: string): string | undefined {
  return typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
}

/**
 * Resolves the default single-endpoint `baseUrl`, falling back to the `OLLAMA_HOST`
 * environment variable (the same one the official `ollama` CLI and client libraries
 * read) before `DEFAULT_BASE_URL`. Explicit `config.baseUrl` always wins.
 */
export function resolveBaseUrl(configBaseUrl?: string | undefined): string {
  return configBaseUrl ?? readEnv('OLLAMA_HOST') ?? DEFAULT_BASE_URL;
}

/**
 * Resolves the default single-endpoint `apiKey`, falling back to the `OLLAMA_API_KEY`
 * environment variable before leaving it unset. Explicit `config.apiKey` always wins.
 */
export function resolveApiKey(configApiKey?: string | undefined): string | undefined {
  return configApiKey ?? readEnv('OLLAMA_API_KEY');
}

/** One named credential for the `credentials`/`modelBindings` config shape. */
export interface OllamaCredentialConfig {
  readonly apiKey: string;
  /** Overrides `OllamaClientConfig.baseUrl` for requests made with this credential. */
  readonly baseUrl?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
}

/**
 * Builds synthetic `OllamaEndpoint`s (named `credential:<id>`) from `config.credentials` +
 * `config.modelBindings` — an ergonomic, map-based alternative to writing out `endpoints`
 * with per-entry `models` allow-lists directly. Both shapes feed the same
 * `EndpointRegistry`/`executeWithFailover` routing engine; this is pure config sugar, not
 * a separate routing mechanism. Returns `[]` if `config.credentials` is unset.
 *
 * A model bound to one credential (`modelBindings: { "minimax-m3": "coder" }`) scopes that
 * credential to only that model, same as `OllamaEndpoint.models`. A model bound to several
 * credentials (`modelBindings: { "gpt-oss:120b": ["key1", "key2"] }`) makes ordinary
 * endpoint failover apply between them. `config.defaultCredential`, if set, is given a
 * lower priority than explicitly-bound credentials and no `models` restriction, so it acts
 * as a catch-all for any model without an explicit binding without ever pre-empting one
 * that has.
 */
export function resolveCredentialEndpoints(
  config: Pick<OllamaClientConfig, 'credentials' | 'modelBindings' | 'defaultCredential' | 'baseUrl'>,
): readonly OllamaEndpoint[] {
  if (config.credentials === undefined) return [];

  const modelsByCredential = new Map<string, string[]>();
  for (const [model, bound] of Object.entries(config.modelBindings ?? {})) {
    for (const id of typeof bound === 'string' ? [bound] : bound) {
      if (!(id in config.credentials)) {
        throw new Error(
          `modelBindings["${model}"] references unknown credential "${id}" — it isn't ` +
            `in \`credentials\`. Known credentials: ${Object.keys(config.credentials).join(', ') || '(none)'}.`,
        );
      }
      const list = modelsByCredential.get(id) ?? [];
      list.push(model);
      modelsByCredential.set(id, list);
    }
  }

  return Object.entries(config.credentials).map(([id, credential]) => {
    const isDefault = id === config.defaultCredential;
    const boundModels = isDefault ? undefined : modelsByCredential.get(id);
    return {
      name: `credential:${id}`,
      baseUrl: resolveBaseUrl(credential.baseUrl ?? config.baseUrl),
      apiKey: credential.apiKey,
      ...(credential.headers !== undefined ? { headers: credential.headers } : {}),
      ...(boundModels !== undefined ? { models: boundModels } : {}),
      priority: isDefault ? -1 : 0,
    };
  });
}

export const DEFAULT_FAILOVER_CODES: readonly string[] = [
  'network_error',
  'timeout',
  'server_error',
  'rate_limited',
  'auth_error',
  // A candidate endpoint rejected the request pre-flight for a known-unsupported
  // capability (e.g. structured output against Ollama Cloud) — try the next candidate
  // rather than failing outright; see OllamaUnsupportedCapabilityError.
  'unsupported_capability',
];

export interface OllamaClientConfig {
  /**
   * Base URL of a single Ollama server. Ignored if `endpoints` is provided. Falls back to
   * the `OLLAMA_HOST` environment variable (when set and running under Node), then
   * `http://localhost:11434`.
   */
  readonly baseUrl?: string;
  /**
   * Bearer token sent as `Authorization: Bearer <apiKey>` for a single-endpoint setup.
   * Falls back to the `OLLAMA_API_KEY` environment variable (when set and running under
   * Node).
   */
  readonly apiKey?: string;
  /** Static headers merged into every request. */
  readonly headers?: Record<string, string>;
  /**
   * Multiple named endpoints for rotation and automatic failover. Each endpoint may
   * carry its own `apiKey` and, via `models`, be scoped to only the models that
   * credential is entitled to — see `OllamaEndpoint.models` for routing several
   * per-model Ollama Cloud API keys through a single client.
   */
  readonly endpoints?: readonly OllamaEndpoint[];
  /**
   * Named credentials, keyed by an id you choose — an ergonomic alternative to writing
   * out `endpoints` by hand for the common "several Ollama Cloud API keys, each entitled
   * to different models" shape. Combine with `modelBindings` to scope each credential to
   * the models it's authorized for; a credential with no binding (or set as
   * `defaultCredential`) is eligible for every model, same as an `OllamaEndpoint` with no
   * `models`. Merges additively with `endpoints` if both are given.
   */
  readonly credentials?: Readonly<Record<string, OllamaCredentialConfig>>;
  /**
   * Maps a model name to the `credentials` id (or ids, for several keys authorized for
   * the same model — ordinary failover applies between them) that may serve it. Has no
   * effect without `credentials`. Referencing an id not present in `credentials` throws
   * at construction time.
   */
  readonly modelBindings?: Readonly<Record<string, string | readonly string[]>>;
  /**
   * The `credentials` id to fall back to for a model with no entry in `modelBindings`.
   * Unset means such a model has no synthesized-from-`credentials` route — it still
   * routes normally through any plain `endpoints` entry without a `models` restriction.
   */
  readonly defaultCredential?: string | undefined;
  /**
   * Tuning options for the endpoint circuit breaker, and candidate selection ordering —
   * pass `{ strategy: 'round-robin' }` to spread requests across a pool of same-priority
   * endpoints/credentials (e.g. several unbound `credentials`) instead of always
   * preferring the first one, or `{ strategy: 'least-connections' }` to route each
   * request to whichever candidate currently has the fewest requests in flight (e.g.
   * several free-tier Ollama Cloud accounts, each capped at 1 concurrent request — this
   * deterministically spreads concurrent `Promise.all`-style calls one-per-account rather
   * than risking two landing on the same still-busy one), and `maxConcurrentPerEndpoint`
   * to cap that at an exact number and queue (rather than overrun a saturated candidate)
   * once every eligible one is at capacity — e.g. `{ strategy: 'least-connections',
   * maxConcurrentPerEndpoint: 1 }` for accounts that only allow one request at a time.
   * See `EndpointRegistryOptions`.
   */
  readonly endpointHealth?: EndpointRegistryOptions;
  /** Error codes that trigger failover to the next candidate endpoint. */
  readonly failoverOn?: readonly string[];
  /** Default per-request timeout in milliseconds (default 30_000ms). */
  readonly timeoutMs?: number;
  /** Retry configuration or retry count override. */
  readonly retries?: number | Partial<RetryConfig>;
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  readonly fetch?: FetchLike;
  /** Request/Response middleware list. */
  readonly middleware?: readonly Middleware[];
  /** Structured logger. */
  readonly logger?: Logger;
  /** Enables console debug logger if true. */
  readonly debug?: boolean;
  /** Request lifecycle hook for telemetry/metrics. */
  readonly onLifecycleEvent?: RequestLifecycleHook;
}
