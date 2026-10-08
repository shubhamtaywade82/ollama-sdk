/**
 * Main OllamaClient class with failover, streaming, structured outputs, and ecosystem integrations.
 */

import { z } from 'zod';
import {
  DEFAULT_BASE_URL,
  DEFAULT_FAILOVER_CODES,
  DEFAULT_TIMEOUT_MS,
  OLLAMA_CLOUD_BASE_URL,
  resolveApiKey,
  resolveEndpointApiKey,
  resolveBaseUrl,
  resolveCredentialEndpoints,
  type OllamaClientConfig,
} from './config.js';
import {
  OllamaAbortError,
  OllamaClientError,
  OllamaModelRoutingError,
  OllamaUnsupportedCapabilityError,
} from './errors.js';
import { createConsoleLogger, NOOP_LOGGER, type Logger } from './logger.js';
import { EndpointRegistry, type EndpointHealth } from './providers/endpoint-registry.js';
import { checkEndpointHealth, type EndpointHealthCheckResult } from './providers/health-check.js';
import {
  detectModelCapabilities,
  inferRuntimeMode,
  type ModelCapabilities,
  type RuntimeMode,
} from './capabilities/capabilities.js';
import { parseStructuredOutput, zodToJsonSchema } from './schema/zod.js';
import { normalizeChatStream, normalizeGenerateStream } from './streaming/normalize.js';
import { OllamaStream } from './streaming/stream.js';
import type { ChatStreamResult, GenerateStreamResult } from './streaming/types.js';
import { HttpClient, type BinaryBody, type FetchLike } from './transport/http.js';
import { DEFAULT_RETRY_CONFIG, withRetry, type RetryConfig } from './transport/retry.js';
import { createTimeoutSignal } from './transport/timeout.js';
import { ModelsClient } from './models-client.js';
import { OpenAICompatClient } from './integrations/openai.js';
import { AnthropicCompatClient } from './integrations/anthropic.js';
import { OllamaRuntime } from './generated/runtime/runtime.js';
import { ResponsesModule } from './responses.js';
import { ConversationSession, type ConversationSessionOptions } from './conversation.js';
import {
  batchEmbed,
  embedBatchOverflowMessage,
  findOversizedEmbedInputs,
  type EmbedBatchOptions,
  type EmbedBatchResult,
} from './embed-batch.js';
import {
  checkChatContext,
  checkGenerateContext,
  contextWarningMessage,
  type ContextCheck,
} from './context-safety.js';
import type { ModelOptions } from './types.js';
import { NativeApi } from './generated/api/native-api.js';
import { FailoverHttpClient } from './failover-http-client.js';
import { createDecision, type Decision } from './decision.js';
import type {
  SystemOneRequest as SystemOneRequestBase,
  SystemOneResponse as SystemOneResponseBase,
} from './generated/models/index.js';
import type { SystemOneQuestions, SystemOneRequest, SystemOneResponse } from './system-one.js';
import { ensureToolCallIds } from './tools/tool-call-id.js';
import { withEncodedImages, withEncodedMessageImages } from './utils.js';
import {
  withSpan,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_OLLAMA_ENDPOINT_NAME,
  ATTR_OLLAMA_ENDPOINT_ATTEMPT,
  GEN_AI_SYSTEM_OLLAMA,
} from './telemetry/index.js';
import type {
  ChatRequestOptions,
  ChatResponse,
  CopyRequestOptions,
  CreateRequestOptions,
  DeleteRequestOptions,
  EmbedRequestOptions,
  EmbedResponse,
  EmbeddingsRequestOptions,
  EmbeddingsResponse,
  GenerateRequestOptions,
  GenerateResponse,
  PullRequestOptions,
  PushRequestOptions,
  RequestCancellationOptions,
  ShowRequestOptions,
  UsageRequestOptions,
  WebFetchRequestOptions,
  WebFetchResponse,
  WebSearchRequestOptions,
  WebSearchResponse,
  BalanceRequestOptions,
} from './types.js';
import type { BalanceResponse, UsageResponse } from './generated/models/index.js';

let logicalRequestSequence = 0;

function createLogicalRequestId(): string {
  logicalRequestSequence += 1;
  return `ollama-request-${logicalRequestSequence}`;
}

/**
 * High-level Ollama client — the original, hand-written API surface.
 *
 * **Wave 8 (ADR 0018) deprecation notice:**
 *
 * For new code, prefer the generated `NativeApi` from
 * {@link ./generated/runtime/runtime.js} + {@link ./generated/api/native-api.js}
 * instead. The generated surface:
 *
 *   - Inherits every contract-layer guarantee (environment guards, version
 *     guards, streaming defaults) automatically from the canonical IR.
 *   - Stays in sync with the OpenAPI spec by construction — no hand-written
 *     surface to drift.
 *   - Uses the same `HttpClient` (and therefore the same middleware,
 *     retry, telemetry, and streaming pipeline) as this client.
 *
 * The migration path is non-breaking:
 *
 * ```ts
 * // Before (still works, no breaking changes):
 * const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
 * const res = await client.chat({ model, messages });
 *
 * // After (recommended for new code):
 * const http = new HttpClient({ baseUrl: 'http://localhost:11434' });
 * const runtime = new OllamaRuntime({ http });
 * const api = new NativeApi(runtime);
 * const res = await api.chat({ model, messages, stream: false });
 * ```
 *
 * `OllamaClient` is preserved verbatim — existing callers do not need to
 * change anything. New methods and operations will land on the generated
 * surface first; `OllamaClient` will receive them only as a follow-up.
 */
