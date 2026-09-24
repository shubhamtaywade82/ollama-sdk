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

import type { AbortableAsyncIterable } from '../streaming/types.js';
import type { SseEvent } from '../streaming/sse.js';
import type { HttpClient } from '../transport/http.js';
import type { RequestRunner } from '../models-client.js';

export interface OpenAIToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    /** JSON-encoded arguments string, matching OpenAI's wire format (not a parsed object). */
    readonly arguments: string;
  };
}

export interface OpenAITextContentPart {
  readonly type: 'text';
  readonly text: string;
}

export interface OpenAIImageUrlContentPart {
  readonly type: 'image_url';
  /** Ollama accepts a data/image URL string or the standard OpenAI URL object. */
  readonly image_url:
    | string
    | { readonly url: string; readonly detail?: 'auto' | 'low' | 'high' | 'original' | undefined };
}

export type OpenAIContentPart = OpenAITextContentPart | OpenAIImageUrlContentPart;

export interface OpenAIMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | readonly OpenAIContentPart[];
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

export type OpenAIReasoningEffort =
  | 'high'
  | 'medium'
  | 'low'
  | 'max'
  | 'none'
  | 'minimal'
  | 'xhigh'
  | 'ultra'
  | (string & {});

export type OpenAIResponseFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_object' }
  | { readonly type: 'json_schema'; readonly json_schema: Record<string, unknown> };

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
  readonly response_format?: OpenAIResponseFormat | undefined;
  readonly seed?: number | undefined;
  readonly presence_penalty?: number | undefined;
  readonly frequency_penalty?: number | undefined;
  readonly user?: string | undefined;
  readonly logit_bias?: Record<string, number> | undefined;
  readonly n?: number | undefined;
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
  readonly reasoning_effort?: OpenAIReasoningEffort | undefined;
  /**
   * Effort level for thinking models (e.g. `deepseek-r1`, `qwen3`), nested OpenAI-style.
   * Equivalent to `reasoning_effort`; only effective for models that support
   * reasoning/thinking.
   */
  readonly reasoning?:
    { readonly effort?: OpenAIReasoningEffort | undefined } | undefined;
}

export interface OpenAIChatCompletionChoice {
  readonly index: number;
  readonly message: OpenAIMessage;
  readonly finish_reason: string;
  readonly logprobs?: Record<string, unknown> | null | undefined;
}

export interface OpenAIToolCallDelta {
  readonly index: number;
  readonly id?: string | undefined;
  readonly type?: 'function' | undefined;
  readonly function?: {
    readonly name?: string | undefined;
    readonly arguments?: string | undefined;
  } | undefined;
}

export interface OpenAIChatCompletionDelta {
  readonly role?: OpenAIMessage['role'] | undefined;
  readonly content?: string | null | undefined;
  readonly refusal?: string | null | undefined;
  readonly tool_calls?: readonly OpenAIToolCallDelta[] | undefined;
}

export interface OpenAIChatCompletionChunkChoice {
  readonly index: number;
  readonly delta: OpenAIChatCompletionDelta;
  readonly finish_reason?: string | null | undefined;
  readonly logprobs?: Record<string, unknown> | null | undefined;
}

export interface OpenAIChatCompletionChunk {
  readonly id: string;
  readonly object: 'chat.completion.chunk';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly OpenAIChatCompletionChunkChoice[];
  readonly usage?:
    | {
        readonly prompt_tokens: number;
        readonly completion_tokens: number;
        readonly total_tokens: number;
      }
    | null
    | undefined;
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

export interface OpenAICompletionRequest {
  readonly model: string;
  /** Ollama currently accepts a string prompt for /v1/completions. */
  readonly prompt: string;
  readonly frequency_penalty?: number | undefined;
  readonly presence_penalty?: number | undefined;
  readonly seed?: number | undefined;
  readonly stop?: readonly string[] | undefined;
  readonly stream?: boolean | undefined;
  readonly stream_options?: OpenAIStreamOptions | undefined;
  readonly temperature?: number | undefined;
  readonly top_p?: number | undefined;
  readonly max_tokens?: number | undefined;
  readonly suffix?: string | undefined;
  readonly best_of?: number | undefined;
  readonly echo?: boolean | undefined;
  readonly logit_bias?: Record<string, number> | undefined;
  readonly user?: string | undefined;
  readonly n?: number | undefined;
}

export interface OpenAICompletionChoice {
  readonly text: string;
  readonly index: number;
  readonly logprobs?: Record<string, unknown> | null | undefined;
  readonly finish_reason: string | null;
}

export interface OpenAICompletionChunk {
  readonly id: string;
  readonly object: 'text_completion';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly text: string;
    readonly index: number;
    readonly logprobs?: Record<string, unknown> | null | undefined;
    readonly finish_reason?: string | null | undefined;
  }[];
  readonly usage?:
    | {
        readonly prompt_tokens: number;
        readonly completion_tokens: number;
        readonly total_tokens: number;
      }
    | null
    | undefined;
}

