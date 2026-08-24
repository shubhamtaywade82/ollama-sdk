/**
 * Core protocol and message types for the Ollama REST API.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool' | 'thought';

export interface ToolCallFunction {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/**
 * Unlike OpenAI, Ollama's native `/api/chat` protocol does not assign an identifier to a
 * tool call on the wire — a model turn's `tool_calls` array has no per-call ID from
 * Ollama's side. `id` here is a **client-side synthesized value** (see
 * `src/tools/tool-call-id.ts`), generated the first time the SDK sees a call without one
 * and reused consistently afterward, so consumers get OpenAI-style `tool_call_id`
 * correlation without the SDK depending on Ollama ever providing one. It carries no
 * meaning to Ollama or the model — `ToolRegistry.executeToolCalls` still fundamentally
 * dispatches by array position/order (straightforwardly parallel via `Promise.all` by
 * default, or concurrency-bounded via `maxConcurrency`); `id` is a convenience layered on
 * top for correlation/logging, not the underlying execution model. See ADR 0007.
 */
export interface ToolCall {
  /** Client-synthesized; see the type-level doc above. Always present once returned by this SDK. */
  readonly id?: string | undefined;
  readonly function: ToolCallFunction;
}

export interface Message {
  readonly role: Role;
  readonly content: string;
  /**
   * Base64-encoded image strings, or raw `Uint8Array` image bytes. `Uint8Array` entries
   * are base64-encoded automatically (see {@link encodeImage}) before the request reaches
   * the wire — Ollama's REST API only ever accepts base64 strings.
   */
  readonly images?: readonly (string | Uint8Array)[] | undefined;
  readonly tool_calls?: readonly ToolCall[] | undefined;
  /** Set on a `role: 'tool'` message to identify which {@link ToolCall.id} this answers. */
  readonly tool_call_id?: string | undefined;
  readonly thinking?: string | undefined;
}

export interface ToolProperty {
  readonly type: string;
  readonly description?: string | undefined;
  readonly enum?: readonly string[] | undefined;
  readonly items?: Record<string, unknown> | undefined;
  readonly properties?: Record<string, unknown> | undefined;
  readonly required?: readonly string[] | undefined;
}

export interface ToolFunctionDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: 'object';
    readonly properties: Record<string, ToolProperty>;
    readonly required?: readonly string[] | undefined;
  };
}

export interface ToolDefinition {
  readonly type: 'function';
  readonly function: ToolFunctionDefinition;
}

export type FormatOption = 'json' | Record<string, unknown>;

/** One alternative token considered at a generated position, and its log probability. */
export interface LogprobToken {
  readonly token: string;
  readonly logprob: number;
  readonly bytes?: readonly number[] | undefined;
}

/**
 * Log probability info for one generated token, returned when `logprobs: true` is set on
 * a `/api/chat` or `/api/generate` request. `top_logprobs` holds the `top_logprobs` most
 * likely alternative tokens considered at this position (see `top_logprobs` on
 * {@link ChatRequestOptions}/{@link GenerateRequestOptions}).
 */
export interface Logprob extends LogprobToken {
  readonly top_logprobs?: readonly LogprobToken[] | undefined;
}

export interface ModelOptions {
  readonly num_keep?: number | undefined;
  readonly seed?: number | undefined;
  readonly num_predict?: number | undefined;
  readonly top_k?: number | undefined;
  readonly top_p?: number | undefined;
  readonly min_p?: number | undefined;
  readonly tfs_z?: number | undefined;
  readonly typical_p?: number | undefined;
  readonly repeat_last_n?: number | undefined;
  readonly temperature?: number | undefined;
  readonly repeat_penalty?: number | undefined;
  readonly presence_penalty?: number | undefined;
  readonly frequency_penalty?: number | undefined;
  readonly mirostat?: number | undefined;
  readonly mirostat_tau?: number | undefined;
  readonly mirostat_eta?: number | undefined;
  readonly penalize_newline?: boolean | undefined;
  readonly stop?: readonly string[] | undefined;
  readonly num_ctx?: number | undefined;
  readonly num_batch?: number | undefined;
  readonly num_gpu?: number | undefined;
  readonly main_gpu?: number | undefined;
  readonly low_vram?: boolean | undefined;
  readonly f16_kv?: boolean | undefined;
  readonly vocab_only?: boolean | undefined;
  readonly use_mmap?: boolean | undefined;
  readonly use_mlock?: boolean | undefined;
  readonly num_thread?: number | undefined;
}