export class OllamaClient {
  readonly registry: EndpointRegistry;
  readonly models: ModelsClient;
  private readonly retryConfig: RetryConfig;
  private readonly timeoutMs: number;
  private readonly failoverCodes: Set<string>;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly middleware: OllamaClientConfig['middleware'];
  private readonly onLifecycleEvent: OllamaClientConfig['onLifecycleEvent'];
  /**
   * API key for Ollama's hosted web tools (`webSearch`/`webFetch`), which always target
   * `OLLAMA_CLOUD_BASE_URL` regardless of `config.endpoints` — an Ollama account API key
   * is inherently a single global credential, not tied to any one inference endpoint.
   * Resolved the same way as a single-endpoint `apiKey` (`config.apiKey` falling back to
   * `OLLAMA_API_KEY`), independent of whether `config.endpoints` was used instead.
   */
  private readonly cloudApiKey: string | undefined;
  /** Configured `defaultContextLength` — injected as `num_ctx` when a request omits it. */
  private readonly defaultContextLength: number | undefined;
  /** Configured `contextWarningThreshold` (default 0.9). */
  private readonly contextWarningThreshold: number | undefined;
  /** Configured overflow policy — `'warn'` (default) or `'throw'`. */
  private readonly onContextOverflow: 'warn' | 'throw';
  /**
   * Controllers for every in-flight request and active stream managed by this
   * client — see {@link OllamaClient.destroy} and {@link createRequestScope}.
   * Entries live for exactly as long as the underlying work does: until the
   * response settles (requests) or the stream's `finalResult` settles
   * (streams, via `executeWithFailover`'s `holdUntil` release path).
   */
  private readonly activeRequests = new Set<AbortController>();

  constructor(config: OllamaClientConfig = {}) {
    this.cloudApiKey = resolveApiKey(config.apiKey);
    const defaultBaseUrl = resolveBaseUrl(config.baseUrl);
    const resolvedApiKey = resolveEndpointApiKey(config.apiKey, defaultBaseUrl);
    const credentialEndpoints = resolveCredentialEndpoints(config);
    const endpoints =
      config.endpoints ??
      (credentialEndpoints.length > 0
        ? []
        : [
            {
              name: 'default',
              baseUrl: defaultBaseUrl,
              ...(resolvedApiKey !== undefined ? { apiKey: resolvedApiKey } : {}),
              ...(config.headers !== undefined ? { headers: config.headers } : {}),
            },
          ]);
    this.registry = new EndpointRegistry(
      [...endpoints, ...credentialEndpoints],
      config.endpointHealth,
    );
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.failoverCodes = new Set(config.failoverOn ?? DEFAULT_FAILOVER_CODES);
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.logger = config.logger ?? (config.debug ? createConsoleLogger() : NOOP_LOGGER);
    this.middleware = config.middleware;
    this.onLifecycleEvent = config.onLifecycleEvent;
    this.retryConfig =
      typeof config.retries === 'number'
        ? { ...DEFAULT_RETRY_CONFIG, maxRetries: config.retries }
        : { ...DEFAULT_RETRY_CONFIG, ...config.retries };
    this.defaultContextLength = config.defaultContextLength;
    this.contextWarningThreshold = config.contextWarningThreshold;
    this.onContextOverflow = config.onContextOverflow ?? 'warn';
    this.models = new ModelsClient((op, opts) => this.executeWithFailover(op, opts));
  }

  get modelsClient(): ModelsClient {
    return this.models;
  }

  /**
   * Return a generated {@link OllamaRuntime} that shares this client's
   * transport (HttpClient + middleware + retry + telemetry).
   *
   * Wave 8 (ADR 0018) bridge: lets callers mix the existing `OllamaClient`
   * API with the generated `NativeApi` / `OpenAIApi` / `AnthropicApi`
   * surface without configuring two separate HttpClient instances.
   *
   * Wave 14: the runtime now participates in multi-endpoint failover.
   * Each request is routed through this client's `executeWithFailover`
   * machinery via a {@link FailoverHttpClient} wrapper. If the first
   * candidate endpoint is down, requests automatically fail over to
   * the next healthy candidate — matching the behavior of the
   * hand-written OllamaClient methods (chat, generate, etc.).
   *
   * The runtime is cached on first call — subsequent calls return the
   * same instance. The `FailoverHttpClient` holds a reference to this
   * client, so it always sees the current endpoint registry state.
   */
  get runtime(): OllamaRuntime {
    if (this._runtime === undefined) {
      // Use the first candidate's baseUrl for inferRuntimeMode() — the
      // actual request routing picks the best healthy endpoint per call
      // via executeWithFailover.
      const candidates = this.registry.candidates();
      const endpoint = candidates[0];
      const baseUrl = endpoint?.baseUrl ?? 'http://localhost:11434';
      const http = new FailoverHttpClient(this, baseUrl);
      // Wave 15 (P0): provide a cloud HTTP backend for operations that
      // declare a non-default host (web search, web fetch). This lets
      // the generated runtime route host-bearing operations to
      // https://ollama.com with the configured API key, rather than
      // silently sending them to the local Ollama server.
      const cloudHttp = new HttpClient({
        baseUrl: OLLAMA_CLOUD_BASE_URL,
        ...(this.cloudApiKey !== undefined ? { apiKey: this.cloudApiKey } : {}),
        fetch: this.fetchImpl,
        ...(this.middleware !== undefined ? { middleware: this.middleware } : {}),
        ...(this.onLifecycleEvent !== undefined ? { onLifecycleEvent: this.onLifecycleEvent } : {}),
      });
      this._runtime = new OllamaRuntime({
        http,
        cloudHttp,
        localMode: inferRuntimeMode(baseUrl) === 'local',
      });
    }
    return this._runtime;
  }
  private _runtime: OllamaRuntime | undefined;

  /**
   * Lazily-constructed `NativeApi` bound to this client's runtime. Exposes
   * the full generated native API surface (chat, generate, embed, systemOne,
   * etc.) with contract-driven types and runtime enforcement.
   *
   * Wave 13: `systemOne()` delegates to this accessor.
   */
  get native(): NativeApi {
    if (this._nativeApi === undefined) {
      this._nativeApi = new NativeApi(this.runtime);
    }
    return this._nativeApi;
  }
  private _nativeApi: NativeApi | undefined;

