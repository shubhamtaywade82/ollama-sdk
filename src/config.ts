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
  /** Multiple named endpoints for rotation and automatic failover. */
  readonly endpoints?: readonly OllamaEndpoint[];
  /** Tuning options for endpoint circuit breaker. */
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