export interface RequestCancellationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ChatRequestOptions extends RequestCancellationOptions {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly format?: FormatOption | undefined;
  readonly options?: ModelOptions | undefined;
  readonly stream?: boolean | undefined;
  readonly keep_alive?: string | number | undefined;
  readonly think?: boolean | 'low' | 'medium' | 'high' | 'max' | undefined;
  /** Whether to return log probabilities of the output tokens. See {@link ChatResponse.logprobs}. */
  readonly logprobs?: boolean | undefined;
  /** Number of most likely alternative tokens to return at each position. Requires `logprobs: true`. */
  readonly top_logprobs?: number | undefined;
}

export interface ChatResponse {
  readonly model: string;
  readonly created_at: string;
  readonly message: Message;
  readonly done: boolean;
  readonly done_reason?: string | undefined;
  readonly total_duration?: number | undefined;
  readonly load_duration?: number | undefined;
  readonly prompt_eval_count?: number | undefined;
  readonly prompt_eval_duration?: number | undefined;
  readonly eval_count?: number | undefined;
  readonly eval_duration?: number | undefined;
  /** Present when the request set `logprobs: true`. */
  readonly logprobs?: readonly Logprob[] | undefined;
}

export interface GenerateRequestOptions extends RequestCancellationOptions {
  readonly model: string;
  readonly prompt: string;
  readonly suffix?: string | undefined;
  readonly system?: string | undefined;
  readonly template?: string | undefined;
  readonly context?: readonly number[] | undefined;
  readonly stream?: boolean | undefined;
  readonly raw?: boolean | undefined;
  readonly format?: FormatOption | undefined;
  /**
   * Base64-encoded image strings, or raw `Uint8Array` image bytes. `Uint8Array` entries
   * are base64-encoded automatically (see {@link encodeImage}) before the request reaches
   * the wire — Ollama's REST API only ever accepts base64 strings.
   */
  readonly images?: readonly (string | Uint8Array)[] | undefined;
  readonly options?: ModelOptions | undefined;
  readonly keep_alive?: string | number | undefined;
  readonly think?: boolean | 'low' | 'medium' | 'high' | 'max' | undefined;
  /** Whether to return log probabilities of the output tokens. See {@link GenerateResponse.logprobs}. */
  readonly logprobs?: boolean | undefined;
  /** Number of most likely alternative tokens to return at each position. Requires `logprobs: true`. */
  readonly top_logprobs?: number | undefined;
}

export interface GenerateResponse {
  readonly model: string;
  readonly created_at: string;
  readonly response: string;
  readonly done: boolean;
  readonly done_reason?: string | undefined;
  readonly context?: readonly number[] | undefined;
  readonly total_duration?: number | undefined;
  readonly load_duration?: number | undefined;
  readonly prompt_eval_count?: number | undefined;
  readonly prompt_eval_duration?: number | undefined;
  readonly eval_count?: number | undefined;
  readonly eval_duration?: number | undefined;
  readonly thinking?: string | undefined;
  /** Present when the request set `logprobs: true`. */
  readonly logprobs?: readonly Logprob[] | undefined;
}

export interface EmbedRequestOptions extends RequestCancellationOptions {
  readonly model: string;
  readonly input: string | readonly string[];
  readonly truncate?: boolean | undefined;
  /** Truncates the returned embedding vectors to this many dimensions, if supported by the model. */
  readonly dimensions?: number | undefined;
  readonly options?: ModelOptions | undefined;
  readonly keep_alive?: string | number | undefined;
}

export interface EmbedResponse {
  readonly model: string;
  readonly embeddings: readonly (readonly number[])[];
  readonly total_duration?: number | undefined;
  readonly load_duration?: number | undefined;
  readonly prompt_eval_count?: number | undefined;
}

export interface EmbeddingsRequestOptions extends RequestCancellationOptions {
  readonly model: string;
  readonly prompt: string;
  readonly options?: ModelOptions | undefined;
  readonly keep_alive?: string | number | undefined;
}

export interface EmbeddingsResponse {
  readonly embedding: readonly number[];
}

export interface ModelDetails {
  readonly parent_model?: string | undefined;
  readonly format: string;
  readonly family: string;
  readonly families?: readonly string[] | undefined;
  readonly parameter_size: string;
  readonly quantization_level: string;
}

export interface ModelResponse {
  readonly name: string;
  readonly model: string;
  readonly modified_at: string;
  readonly size: number;
  readonly digest: string;
  readonly details: ModelDetails;
  readonly expires_at?: string | undefined;
  readonly size_vram?: number | undefined;
}