  /**
   * Higher-level System One decision helpers (Wave 14B).
   *
   * Ergonomic wrappers around `systemOne()` for the six most common
   * decision patterns: `choice()`, `noul()`, `score()`, `route()`,
   * `verify()`, `rank()`. Each constructs a single-question request
   * and extracts the typed answer.
   *
   * ```ts
   * const result = await client.decision.choice({
   *   model: 'tev1:4b',
   *   state: 'Customer was charged twice',
   *   instructions: 'What is the primary intent?',
   *   criteria: {
   *     refund: 'Customer wants a refund',
   *     duplicate_charge: 'Customer reports multiple charges',
   *   },
   * });
   * console.log(result.choice); // 'duplicate_charge'
   * console.log(result.confidence); // 0.89
   * ```
   */
  get decision(): Decision {
    if (this._decision === undefined) {
      this._decision = createDecision(this);
    }
    return this._decision;
  }
  private _decision: Decision | undefined;

  /**
   * Ergonomic OpenAI Responses API bridge (`client.responses.create()` /
   * `.stream()`). Dual-mode transport: prefers the native `POST
   * /v1/responses` endpoint (Ollama ≥ v0.13.3) and transparently re-issues via
   * `/api/chat` when the server answers 404, so migrating OpenAI code works
   * unchanged against older servers. See `src/responses.ts`.
   */
  get responses(): ResponsesModule {
    if (this._responses === undefined) {
      this._responses = new ResponsesModule((op, opts) => this.executeWithFailover(op, opts));
    }
    return this._responses;
  }
  private _responses: ResponsesModule | undefined;

  /**
   * Starts a KV-prefix-preserving multi-turn conversation session.
   *
   * ```ts
   * const session = client.session('llama3.1', 'You are a concise assistant.');
   * const reply = await session.send('Hi!');
   * const detail = await session.sendTurn('Why is the sky blue?');
   * detail.cache.hitRate; // per-turn KV-cache hit rate
   * session.cacheStats; // cumulative stats across turns
   * ```
   *
   * Accepts either `(model, systemPrompt?)` or a full options object
   * (`{ model, systemPrompt, options, think, keep_alive, tools }`). See
   * `src/conversation.ts` for why the system prompt is pinned for the
   * session's lifetime.
   */
  session(model: string, systemPrompt?: string): ConversationSession;
  session(options: ConversationSessionOptions): ConversationSession;
  session(
    modelOrOptions: string | ConversationSessionOptions,
    systemPrompt?: string,
  ): ConversationSession {
    const options: ConversationSessionOptions =
      typeof modelOrOptions === 'string'
        ? {
            model: modelOrOptions,
            ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          }
        : modelOrOptions;
    return new ConversationSession(this, options);
  }

  /**
   * Context-window pre-flight enforcement — see `src/context-safety.ts` and
   * the `defaultContextLength` / `onContextOverflow` config docs. Logs a
   * warning (default) or throws client-side when the estimated prompt size
   * is close to / beyond the effective context window.
   */
  private enforceContextSafety(kind: 'chat' | 'generate', check: ContextCheck): void {
    if (!check.exceedsThreshold) return;
    const message = contextWarningMessage(check, kind);
    if (this.onContextOverflow === 'throw') {
      throw new OllamaClientError(message, { code: 'context_overflow' });
    }
    this.logger.warn(message);
  }

  /**
   * Returns `options` with `num_ctx` injected from the client's
   * `defaultContextLength` when the request didn't set one — making the
   * effective context window explicit on the wire instead of relying on
   * Ollama's silently-truncating server default. Returns the original
   * reference when there's nothing to inject (the common case).
   */
  private injectDefaultContextLength(options: ModelOptions | undefined): ModelOptions | undefined {
    if (options?.num_ctx !== undefined || this.defaultContextLength === undefined) {
      return options;
    }
    return { ...options, num_ctx: this.defaultContextLength };
  }

  /**
   * Creates the per-request abort scope registered with {@link destroy}:
   * a controller that fires when the caller's `signal` aborts OR when
   * `destroy()` runs, whichever comes first. `dispose()` removes the
   * registration when the work it guards settles — for plain requests when
   * the response settles, for streams when `finalResult` settles (the same
   * moment `executeWithFailover`'s `holdUntil` releases the endpoint slot),
   * so a destroy() can tear down a stream mid-consumption but never outlives
   * one that already finished.
   */
  private createRequestScope(userSignal: AbortSignal | undefined): {
    signal: AbortSignal;
    dispose: () => void;
  } {
    const controller = new AbortController();
    const propagateUserAbort = (): void => {
      controller.abort(userSignal?.reason);
    };
    let detach: (() => void) | undefined;
    if (userSignal) {
      if (userSignal.aborted) {
        propagateUserAbort();
      } else {
        userSignal.addEventListener('abort', propagateUserAbort, { once: true });
        detach = () => userSignal.removeEventListener('abort', propagateUserAbort);
      }
    }
    this.activeRequests.add(controller);
    return {
      signal: controller.signal,
      dispose: () => {
        detach?.();
        this.activeRequests.delete(controller);
      },
    };
  }

  /**
   * Fail-fast guard for `format` (structured output) requests: throws before any network
   * call if the candidate endpoint is inferred as Ollama Cloud, which does not currently
   * support structured outputs (see `ModelCapabilities.supportsStructuredOutputRequest`).
   * `unsupported_capability` is in `DEFAULT_FAILOVER_CODES`, so in a multi-endpoint setup
   * this causes failover to the next candidate rather than failing the whole request.
   */
  private assertStructuredOutputSupported(baseUrl: string, model: string): void {
    if (inferRuntimeMode(baseUrl) === 'cloud') {
      throw new OllamaUnsupportedCapabilityError(
        `Structured output ("format") requests are not supported against Ollama Cloud ` +
          `endpoints (model "${model}" via ${baseUrl}). This is a known Ollama Cloud ` +
          `limitation, not a bug in this SDK.`,
        { capability: 'structuredOutputRequest' },
      );
    }
  }

