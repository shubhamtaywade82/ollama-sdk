/**
 * OpenAI Compatibility interfaces and client helpers for Ollama.
 * Ollama exposes OpenAI-compatible /v1 endpoints.
 *
 * @remarks
 * This is a typed pass-through to Ollama's own OpenAI-compatible `/v1` endpoints — it
 * implements the subset of the OpenAI API surface that Ollama documents as supported
 * (https://docs.ollama.com/api/openai-compatibility), not the full OpenAI surface (hosted
 * tools like web/file search, computer use, code interpreter, or stateful server-side
 * conversation state). Notably, `tools` is supported by Ollama's compat layer but
 * `tool_choice` and `parallel_tool_calls` are not — both are still typed on
 * {@link OpenAIChatCompletionRequest} (accepted-but-ignored) so consumers passing a
 * standard OpenAI request object don't get spurious type errors; see the `@remarks` on
 * each field. `/v1/responses` is supported non-statefully — see
 * {@link OpenAIResponsesRequest}.
 */

import type { HttpClient } from '../transport/http.js';

export interface OpenAIToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    /** JSON-encoded arguments string, matching OpenAI's wire format (not a parsed object). */
    readonly arguments: string;
  };
}

export interface OpenAIMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly name?: string | undefined;
  readonly tool_calls?: readonly OpenAIToolCall[] | undefined;
  /** Set on a `role: 'tool'` message to identify which call this is a result for. */
  readonly tool_call_id?: string | undefined;
}

export interface OpenAIStreamOptions {
  /** Emit a final SSE chunk carrying `usage` (prompt/completion/total tokens) before `[DONE]`. */
  readonly include_usage?: boolean | undefined;
}

export interface OpenAIFunctionDefinition {
  readonly name: string;
  readonly description?: string | undefined;
  readonly parameters?: Record<string, unknown> | undefined;
}

export interface OpenAITool {
  readonly type: 'function';
  readonly function: OpenAIFunctionDefinition;
}

export interface OpenAIChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly OpenAIMessage[];
  readonly temperature?: number | undefined;
  readonly top_p?: number | undefined;
  readonly stream?: boolean | undefined;
  /** Only meaningful when `stream: true`; ignored otherwise. */
  readonly stream_options?: OpenAIStreamOptions | undefined;
  readonly max_tokens?: number | undefined;
  readonly stop?: readonly string[] | undefined;
  readonly presence_penalty?: number | undefined;
  readonly frequency_penalty?: number | undefined;
  readonly user?: string | undefined;
  readonly tools?: readonly OpenAITool[] | undefined;
  /**
   * @remarks Accepted for OpenAI compatibility but ignored by Ollama — every tool the
   * model is given remains callable regardless of this value.
   */
  readonly tool_choice?:
    | 'none'
    | 'auto'
    | 'required'
    | { readonly type: 'function'; readonly function: { readonly name: string } }
    | undefined;
  /**
   * @remarks Accepted for OpenAI compatibility but ignored by Ollama — Ollama does not
   * control tool-call parallelism through this flag.
   */
  readonly parallel_tool_calls?: boolean | undefined;
  /**
   * Effort level for thinking models (e.g. `deepseek-r1`, `qwen3`). Equivalent to
   * `reasoning.effort`; only effective for models that support reasoning/thinking.
   */
  readonly reasoning_effort?: 'high' | 'medium' | 'low' | 'max' | 'none' | undefined;
  /**
   * Effort level for thinking models (e.g. `deepseek-r1`, `qwen3`), nested OpenAI-style.
   * Equivalent to `reasoning_effort`; only effective for models that support
   * reasoning/thinking.
   */
  readonly reasoning?:
    { readonly effort?: 'high' | 'medium' | 'low' | 'max' | 'none' | undefined } | undefined;
}

export interface OpenAIChatCompletionChoice {
  readonly index: number;
  readonly message: OpenAIMessage;
  readonly finish_reason: string;
}

export interface OpenAIChatCompletionResponse {
  readonly id: string;
  readonly object: 'chat.completion';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly OpenAIChatCompletionChoice[];
  readonly usage?:
    | {
        readonly prompt_tokens: number;
        readonly completion_tokens: number;
        readonly total_tokens: number;
      }
    | undefined;
}

export interface OpenAIModelItem {
  readonly id: string;
  readonly object: 'model';
  readonly created: number;
  readonly owned_by: string;
}

export interface OpenAIListModelsResponse {
  readonly object: 'list';
  readonly data: readonly OpenAIModelItem[];
}

/**
 * Request body for OpenAI's Responses API (`/v1/responses`), added in Ollama v0.13.3.
 *
 * @remarks
 * Ollama implements this **non-statefully**: every call is independent, so
 * {@link previous_response_id} and {@link conversation} — OpenAI's mechanisms for
 * resuming server-side conversation state — are accepted for compatibility but ignored.
 * Send the full conversation in `input` on every call, the same as `/api/chat`.
 */
export interface OpenAIResponsesRequest {
  readonly model: string;
  readonly input: string | readonly OpenAIMessage[];
  readonly instructions?: string | undefined;
  readonly tools?: readonly OpenAITool[] | undefined;
  readonly stream?: boolean | undefined;
  readonly temperature?: number | undefined;
  readonly top_p?: number | undefined;
  readonly max_output_tokens?: number | undefined;
  /** @remarks Not supported by Ollama, which is stateless across calls — accepted but ignored. */
  readonly previous_response_id?: string | undefined;
  /** @remarks Not supported by Ollama, which is stateless across calls — accepted but ignored. */
  readonly conversation?: string | undefined;
  readonly truncation?: string | undefined;
}

export interface OpenAIResponsesOutputTextContent {
  readonly type: 'output_text';
  readonly text: string;
}

export interface OpenAIResponsesOutputMessage {
  readonly type: 'message';
  readonly role?: string | undefined;
  readonly content: readonly OpenAIResponsesOutputTextContent[];
}

/** Non-stateful response shape for `/v1/responses`; see {@link OpenAIResponsesRequest}. */
export interface OpenAIResponsesResponse {
  readonly id: string;
  readonly object: 'response';
  readonly created: number;
  readonly model: string;
  readonly output: readonly OpenAIResponsesOutputMessage[];
  readonly usage?:
    | {
        readonly input_tokens: number;
        readonly output_tokens: number;
        readonly total_tokens: number;
      }
    | undefined;
}

export class OpenAICompatClient {
  constructor(private readonly http: HttpClient) {}

  async createChatCompletion(
    request: OpenAIChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<OpenAIChatCompletionResponse> {
    return this.http.request<OpenAIChatCompletionResponse>({
      path: '/v1/chat/completions',
      body: request,
      signal,
    });
  }

  async chatCompletions(
    request: OpenAIChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<OpenAIChatCompletionResponse> {
    return this.createChatCompletion(request, signal);
  }

  async listModels(signal?: AbortSignal): Promise<OpenAIListModelsResponse> {
    return this.http.request<OpenAIListModelsResponse>({
      path: '/v1/models',
      method: 'GET',
      signal,
    });
  }

  async createResponses(
    request: OpenAIResponsesRequest,
    signal?: AbortSignal,
  ): Promise<OpenAIResponsesResponse> {
    return this.http.request<OpenAIResponsesResponse>({
      path: '/v1/responses',
      body: request,
      signal,
    });
  }

  async responses(
    request: OpenAIResponsesRequest,
    signal?: AbortSignal,
  ): Promise<OpenAIResponsesResponse> {
    return this.createResponses(request, signal);
  }
}