export interface ListResponse {
  readonly models: readonly ModelResponse[];
}

export interface ShowRequestOptions extends RequestCancellationOptions {
  readonly model: string;
  readonly system?: string | undefined;
  readonly template?: string | undefined;
  readonly verbose?: boolean | undefined;
}

export interface ShowResponse {
  readonly license?: string | undefined;
  readonly modelfile?: string | undefined;
  readonly parameters?: string | undefined;
  readonly template?: string | undefined;
  readonly system?: string | undefined;
  readonly details: ModelDetails;
  readonly messages?: readonly Message[] | undefined;
  readonly model_info?: Record<string, unknown> | undefined;
  readonly capabilities?: readonly string[] | undefined;
  readonly modified_at?: string | undefined;
}

export interface ProgressResponse {
  readonly status: string;
  readonly digest?: string | undefined;
  readonly total?: number | undefined;
  readonly completed?: number | undefined;
}

export interface PullRequestOptions extends RequestCancellationOptions {
  readonly model: string;
  readonly insecure?: boolean | undefined;
  readonly stream?: boolean | undefined;
}

export interface PushRequestOptions extends RequestCancellationOptions {
  readonly model: string;
  readonly insecure?: boolean | undefined;
  readonly stream?: boolean | undefined;
}

export interface CreateRequestOptions extends RequestCancellationOptions {
  readonly model: string;
  /**
   * @deprecated Not part of the official `/api/create` REST payload — Ollama's server
   * only ever accepted this in older client tooling that assembled a Modelfile string
   * client-side. Use the discrete fields below instead (`from`, `files`, `adapters`,
   * `template`, `system`, `parameters`, `license`, `messages`), which map 1:1 onto the
   * documented Modelfile instructions and are validated server-side. Kept for backward
   * compatibility with existing callers; not read by this SDK, but still forwarded as-is
   * in the request body for any server/proxy that inspects it.
   */
  readonly modelfile?: string | undefined;
  readonly stream?: boolean | undefined;
  readonly quantize?: string | undefined;
  readonly from?: string | undefined;
  readonly files?: Record<string, string> | undefined;
  readonly adapters?: Record<string, string> | undefined;
  readonly template?: string | undefined;
  readonly renderer?: string | undefined;
  readonly parser?: string | undefined;
  readonly license?: string | readonly string[] | undefined;
  readonly system?: string | undefined;
  /** Modelfile `PARAMETER` instructions, e.g. `{ temperature: 0.7, stop: ['\n'] }`. */
  readonly parameters?: Record<string, unknown> | undefined;
  readonly messages?: readonly Message[] | undefined;
}

export interface DeleteRequestOptions extends RequestCancellationOptions {
  readonly model: string;
}

export interface CopyRequestOptions extends RequestCancellationOptions {
  readonly source: string;
  readonly destination: string;
}

export interface StatusResponse {
  readonly status: string;
}

export interface VersionResponse {
  readonly version: string;
}

export interface PsResponse {
  readonly models: readonly ModelResponse[];
}

/**
 * `webSearch`/`webFetch` call Ollama's hosted web tools at `https://ollama.com` — a
 * fixed cloud service, unrelated to any locally-configured `baseUrl`/`endpoints` — and
 * require an Ollama account API key (`apiKey`/`OLLAMA_API_KEY`). See
 * {@link OllamaClient.webSearch}.
 */
export interface WebSearchRequestOptions extends RequestCancellationOptions {
  readonly query: string;
  /** Max results to return (server default 5, max 10). */
  readonly max_results?: number | undefined;
  /**
   * @deprecated Not a field the Ollama web search API recognizes (`max_results` is).
   * Kept for backward compatibility with earlier (non-functional) versions of this
   * method; mapped to `max_results` when `max_results` itself isn't set.
   */
  readonly count?: number | undefined;
}

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly content: string;
  /**
   * @deprecated Not a field the Ollama web search API returns (`content` is) — kept, and
   * populated by the SDK as a mirror of `content`, for backward compatibility with
   * earlier (non-functional, wrong-endpoint) versions of `webSearch`. Use `content`.
   */
  readonly snippet?: string | undefined;
}

export interface WebSearchResponse {
  readonly results: readonly WebSearchResult[];
}

/** See {@link WebSearchRequestOptions} — same fixed Ollama Cloud endpoint and auth. */
export interface WebFetchRequestOptions extends RequestCancellationOptions {
  readonly url: string;
}

export interface WebFetchResponse {
  readonly title?: string | undefined;
  readonly content: string;
  readonly links?: readonly string[] | undefined;
}