  async executeWithFailover<T>(
    operation: (http: HttpClient, signal: AbortSignal) => Promise<T>,
    options?: {
      signal?: AbortSignal | undefined;
      timeoutMs?: number | undefined;
      /**
       * Disables cross-endpoint failover: only the single best candidate endpoint is
       * tried (same-endpoint retry via `withRetry` still applies). For operations whose
       * target IS the endpoint — model catalog/blob management — a different endpoint
       * isn't an interchangeable substitute, so failing over to one would silently
       * operate on the wrong server's state rather than retrying "the same" request. See
       * ADR 0008. Defaults to `false`, preserving normal failover for inference calls.
       */
      singleEndpoint?: boolean | undefined;
      /**
       * The model this request targets, used to filter candidates by
       * `OllamaEndpoint.models` (credential-scoped routing — see that field's docs).
       * Requests without a `model` (e.g. `listModels`) consider every configured
       * endpoint, same as before this option existed.
       */
      model?: string | undefined;
      /**
       * For an operation whose real completion outlasts its own returned promise — a
       * streaming response, specifically — defers releasing the endpoint's concurrency
       * slot (see `EndpointRegistryOptions.maxConcurrentPerEndpoint`/`'least-connections'`)
       * until the promise this returns settles, instead of releasing as soon as
       * `operation` resolves. Pass `(stream) => stream.finalResult` for `chatStream`/
       * `generateStream` so the slot stays held for as long as the underlying HTTP
       * connection realistically does — until the stream is fully consumed, errors, or is
       * aborted. Omit for anything whose returned promise already represents the whole
       * request/response (the default, and correct for every non-streaming call).
       */
      holdUntil?: ((result: T) => Promise<unknown>) | undefined;
    },
  ): Promise<T> {
    const scope = this.createRequestScope(options?.signal);
    const timeout = createTimeoutSignal(options?.timeoutMs ?? this.timeoutMs, scope.signal);
    const requestId = createLogicalRequestId();
    let deferTimeoutCancel = false;
    try {
      let lastError: Error | undefined;

      for (;;) {
        const allCandidates = this.registry.candidates(options?.model);
        if (
          allCandidates.length === 0 &&
          options?.model !== undefined &&
          this.registry.hasModelScopedEndpoints()
        ) {
          const configured = this.registry
            .list()
            .flatMap((ep) => ep.models ?? [])
            .filter((m, i, arr) => arr.indexOf(m) === i);
          throw new OllamaModelRoutingError(
            `No configured endpoint is authorized for model "${options.model}". ` +
              (configured.length > 0
                ? `Endpoints are scoped to: ${configured.join(', ')}.`
                : 'No endpoint declares a `models` allow-list that includes it.') +
              ' Add or widen an `OllamaEndpoint.models` entry to route this model.',
            { model: options.model, availableModels: configured },
          );
        }
        const candidates = options?.singleEndpoint ? allCandidates.slice(0, 1) : allCandidates;

        const runnable = this.registry.filterWithCapacity(candidates);
        if (runnable.length === 0 && candidates.length > 0) {
          await this.registry.waitForCapacity(
            candidates.map((c) => c.name),
            timeout.signal,
          );
          continue;
        }

        for (const [attemptIndex, endpoint] of runnable.entries()) {
          this.logger.debug(`Executing on endpoint "${endpoint.name}" (${endpoint.baseUrl})`);
          const http = new HttpClient({
            baseUrl: endpoint.baseUrl,
            ...(endpoint.apiKey !== undefined ? { apiKey: endpoint.apiKey } : {}),
            ...(endpoint.headers !== undefined ? { headers: endpoint.headers } : {}),
            fetch: this.fetchImpl,
            middleware: this.middleware,
            onLifecycleEvent: this.onLifecycleEvent,
            requestId,
          });

          // Acquired synchronously, right after this endpoint was chosen from
          // `candidates()`/`filterWithCapacity()` with no `await` in between — see
          // `EndpointRegistryOptions.strategy`'s `'least-connections'` doc for why that
          // ordering is what makes it race-free.
          this.registry.acquire(endpoint.name);
          let holdPromise: Promise<unknown> | undefined;
          try {
            const result = await withSpan(
              'ollama.endpoint.attempt',
              {
                [ATTR_OLLAMA_ENDPOINT_NAME]: endpoint.name,
                [ATTR_OLLAMA_ENDPOINT_ATTEMPT]: attemptIndex,
              },
              () =>
                withRetry(
                  () => operation(http, timeout.signal),
                  {
                    ...this.retryConfig,
                    onRetry: (error, attempt, delayMs) => {
                      this.retryConfig.onRetry?.(error, attempt, delayMs);
                      this.onLifecycleEvent?.({
                        type: 'retry',
                        requestId,
                        attempt: attempt + 1,
                        error,
                        delayMs,
                        timestamp: Date.now(),
                      });
                    },
                  },
                  timeout.signal,
                ),
            );
            this.registry.reportSuccess(endpoint.name);
            if (options?.holdUntil) {
              holdPromise = options.holdUntil(result);
              deferTimeoutCancel = true;
            }
            return result;
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            lastError = error;
            this.registry.reportFailure(endpoint.name);
            this.logger.warn(`Failed on "${endpoint.name}": ${error.message}`);
            if (!(error instanceof OllamaClientError && this.failoverCodes.has(error.code)))
              throw error;
          } finally {
            if (holdPromise) {
              void holdPromise
                .catch(() => undefined)
                .finally(() => {
                  timeout.cancel();
                  scope.dispose();
                  this.registry.release(endpoint.name);
                });
            } else {
              this.registry.release(endpoint.name);
            }
          }
        }
        throw lastError ?? new Error('No healthy Ollama endpoints available');
      }
    } finally {
      if (!deferTimeoutCancel) {
        timeout.cancel();
        scope.dispose();
      }
    }
  }