export interface OpenAICompletionResponse {
  readonly id: string;
  readonly object: 'text_completion';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly OpenAICompletionChoice[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  } | undefined;
}

export type OpenAIEmbeddingInput =
  | string
  | readonly string[]
  | readonly number[]
  | readonly (readonly number[])[];

export interface OpenAIEmbeddingRequest {
  readonly model: string;
  readonly input: OpenAIEmbeddingInput;
  readonly encoding_format?: 'float' | 'base64' | undefined;
  readonly dimensions?: number | undefined;
  readonly user?: string | undefined;
}

export interface OpenAIEmbeddingItem {
  readonly object: 'embedding';
  readonly embedding: readonly number[] | string;
  readonly index: number;
}

export interface OpenAIEmbeddingResponse {
  readonly object: 'list';
  readonly data: readonly OpenAIEmbeddingItem[];
  readonly model: string;
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly total_tokens: number;
  } | undefined;
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
  readonly reasoning?: { readonly effort?: OpenAIReasoningEffort | undefined } | undefined;
  /** Ollama extension: boolean, model-defined string, or null for model default. */
  readonly think?: boolean | string | null | undefined;
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

export interface OpenAIResponsesOutputFunctionCall {
  readonly type: 'function_call';
  readonly id?: string | undefined;
  readonly call_id?: string | undefined;
  readonly name: string;
  readonly arguments: string;
}

export interface OpenAIResponsesOutputReasoning {
  readonly type: 'reasoning';
  readonly id?: string | undefined;
  readonly summary?: readonly { readonly type: 'summary_text'; readonly text: string }[] | undefined;
  readonly text?: string | undefined;
}

export type OpenAIResponsesOutputItem =
  | OpenAIResponsesOutputMessage
  | OpenAIResponsesOutputFunctionCall
  | OpenAIResponsesOutputReasoning;

/** Non-stateful response shape for `/v1/responses`; see {@link OpenAIResponsesRequest}. */
export interface OpenAIResponsesResponse {
  readonly id: string;
  readonly object: 'response';
  readonly created: number;
  readonly model: string;
  readonly output: readonly OpenAIResponsesOutputItem[];
  readonly usage?:
    | {
        readonly input_tokens: number;
        readonly output_tokens: number;
        readonly total_tokens: number;
      }
    | undefined;
}

export class OpenAIChatCompletionStream implements AsyncIterable<OpenAIChatCompletionChunk> {
  private readonly finalResultPromise: Promise<OpenAIChatCompletionResponse>;
  private resolveFinal!: (value: OpenAIChatCompletionResponse) => void;
  private rejectFinal!: (reason: unknown) => void;

  constructor(private readonly source: AbortableAsyncIterable<SseEvent>) {
    this.finalResultPromise = new Promise<OpenAIChatCompletionResponse>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
  }

