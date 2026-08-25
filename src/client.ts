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
  resolveBaseUrl,
  resolveCredentialEndpoints,
  type OllamaClientConfig,
} from './config.js';
import { OllamaClientError, OllamaModelRoutingError, OllamaUnsupportedCapabilityError } from './errors.js';
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
  WebFetchRequestOptions,
  WebFetchResponse,
  WebSearchRequestOptions,
  WebSearchResponse,
} from './types.js';

export class OllamaClient {
  readonly registry: EndpointRegistry;
  readonly models: ModelsClient;
  private readonly retryConfig: RetryConfig;
  private readonly timeoutMs: number;
  private readonly failoverCodes: Set<string>;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  /**
   * API key for Ollama's hosted web tools (`webSearch`/`webFetch`), which always target
   * `OLLAMA_CLOUD_BASE_URL` regardless of `config.endpoints` — an Ollama account API key
   * is inherently a single global credential, not tied to any one inference endpoint.
   * Resolved the same way as a single-endpoint `apiKey` (`config.apiKey` falling back to
   * `OLLAMA_API_KEY`), independent of whether `config.endpoints` was used instead.
   */
  private readonly cloudApiKey: string | undefined;

  constructor(config: OllamaClientConfig = {}) {
    const resolvedApiKey = resolveApiKey(config.apiKey);
    this.cloudApiKey = resolvedApiKey;
    const credentialEndpoints = resolveCredentialEndpoints(config);
    const endpoints =
      config.endpoints ??
      (credentialEndpoints.length > 0
        ? []
        : [
            {
              name: 'default',
              baseUrl: resolveBaseUrl(config.baseUrl),
              ...(resolvedApiKey !== undefined ? { apiKey: resolvedApiKey } : {}),
              ...(config.headers !== undefined ? { headers: config.headers } : {}),
            },
          ]);
    this.registry = new EndpointRegistry([...endpoints, ...credentialEndpoints], config.endpointHealth);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.failoverCodes = new Set(config.failoverOn ?? DEFAULT_FAILOVER_CODES);
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.logger = config.logger ?? (config.debug ? createConsoleLogger() : NOOP_LOGGER);
    this.retryConfig =
      typeof config.retries === 'number'
        ? { ...DEFAULT_RETRY_CONFIG, maxRetries: config.retries }
        : { ...DEFAULT_RETRY_CONFIG, ...config.retries };
    this.models = new ModelsClient((op, opts) => this.executeWithFailover(op, opts));
  }

  get modelsClient(): ModelsClient {
    return this.models;
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
    },
  ): Promise<T> {
    const timeout = createTimeoutSignal(options?.timeoutMs ?? this.timeoutMs, options?.signal);
    try {
      const allCandidates = this.registry.candidates(options?.model);
      if (allCandidates.length === 0 && options?.model !== undefined && this.registry.hasModelScopedEndpoints()) {
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
      let lastError: Error | undefined;

      for (const [attemptIndex, endpoint] of candidates.entries()) {
        this.logger.debug(`Executing on endpoint "${endpoint.name}" (${endpoint.baseUrl})`);
        const http = new HttpClient({
          baseUrl: endpoint.baseUrl,
          ...(endpoint.apiKey !== undefined ? { apiKey: endpoint.apiKey } : {}),
          ...(endpoint.headers !== undefined ? { headers: endpoint.headers } : {}),
          fetch: this.fetchImpl,
        });

        try {
          const result = await withSpan(
            'ollama.endpoint.attempt',
            {
              [ATTR_OLLAMA_ENDPOINT_NAME]: endpoint.name,
              [ATTR_OLLAMA_ENDPOINT_ATTEMPT]: attemptIndex,
            },
            () => withRetry(() => operation(http, timeout.signal), this.retryConfig),
          );
          this.registry.reportSuccess(endpoint.name);
          return result;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          lastError = error;
          this.registry.reportFailure(endpoint.name);
          this.logger.warn(`Failed on "${endpoint.name}": ${error.message}`);
          if (!(error instanceof OllamaClientError && this.failoverCodes.has(error.code)))
            throw error;
        }
      }
      throw lastError ?? new Error('No healthy Ollama endpoints available');
    } finally {
      timeout.cancel();
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
    const messages = await withEncodedMessageImages(req.messages);
    if (req.stream) {
      return this.executeWithFailover(async (http, signal) => {
        if (req.format !== undefined) this.assertStructuredOutputSupported(http.baseUrl, req.model);
        const stream = await http.requestStream<ChatResponse>({
          path: '/api/chat',
          body: { ...req, messages, stream: true },
          signal,
        });
        return normalizeChatStream(stream);
      }, req);
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
            body: { ...req, messages, stream: false },
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
    const encodedReq = await withEncodedImages(req);
    if (encodedReq.stream) {
      return this.executeWithFailover(async (http, signal) => {
        if (encodedReq.format !== undefined)
          this.assertStructuredOutputSupported(http.baseUrl, encodedReq.model);
        const stream = await http.requestStream<GenerateResponse>({
          path: '/api/generate',
          body: { ...encodedReq, stream: true },
          signal,
        });
        return normalizeGenerateStream(stream);
      }, encodedReq);
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
            body: { ...encodedReq, stream: false },
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
   * Runs `operation` against the fixed Ollama Cloud host with this client's default
   * timeout and retry policy — the same primitives `executeWithFailover` uses, minus the
   * multi-candidate loop, since `webSearch`/`webFetch` only ever have the one endpoint.
   */
  private async executeCloudRequest<T>(
    operation: (http: HttpClient, signal: AbortSignal) => Promise<T>,
    options: RequestCancellationOptions,
  ): Promise<T> {
    const timeout = createTimeoutSignal(options.timeoutMs ?? this.timeoutMs, options.signal);
    try {
      const http = new HttpClient({
        baseUrl: OLLAMA_CLOUD_BASE_URL,
        apiKey: this.cloudApiKey,
        fetch: this.fetchImpl,
      });
      return await withRetry(() => operation(http, timeout.signal), this.retryConfig);
    } finally {
      timeout.cancel();
    }
  }

  // --- Capabilities & Health ---
  capabilities(model: string): Promise<ModelCapabilities> {
    return this.executeWithFailover((http) => detectModelCapabilities(http, model), {
      singleEndpoint: true,
      model,
    });
  }
  runtimeMode(): RuntimeMode {
    const ep = this.registry.candidates()[0];
    return inferRuntimeMode(ep?.baseUrl ?? DEFAULT_BASE_URL);
  }
  healthCheck(): Promise<EndpointHealthCheckResult[]> {
    return Promise.all(this.registry.list().map((ep) => checkEndpointHealth(ep, this.fetchImpl)));
  }
  endpointStatus(): EndpointHealth[] {
    return this.registry.status();
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
      }),
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
      }),
    );
  }
}