  // --- Chat ---
  chat(
    req: ChatRequestOptions & { stream: true },
  ): Promise<OllamaStream<ChatResponse, ChatStreamResult>>;
  chat(req: ChatRequestOptions & { stream?: false | undefined }): Promise<ChatResponse>;
  chat(
    req: ChatRequestOptions,
  ): Promise<ChatResponse | OllamaStream<ChatResponse, ChatStreamResult>>;
  async chat(
    req: ChatRequestOptions,
  ): Promise<ChatResponse | OllamaStream<ChatResponse, ChatStreamResult>> {
    const encodedMessages = await withEncodedMessageImages(req.messages, req.signal);
    const messages = encodedMessages.map((message) => {
      if (message.role === 'tool' && message.tool_call_id !== undefined) {
        const { tool_call_id: _toolCallId, ...nativeMessage } = message;
        return nativeMessage;
      }
      return message;
    });
    // Context-window pre-flight: warn (or throw) before sending when the
    // estimated prompt is close to / beyond the effective window, and make
    // the window explicit by injecting `defaultContextLength` as `num_ctx`.
    this.enforceContextSafety(
      'chat',
      checkChatContext(req, {
        defaultContextLength: this.defaultContextLength,
        threshold: this.contextWarningThreshold,
      }),
    );
    const options = this.injectDefaultContextLength(req.options);
    if (req.stream) {
      return this.executeWithFailover(
        async (http, signal) => {
          if (req.format !== undefined)
            this.assertStructuredOutputSupported(http.baseUrl, req.model);
          const stream = await http.requestStream<ChatResponse>({
            path: '/api/chat',
            body: { ...req, options, messages, stream: true },
            signal,
          });
          return normalizeChatStream(stream, signal);
        },
        {
          signal: req.signal,
          timeoutMs: req.timeoutMs,
          model: req.model,
          // The endpoint's concurrency slot must stay held for as long as the stream is
          // actually being consumed, not just until the initial response/headers arrive
          // — see `executeWithFailover`'s `holdUntil` doc.
          holdUntil: (stream) => stream.finalResult,
        },
      );
    }
    return withSpan(
      `chat ${req.model}`,
      {
        [ATTR_GEN_AI_SYSTEM]: GEN_AI_SYSTEM_OLLAMA,
        [ATTR_GEN_AI_OPERATION_NAME]: 'chat',
        [ATTR_GEN_AI_REQUEST_MODEL]: req.model,
      },
      async (span) => {
        const rawRes = await this.executeWithFailover((http, signal) => {
          if (req.format !== undefined)
            this.assertStructuredOutputSupported(http.baseUrl, req.model);
          return http.request<ChatResponse>({
            path: '/api/chat',
            body: { ...req, options, messages, stream: false },
            signal,
          });
        }, req);
        const toolCalls = ensureToolCallIds(rawRes.message.tool_calls);
        const res: ChatResponse =
          toolCalls === rawRes.message.tool_calls
            ? rawRes
            : { ...rawRes, message: { ...rawRes.message, tool_calls: toolCalls } };
        span?.setAttributes({
          [ATTR_GEN_AI_RESPONSE_MODEL]: res.model,
          ...(res.prompt_eval_count !== undefined
            ? { [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: res.prompt_eval_count }
            : {}),
          ...(res.eval_count !== undefined
            ? { [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: res.eval_count }
            : {}),
        });
        return res;
      },
    );
  }

  chatStream(
    req: Omit<ChatRequestOptions, 'stream'>,
  ): Promise<OllamaStream<ChatResponse, ChatStreamResult>> {
    return this.chat({ ...req, stream: true });
  }

  async chatText(req: Omit<ChatRequestOptions, 'stream'>): Promise<string> {
    const res = await this.chat({ ...req, stream: false });
    return res.message.content;
  }

  async chatWithSchema<T>(
    req: Omit<ChatRequestOptions, 'stream' | 'format'>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const res = await this.chat({ ...req, format: zodToJsonSchema(schema), stream: false });
    return parseStructuredOutput(res.message.content, schema);
  }

  // --- Generate ---
  generate(
    req: GenerateRequestOptions & { stream: true },
  ): Promise<OllamaStream<GenerateResponse, GenerateStreamResult>>;
  generate(req: GenerateRequestOptions & { stream?: false | undefined }): Promise<GenerateResponse>;
  generate(
    req: GenerateRequestOptions,
  ): Promise<GenerateResponse | OllamaStream<GenerateResponse, GenerateStreamResult>>;
  async generate(
    req: GenerateRequestOptions,
  ): Promise<GenerateResponse | OllamaStream<GenerateResponse, GenerateStreamResult>> {
    const encodedReq = await withEncodedImages(req, req.signal);
    // Context-window pre-flight — same policy as `chat`.
    this.enforceContextSafety(
      'generate',
      checkGenerateContext(req, {
        defaultContextLength: this.defaultContextLength,
        threshold: this.contextWarningThreshold,
      }),
    );
    const options = this.injectDefaultContextLength(req.options);
    if (encodedReq.stream) {
      return this.executeWithFailover(
        async (http, signal) => {
          if (encodedReq.format !== undefined)
            this.assertStructuredOutputSupported(http.baseUrl, encodedReq.model);
          const stream = await http.requestStream<GenerateResponse>({
            path: '/api/generate',
            body: { ...encodedReq, options, stream: true },
            signal,
          });
          return normalizeGenerateStream(stream, signal);
        },
        {
          signal: encodedReq.signal,
          timeoutMs: encodedReq.timeoutMs,
          model: encodedReq.model,
          holdUntil: (stream) => stream.finalResult,
        },
      );
    }
    return withSpan(
      `text_completion ${encodedReq.model}`,
      {
        [ATTR_GEN_AI_SYSTEM]: GEN_AI_SYSTEM_OLLAMA,
        [ATTR_GEN_AI_OPERATION_NAME]: 'text_completion',
        [ATTR_GEN_AI_REQUEST_MODEL]: encodedReq.model,
      },
      async (span) => {
        const res = await this.executeWithFailover((http, signal) => {
          if (encodedReq.format !== undefined)
            this.assertStructuredOutputSupported(http.baseUrl, encodedReq.model);
          return http.request<GenerateResponse>({
            path: '/api/generate',
            body: { ...encodedReq, options, stream: false },
            signal,
          });
        }, encodedReq);
        span?.setAttributes({
          [ATTR_GEN_AI_RESPONSE_MODEL]: res.model,
          ...(res.prompt_eval_count !== undefined
            ? { [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: res.prompt_eval_count }
            : {}),
          ...(res.eval_count !== undefined
            ? { [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: res.eval_count }
            : {}),
        });
        return res;
      },
    );
  }

  generateStream(
    req: Omit<GenerateRequestOptions, 'stream'>,
  ): Promise<OllamaStream<GenerateResponse, GenerateStreamResult>> {
    return this.generate({ ...req, stream: true });
  }

  async generateText(req: Omit<GenerateRequestOptions, 'stream'>): Promise<string> {
    const res = await this.generate({ ...req, stream: false });
    return res.response;
  }

  async generateWithSchema<T>(
    req: Omit<GenerateRequestOptions, 'stream' | 'format'>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const res = await this.generate({ ...req, format: zodToJsonSchema(schema), stream: false });
    return parseStructuredOutput(res.response, schema);
  }

  // --- Embeddings ---
  embed(req: EmbedRequestOptions): Promise<EmbedResponse> {
    return this.executeWithFailover(
      (http, signal) => http.request<EmbedResponse>({ path: '/api/embed', body: req, signal }),
      req,
    );
  }

  async embedText(
    model: string,
    input: string | readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    const res = await this.embed({ model, input });
    return res.embeddings;
  }

  /**
   * Batch-constrained, order-preserving embedding generation for large
   * corpora — the safe building block for RAG/vector-index ingestion at
   * scale. Splits `input` into `batchSize` slices and embeds them through
   * {@link embed} with at most `concurrency` batches in flight (defaults:
   * 32 × 3), so `Promise.all`-style floods that OOM local daemons and
   * saturate `OLLAMA_MAX_QUEUE` can't happen by accident. Fail-fast: the
   * first batch error aborts every sibling in-flight batch and rejects the
   * whole operation with the original error.
   *
   * Before any request is sent, `defaultContextLength` is injected as
   * `num_ctx` (same as chat/generate) and each input string's token estimate
   * is checked against the resolved window: Ollama silently truncates
   * oversized embedding inputs by default, so the client warns (or throws,
   * under `onContextOverflow: 'throw'`) with the offending indexes — see
   * `src/embed-batch.ts` for the exact trip point (no margin: an embedding
   * prompt IS the whole input).
   *
   * ```ts
   * const { embeddings, batchCount } = await client.embedBatch({
   *   model: 'nomic-embed-text:latest',
   *   input: corpus,                 // e.g. 50k chunks
   *   batchSize: 32,                 // inputs per /api/embed request
   *   concurrency: 3,                // batches in flight
   *   onBatchComplete: (done, total) => progress.log(`${done}/${total}`),
   * });
   * // embeddings[i] always corresponds to corpus[i]
   * ```
   */
  async embedBatch(options: EmbedBatchOptions): Promise<EmbedBatchResult> {
    const resolvedOptions = this.injectDefaultContextLength(options.options);
    const contextLength = resolvedOptions?.num_ctx;
    if (contextLength !== undefined) {
      const oversized = findOversizedEmbedInputs(options.input, contextLength);
      if (oversized.length > 0) {
        const message = embedBatchOverflowMessage(
          oversized,
          options.input.length,
          contextLength,
          options.truncate === false,
        );
        if (this.onContextOverflow === 'throw') {
          throw new OllamaClientError(message, { code: 'context_overflow' });
        }
        this.logger.warn(message);
      }
    }
    return batchEmbed(
      this,
      resolvedOptions === options.options ? options : { ...options, options: resolvedOptions },
    );
  }

  /**
   * @deprecated Ollama's `/api/embeddings` endpoint has been superseded by `/api/embed`
   * (exposed here as {@link OllamaClient.embed}), which additionally supports batch
   * input. Kept for compatibility with existing callers; new code should use `embed`.
   */
  embeddings(req: EmbeddingsRequestOptions): Promise<EmbeddingsResponse> {
    return this.executeWithFailover(
      (http, signal) =>
        http.request<EmbeddingsResponse>({ path: '/api/embeddings', body: req, signal }),
      req,
    );
  }

  // --- Model Operations (Delegated to ModelsClient) ---
  readonly listModels = () => this.models.list();
  readonly showModel = (req: ShowRequestOptions) => this.models.show(req);
  readonly pullModel = (r: PullRequestOptions) => this.models.pull(r);
  readonly pushModel = (r: PushRequestOptions) => this.models.push(r);
  readonly createModel = (r: CreateRequestOptions) => this.models.create(r);
  readonly deleteModel = (req: DeleteRequestOptions) => this.models.delete(req);
  readonly copyModel = (req: CopyRequestOptions) => this.models.copy(req);
  readonly ps = () => this.models.ps();
  readonly version = () => this.models.version();
  readonly createBlob = (digest: string, data: BinaryBody) => this.models.createBlob(digest, data);
  readonly checkBlob = (digest: string) => this.models.checkBlob(digest);
  /**
   * Immediately unloads `model` from VRAM. Convenience alias for
   * {@link ModelsClient.unload} — see that method for the full
   * lifecycle contract.
   */
  readonly unloadModel = (model: string) => this.models.unload(model);
  /**
   * Pre-loads and pins `model` into VRAM indefinitely. Convenience
   * alias for {@link ModelsClient.pin} — see that method for the
   * full lifecycle contract.
   */
  readonly pinModel = (model: string) => this.models.pin(model);

  // --- System One (Wave 13) ---
  /**
   * Ollama's System One decision layer (`POST /v1/systemone`) — evaluates
   * 1–64 typed questions (choice, noul, or score) against a provided state
   * and returns typed answers with probabilities and confidence.
   *
   * Local-only; requires Ollama >= 0.35.0. The runtime enforces the
   * version constraint automatically (lazily fetching `/api/version` when
   * `enforceVersion` is `'auto'` or `'strict'`) and rejects cloud-mode
   * calls. Request size is checked client-side: 64 KiB without images,
   * 32 MiB with images.
   *
   * The generic `Q` parameter captures the caller's question map at
   * compile time, giving key-safe answer access:
   *
   * ```ts
   * const result = await ollama.systemOne({
   *   model: 'tev1:4b',
   *   state: { ticket: 'Customer was charged twice' },
   *   questions: {
   *     intent: { type: 'choice', instructions: '...', criteria: { ... } },
   *     urgent: { type: 'noul', instructions: '...' },
   *   },
   * });
   * result.answers.intent  // ✓ SystemOneAnswer (choice)
   * result.answers.urgent  // ✓ SystemOneAnswer (noul)
   * result.answers.typo    // ✗ TypeScript error
   * ```
   *
   * For the low-level generated API (without the generic wrapper), use
   * `client.native.systemOne(request)` directly.
   */
  async systemOne<Q extends SystemOneQuestions = SystemOneQuestions>(
    request: SystemOneRequest<Q>,
  ): Promise<SystemOneResponse<Q>> {
    // Delegate to the generated NativeApi. The cast through `unknown`
    // is necessary because the generic SystemOneRequest<Q> extends but
    // doesn't sufficiently overlap with the base SystemOneRequest for
    // TypeScript's direct conversion check. The generic Q is purely a
    // compile-time wrapper — the runtime behavior is identical.
    return this.native.systemOne(
      request as unknown as SystemOneRequestBase,
    ) as Promise<SystemOneResponseBase> as Promise<SystemOneResponse<Q>>;
  }

  // --- Web Endpoints ---
  /**
   * Ollama's hosted web search tool (`POST https://ollama.com/api/web_search`) — a fixed
   * Ollama Cloud service, unrelated to `config.endpoints`/`baseUrl` and not proxied
   * through a local server. Requires an Ollama account API key: pass `apiKey` to the
   * client constructor or set `OLLAMA_API_KEY`. Applies the same default `timeoutMs` and
   * retry policy as inference calls, but never cross-endpoint-fails-over — there is only
   * ever the one cloud endpoint to call.
   */
  async webSearch(req: WebSearchRequestOptions): Promise<WebSearchResponse> {
    const { count, max_results, ...rest } = req;
    const res = await this.executeCloudRequest(
      (http, signal) =>
        http.request<WebSearchResponse>({
          path: '/api/web_search',
          body: { ...rest, max_results: max_results ?? count },
          signal,
        }),
      req,
    );
    // `snippet` is a deprecated mirror of `content`, kept for backward compatibility —
    // see the `@deprecated` note on `WebSearchResult.snippet`.
    return { results: res.results.map((r) => ({ ...r, snippet: r.content })) };
  }
  /**
   * Ollama's hosted web fetch tool (`POST https://ollama.com/api/web_fetch`) — see
   * {@link OllamaClient.webSearch} for the cloud-endpoint/auth/timeout/retry behavior,
   * which applies identically here.
   */
  webFetch(req: WebFetchRequestOptions): Promise<WebFetchResponse> {
    return this.executeCloudRequest(
      (http, signal) =>
        http.request<WebFetchResponse>({ path: '/api/web_fetch', body: req, signal }),
      req,
    );
  }
  /**
   * Ollama Cloud usage statistics (`GET https://ollama.com/api/usage`) — request counts,
   * USD spend, and token totals (including cached input tokens) for cloud inference,
   * web search, and web fetch, bucketed by hour (`range: '24h'`) or day (`'7d'`/`'30d'`).
   *
   * See {@link OllamaClient.webSearch} for the cloud-endpoint/auth/timeout/retry
   * behavior, which applies identically here. Query parameters mirror the official
   * endpoint: `range` (`'24h' | '7d' | '30d'`, server default `'7d'`) and `scope`
   * (`'self' | 'team'`, server default `'self'`; team scope requires a team admin).
   * Omitted options are left unset so the server applies its own defaults.
   *
   * ```ts
   * const usage = await client.usage({ range: '24h' });
   * console.log(usage.totals.request_count, usage.totals.usage_usd);
   * for (const bucket of usage.buckets) {
   *   if (bucket.partial) continue; // current hour, still in progress
   *   // ...
   * }
   * ```
   */
  usage(req: UsageRequestOptions = {}): Promise<UsageResponse> {
    const params = new URLSearchParams();
    if (req.range !== undefined) params.set('range', req.range);
    if (req.scope !== undefined) params.set('scope', req.scope);
    const query = params.toString();
    return this.executeCloudRequest(
      (http, signal) =>
        http.request<UsageResponse>({
          path: query ? `/api/usage?${query}` : '/api/usage',
          method: 'GET',
          signal,
        }),
      req,
    );
  }
  /**
   * Ollama Cloud balance (`GET https://ollama.com/api/balance`) — remaining included
   * and purchased usage credits. The included balance is either a plan-period credit
   * object (`balance_usd`/`allowance_usd`/`period`) or, on legacy plans, session/weekly
   * percentage limits; the shape is discriminated at runtime by the server response.
   * See {@link OllamaClient.webSearch} for the cloud-endpoint/auth/timeout/retry
   * behavior, which applies identically here.
   *
   * ```ts
   * const balance = await client.balance();
   * if ('balance_usd' in balance.included) {
   *   console.log(balance.included.balance_usd, balance.purchased.balance_usd);
   * } else {
   *   console.log(balance.included.session.remaining_percent, '% of session limit left');
   * }
   * ```
   */
  balance(req: BalanceRequestOptions = {}): Promise<BalanceResponse> {
    return this.executeCloudRequest(
      (http, signal) =>
        http.request<BalanceResponse>({ path: '/api/balance', method: 'GET', signal }),
      req,
    );
  }
  /**
   * Runs `operation` against the fixed Ollama Cloud host with this client's default
   * timeout and retry policy — the same primitives `executeWithFailover` uses, minus the
   * multi-candidate loop, since `webSearch`/`webFetch` only ever have the one endpoint.
   */
  private async executeCloudRequest<T>(
    operation: (http: HttpClient, signal: AbortSignal) => Promise<T>,
    options: RequestCancellationOptions,
  ): Promise<T> {
    const scope = this.createRequestScope(options.signal);
    const timeout = createTimeoutSignal(options.timeoutMs ?? this.timeoutMs, scope.signal);
    using _timeout = {
      [Symbol.dispose]() {
        timeout.cancel();
        scope.dispose();
      },
    };
    const requestId = createLogicalRequestId();
    const http = new HttpClient({
      baseUrl: OLLAMA_CLOUD_BASE_URL,
      apiKey: this.cloudApiKey,
      fetch: this.fetchImpl,
      middleware: this.middleware,
      onLifecycleEvent: this.onLifecycleEvent,
      requestId,
    });
    return await withRetry(
      () => operation(http, timeout.signal),
      {
        ...this.retryConfig,
        onRetry: (error, attempt, delayMs) => {
          this.retryConfig.onRetry?.(error, attempt, delayMs);
          this.onLifecycleEvent?.({
            type: 'retry',
            requestId,
            attempt: attempt + 1,
            error,
            delayMs,
            timestamp: Date.now(),
          });
        },
      },
      timeout.signal,
    );
    // timeout.cancel() called automatically via `using _timeout`
  }

  // --- Capabilities & Health ---
  capabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities> {
    return this.executeWithFailover(
      (http, runnerSignal) => detectModelCapabilities(http, model, runnerSignal),
      {
        singleEndpoint: true,
        model,
        ...(signal !== undefined ? { signal } : {}),
      },
    );
  }
  runtimeMode(): RuntimeMode {
    const ep = this.registry.candidates()[0];
    return inferRuntimeMode(ep?.baseUrl ?? DEFAULT_BASE_URL);
  }
  healthCheck(): Promise<EndpointHealthCheckResult[]> {
    return Promise.all(
      this.registry
        .list()
        .map((ep) =>
          checkEndpointHealth(ep, this.fetchImpl, 5000, this.middleware, this.onLifecycleEvent),
        ),
    );
  }
  endpointStatus(): EndpointHealth[] {
    return this.registry.status();
  }

  /**
   * Immediately aborts every in-flight request and active stream managed by
   * this client — the clean teardown path for short-lived processes, CLI
   * runners, and `node:worker_threads` tasks where dangling fetch bodies,
   * unconsumed stream readers, or queued capacity waiters would otherwise
   * keep the event loop (and thus the thread/process) alive.
   *
   * Every aborted operation rejects with an {@link OllamaAbortError}
   * (`code: 'aborted'`) carrying `reason` as its message — including requests
   * still queued behind `maxConcurrentPerEndpoint`, not just dispatched ones.
   * Streams reject their `finalResult` and release their endpoint slots.
   *
   * Idempotent: calling it again (or on a client with nothing in flight)
   * is a no-op that returns `0`. The client remains usable afterward —
   * `destroy()` is a drain, not a permanent disable; callers that want a
   * permanently-dead client should discard the instance.
   *
   * @returns the number of in-flight operations that were aborted.
   */
  destroy(reason: string = 'Ollama client destroyed'): number {
    const controllers = [...this.activeRequests];
    const cause = new OllamaAbortError(reason);
    for (const controller of controllers) {
      controller.abort(cause);
    }
    this.activeRequests.clear();
    return controllers.length;
  }

  // --- Compatibility Adapters ---
  get openai(): OpenAICompatClient {
    const ep = this.registry.candidates()[0];
    return new OpenAICompatClient(
      new HttpClient({
        baseUrl: ep?.baseUrl ?? DEFAULT_BASE_URL,
        apiKey: ep?.apiKey,
        headers: ep?.headers,
        fetch: this.fetchImpl,
        middleware: this.middleware,
        onLifecycleEvent: this.onLifecycleEvent,
      }),
      (op, opts) => this.executeWithFailover(op, opts),
    );
  }
  get anthropic(): AnthropicCompatClient {
    const ep = this.registry.candidates()[0];
    return new AnthropicCompatClient(
      new HttpClient({
        baseUrl: ep?.baseUrl ?? DEFAULT_BASE_URL,
        apiKey: ep?.apiKey,
        headers: ep?.headers,
        fetch: this.fetchImpl,
        middleware: this.middleware,
        onLifecycleEvent: this.onLifecycleEvent,
      }),
      (op, opts) => this.executeWithFailover(op, opts),
    );
  }
}