  get finalResult(): Promise<OpenAIChatCompletionResponse> {
    return this.finalResultPromise;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<OpenAIChatCompletionChunk, void, undefined> {
    const choices = new Map<number, {
      message: OpenAIMessage;
      finish_reason: string;
      logprobs?: Record<string, unknown> | null | undefined;
    }>();
    let id = '';
    let model = '';
    let created = 0;
    let usage:
      | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      | undefined;

    try {
      for await (const event of this.source) {
        if (event.data === '[DONE]') break;
        let chunk: OpenAIChatCompletionChunk;
        try {
          chunk = JSON.parse(event.data) as OpenAIChatCompletionChunk;
        } catch (error) {
          throw new Error('Failed to parse OpenAI chat completion SSE payload', { cause: error });
        }
        id = chunk.id || id;
        model = chunk.model || model;
        created = chunk.created || created;
        if (chunk.usage !== null && chunk.usage !== undefined) usage = chunk.usage;

        for (const choice of chunk.choices) {
          const existing = choices.get(choice.index);
          const delta = choice.delta;
          if (!existing) {
            const toolCalls = delta.tool_calls?.map((toolCall) => ({
              id: toolCall.id ?? '',
              type: 'function' as const,
              function: {
                name: toolCall.function?.name ?? '',
                arguments: toolCall.function?.arguments ?? '',
              },
            }));
            choices.set(choice.index, {
              message: {
                role: delta.role ?? 'assistant',
                content: delta.content ?? '',
                ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: choice.finish_reason ?? '',
              ...(choice.logprobs !== undefined ? { logprobs: choice.logprobs } : {}),
            });
            continue;
          }

          const priorToolCalls = [...(existing.message.tool_calls ?? [])];
          for (const toolCall of delta.tool_calls ?? []) {
            const position = toolCall.index;
            const current = priorToolCalls[position];
            if (current) {
              priorToolCalls[position] = {
                ...current,
                ...(toolCall.id !== undefined ? { id: toolCall.id } : {}),
                function: {
                  name: current.function?.name ?? toolCall.function?.name ?? '',
                  arguments:
                    (current.function?.arguments ?? '') + (toolCall.function?.arguments ?? ''),
                },
              };
            } else {
              priorToolCalls[position] = {
                id: toolCall.id ?? '',
                type: 'function',
                function: {
                  name: toolCall.function?.name ?? '',
                  arguments: toolCall.function?.arguments ?? '',
                },
              };
            }
          }
          choices.set(choice.index, {
            message: {
              ...existing.message,
              ...(delta.content !== undefined && delta.content !== null
                ? { content: existing.message.content + delta.content }
                : {}),
              ...(priorToolCalls.length ? { tool_calls: priorToolCalls } : {}),
            },
            finish_reason: choice.finish_reason ?? existing.finish_reason,
            ...(choice.logprobs !== undefined ? { logprobs: choice.logprobs } : {}),
          });
        }

        yield chunk;
      }

      const response: OpenAIChatCompletionResponse = {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [...choices.entries()]
          .sort(([a], [b]) => a - b)
          .map(([index, choice]) => ({
            index,
            message: choice.message,
            finish_reason: choice.finish_reason,
            ...(choice.logprobs !== undefined ? { logprobs: choice.logprobs } : {}),
          })),
        ...(usage !== undefined ? { usage } : {}),
      };
      this.resolveFinal(response);
    } catch (error) {
      this.rejectFinal(error);
      throw error;
    }
  }
}

export class OpenAICompletionStream implements AsyncIterable<{
  readonly id: string;
  readonly object: 'text_completion';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly OpenAICompletionChoice[];
  readonly usage?:
    | { readonly prompt_tokens: number; readonly completion_tokens: number; readonly total_tokens: number }
    | null
    | undefined;
}> {
  private readonly finalResultPromise: Promise<OpenAICompletionResponse>;
  private resolveFinal!: (value: OpenAICompletionResponse) => void;
  private rejectFinal!: (reason: unknown) => void;

  constructor(private readonly source: AbortableAsyncIterable<SseEvent>) {
    this.finalResultPromise = new Promise<OpenAICompletionResponse>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
  }

  get finalResult(): Promise<OpenAICompletionResponse> {
    return this.finalResultPromise;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Awaited<ReturnType<typeof JSON.parse>>, void, undefined> {
    const texts = new Map<number, OpenAICompletionChoice>();
    let id = '';
    let model = '';
    let created = 0;
    let usage:
      | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      | undefined;

    try {
      for await (const event of this.source) {
        if (event.data === '[DONE]') break;
        const chunk = JSON.parse(event.data) as OpenAICompletionChunk;
        id = chunk.id || id;
        model = chunk.model || model;
        created = chunk.created || created;
        if (chunk.usage !== null && chunk.usage !== undefined) usage = chunk.usage;

        for (const choice of chunk.choices) {
          const existing = texts.get(choice.index);
          texts.set(choice.index, {
            text: (existing?.text ?? '') + (choice.text ?? ''),
            index: choice.index,
            finish_reason: choice.finish_reason ?? existing?.finish_reason ?? null,
            ...(choice.logprobs !== undefined ? { logprobs: choice.logprobs } : {}),
          });
        }
        yield chunk;
      }

      const response: OpenAICompletionResponse = {
        id,
        object: 'text_completion',
        created,
        model,
        choices: [...texts.values()].sort((a, b) => a.index - b.index),
        ...(usage !== undefined ? { usage } : {}),
      };
      this.resolveFinal(response);
    } catch (error) {
      this.rejectFinal(error);
      throw error;
    }
  }
}

export interface OpenAIResponsesOutputTextDeltaEvent {
  readonly type: 'response.output_text.delta';
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
  readonly delta: string;
}

export interface OpenAIResponsesOutputTextDoneEvent {
  readonly type: 'response.output_text.done';
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
  readonly text: string;
}

export interface OpenAIResponsesFunctionCallArgumentsDeltaEvent {
  readonly type: 'response.function_call_arguments.delta';
  readonly item_id: string;
  readonly output_index: number;
  readonly delta: string;
}

export interface OpenAIResponsesFunctionCallArgumentsDoneEvent {
  readonly type: 'response.function_call_arguments.done';
  readonly item_id: string;
  readonly output_index: number;
  readonly name: string;
  readonly arguments: string;
}

export interface OpenAIResponsesReasoningTextDeltaEvent {
  readonly type: 'response.reasoning_text.delta';
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
  readonly delta: string;
}

export interface OpenAIResponsesReasoningSummaryTextDeltaEvent {
  readonly type: 'response.reasoning_summary_text.delta';
  readonly item_id: string;
  readonly output_index: number;
  readonly summary_index: number;
  readonly delta: string;
}

export interface OpenAIResponsesCompletedEvent {
  readonly type: 'response.completed' | 'response.done';
  readonly response: OpenAIResponsesResponse;
}

export type OpenAIResponsesStreamEvent =
  | OpenAIResponsesOutputTextDeltaEvent
  | OpenAIResponsesOutputTextDoneEvent
  | OpenAIResponsesFunctionCallArgumentsDeltaEvent
  | OpenAIResponsesFunctionCallArgumentsDoneEvent
  | OpenAIResponsesReasoningTextDeltaEvent
  | OpenAIResponsesReasoningSummaryTextDeltaEvent
  | OpenAIResponsesCompletedEvent
  | { readonly type: string; readonly [key: string]: unknown };

export class OpenAIResponsesStream implements AsyncIterable<OpenAIResponsesStreamEvent> {
  private readonly finalResultPromise: Promise<OpenAIResponsesResponse>;
  private resolveFinal!: (value: OpenAIResponsesResponse) => void;
  private rejectFinal!: (reason: unknown) => void;

  constructor(private readonly source: AbortableAsyncIterable<SseEvent>) {
    this.finalResultPromise = new Promise<OpenAIResponsesResponse>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
  }

  get finalResult(): Promise<OpenAIResponsesResponse> {
    return this.finalResultPromise;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<OpenAIResponsesStreamEvent, void, undefined> {
    let finalResponse: OpenAIResponsesResponse | undefined;
    try {
      for await (const event of this.source) {
        if (event.data === '[DONE]') break;
        const payload = JSON.parse(event.data) as OpenAIResponsesStreamEvent;
        if (payload.type === 'response.completed' || payload.type === 'response.done') {
          const candidate = payload.response;
          if (candidate && typeof candidate === 'object') {
            finalResponse = candidate as OpenAIResponsesResponse;
          }
        }
        yield payload;
      }

      if (!finalResponse) {
        throw new Error('OpenAI Responses stream ended without a completed response payload');
      }
      this.resolveFinal(finalResponse);
    } catch (error) {
      this.rejectFinal(error);
      throw error;
    }
  }
}

export class OpenAICompatClient {
  constructor(
    private readonly http: HttpClient,
    private readonly runner?: RequestRunner | undefined,
  ) {}

  private request<T>(
    operation: (http: HttpClient, signal?: AbortSignal) => Promise<T>,
    model: string | undefined,
    signal?: AbortSignal,
    holdUntil?: ((result: T) => Promise<unknown>) | undefined,
  ): Promise<T> {
    if (this.runner) {
      return this.runner(
        (http, runnerSignal) => operation(http, runnerSignal),
        {
          ...(model !== undefined ? { model } : {}),
          ...(signal !== undefined ? { signal } : {}),
          ...(holdUntil !== undefined ? { holdUntil } : {}),
        },
      );
    }
    return operation(this.http, signal);
  }

  async createChatCompletion(
    request: OpenAIChatCompletionRequest & { stream: true },
    signal?: AbortSignal,
  ): Promise<OpenAIChatCompletionStream>;
  async createChatCompletion(
    request: OpenAIChatCompletionRequest & { stream?: false | undefined },
    signal?: AbortSignal,
  ): Promise<OpenAIChatCompletionResponse>;
  async createChatCompletion(
    request: OpenAIChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<OpenAIChatCompletionResponse | OpenAIChatCompletionStream> {
    if (request.stream) {
      return this.request(
        (http, requestSignal) =>
          http.requestSseStream({
            path: '/v1/chat/completions',
            body: request,
            signal: requestSignal,
          }).then((source) => new OpenAIChatCompletionStream(source)),
        request.model,
        signal,
        (stream) => stream.finalResult,
      );
    }
    return this.request(
      (http, requestSignal) =>
        http.request<OpenAIChatCompletionResponse>({
          path: '/v1/chat/completions',
          body: request,
          signal: requestSignal,
        }),
      request.model,
      signal,
    );
  }

  async chatCompletions(
    request: OpenAIChatCompletionRequest & { stream: true },
    signal?: AbortSignal,
  ): Promise<OpenAIChatCompletionStream>;
  async chatCompletions(
    request: OpenAIChatCompletionRequest & { stream?: false | undefined },
    signal?: AbortSignal,
  ): Promise<OpenAIChatCompletionResponse>;
  async chatCompletions(
    request: OpenAIChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<OpenAIChatCompletionResponse | OpenAIChatCompletionStream> {
    return this.createChatCompletion(request as never, signal);
  }

  async listModels(signal?: AbortSignal): Promise<OpenAIListModelsResponse> {
    return this.request(
      (http, requestSignal) =>
        http.request<OpenAIListModelsResponse>({
          path: '/v1/models',
          method: 'GET',
          signal: requestSignal,
        }),
      undefined,
      signal,
    );
  }

  async retrieveModel(
    model: string,
    signal?: AbortSignal,
  ): Promise<OpenAIModelItem> {
    return this.http.request<OpenAIModelItem>({
      path: `/v1/models/${encodeURIComponent(model)}`,
      method: 'GET',
      signal,
    });
  }

  async getModel(model: string, signal?: AbortSignal): Promise<OpenAIModelItem> {
    return this.retrieveModel(model, signal);
  }

  async createCompletion(
    request: OpenAICompletionRequest & { stream: true },
    signal?: AbortSignal,
  ): Promise<OpenAICompletionStream>;
  async createCompletion(
    request: OpenAICompletionRequest & { stream?: false | undefined },
    signal?: AbortSignal,
  ): Promise<OpenAICompletionResponse>;
  async createCompletion(
    request: OpenAICompletionRequest,
    signal?: AbortSignal,
  ): Promise<OpenAICompletionResponse | OpenAICompletionStream> {
    if (request.stream) {
      const source = await this.http.requestSseStream({
        path: '/v1/completions',
        body: request,
        signal,
      });
      return new OpenAICompletionStream(source);
    }
    return this.http.request<OpenAICompletionResponse>({
      path: '/v1/completions',
      body: request,
      signal,
    });
  }

  async completions(
    request: OpenAICompletionRequest,
    signal?: AbortSignal,
  ): Promise<OpenAICompletionResponse> {
    return this.createCompletion(request, signal);
  }

  async createEmbedding(
    request: OpenAIEmbeddingRequest,
    signal?: AbortSignal,
  ): Promise<OpenAIEmbeddingResponse> {
    return this.http.request<OpenAIEmbeddingResponse>({
      path: '/v1/embeddings',
      body: request,
      signal,
    });
  }

  async embeddings(
    request: OpenAIEmbeddingRequest,
    signal?: AbortSignal,
  ): Promise<OpenAIEmbeddingResponse> {
    return this.createEmbedding(request, signal);
  }

  async createResponses(
    request: OpenAIResponsesRequest & { stream: true },
    signal?: AbortSignal,
  ): Promise<OpenAIResponsesStream>;
  async createResponses(
    request: OpenAIResponsesRequest & { stream?: false | undefined },
    signal?: AbortSignal,
  ): Promise<OpenAIResponsesResponse>;
  async createResponses(
    request: OpenAIResponsesRequest,
    signal?: AbortSignal,
  ): Promise<OpenAIResponsesResponse | OpenAIResponsesStream> {
    if (request.stream) {
      const source = await this.http.requestSseStream({
        path: '/v1/responses',
        body: request,
        signal,
      });
      return new OpenAIResponsesStream(source);
    }
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
