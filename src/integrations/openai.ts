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
import type { RequestRunner } from '../transport/runner.js';
import { OllamaAbortError, OllamaClientError } from '../errors.js';

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

/** Ollama Chat Completions supports text plus base64 image content via a string image URL. */
export type OllamaOpenAIChatContentPart =
  | OpenAITextContentPart
  | {
      readonly type: 'image_url';
      /** Ollama currently documents base64-encoded image data URLs; ordinary remote URLs are unsupported. */
      readonly image_url: string;
    };

export type OllamaOpenAIChatMessage = Omit<OpenAIMessage, 'content'> & {
  readonly content: string | readonly OllamaOpenAIChatContentPart[];
};

/** Strict Ollama-documented Chat Completions request; excludes only the SDK-only parallel tool flag. */
export type OllamaOpenAIChatCompletionRequest = Omit<
  OpenAIChatCompletionRequest,
  'messages' | 'parallel_tool_calls' | 'reasoning_effort' | 'reasoning'
> & {
  readonly messages: readonly OllamaOpenAIChatMessage[];
  readonly reasoning_effort?: OllamaOpenAIReasoningEffort | undefined;
  readonly reasoning?: { readonly effort?: OllamaOpenAIReasoningEffort | undefined } | undefined;
};

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

/** Strict Ollama-documented Completions request. */
export type OllamaOpenAICompletionRequest = OpenAICompletionRequest;

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

/** Strict Ollama-documented Embeddings request. */
export type OllamaOpenAIEmbeddingRequest = OpenAIEmbeddingRequest;

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

/** Strict Ollama-documented Responses request; excludes stateful and SDK-only request fields. */
export type OllamaOpenAIResponsesRequest = Omit<
  OpenAIResponsesRequest,
  'previous_response_id' | 'conversation' | 'reasoning' | 'think'
>;

export type OpenAIResponsesStatus = 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'queued' | 'incomplete';

export interface OpenAIResponsesError { readonly code?: string | undefined; readonly message?: string | undefined; readonly [key: string]: unknown; }
export interface OpenAIResponsesIncompleteDetails { readonly reason?: string | undefined; readonly [key: string]: unknown; }

export interface OpenAIResponsesOutputTextContent {
  readonly type: 'output_text'; readonly text: string;
  readonly annotations?: readonly Record<string, unknown>[] | undefined;
  readonly logprobs?: readonly Record<string, unknown>[] | undefined;
}
export interface OpenAIResponsesOutputRefusal { readonly type: 'refusal'; readonly refusal: string; }
export type OpenAIResponsesOutputContent = OpenAIResponsesOutputTextContent | OpenAIResponsesOutputRefusal;

export interface OpenAIResponsesOutputMessage {
  readonly type: 'message'; readonly id?: string | undefined; readonly status?: OpenAIResponsesStatus | undefined;
  readonly role?: string | undefined; readonly phase?: string | undefined;
  readonly content: readonly OpenAIResponsesOutputContent[];
}
export interface OpenAIResponsesOutputFunctionCall {
  readonly type: 'function_call'; readonly id?: string | undefined; readonly call_id?: string | undefined;
  readonly name: string; readonly arguments: string; readonly status?: OpenAIResponsesStatus | undefined;
}
export interface OpenAIResponsesOutputReasoning {
  readonly type: 'reasoning'; readonly id?: string | undefined; readonly status?: OpenAIResponsesStatus | undefined;
  readonly summary?: readonly { readonly type: 'summary_text'; readonly text: string }[] | undefined;
  readonly text?: string | undefined; readonly encrypted_content?: string | undefined;
}
export type OpenAIResponsesOutputItem = OpenAIResponsesOutputMessage | OpenAIResponsesOutputFunctionCall | OpenAIResponsesOutputReasoning;

export interface OpenAIResponsesUsage {
  readonly input_tokens: number; readonly output_tokens: number; readonly total_tokens: number;
  readonly input_tokens_details?: Record<string, unknown> | undefined;
  readonly output_tokens_details?: Record<string, unknown> | undefined;
}

/** Non-stateful response shape for the Ollama Responses compatibility endpoint. */
export interface OpenAIResponsesResponse {
  readonly id: string; readonly object: 'response'; readonly created: number;
  readonly created_at?: number | undefined; readonly status?: OpenAIResponsesStatus | undefined;
  readonly completed_at?: number | null | undefined; readonly error?: OpenAIResponsesError | null | undefined;
  readonly incomplete_details?: OpenAIResponsesIncompleteDetails | null | undefined;
  readonly model: string; readonly output: readonly OpenAIResponsesOutputItem[];
  readonly output_text?: string | undefined; readonly previous_response_id?: string | null | undefined;
  readonly parallel_tool_calls?: boolean | undefined; readonly usage?: OpenAIResponsesUsage | undefined;
}

export class OpenAIResponsesStreamError extends OllamaClientError {
  readonly responsePayload: OpenAIResponsesResponse;
  constructor(message: string, responsePayload: OpenAIResponsesResponse) {
    super(message, { code: 'openai_responses_stream_error', retryable: false, response: { body: responsePayload } });
    this.responsePayload = responsePayload;
  }
}
export class OpenAIChatCompletionStream implements AsyncIterable<OpenAIChatCompletionChunk> {
  private readonly finalResultPromise: Promise<OpenAIChatCompletionResponse>;
  private resolveFinal!: (value: OpenAIChatCompletionResponse) => void;
  private rejectFinal!: (reason: unknown) => void;
  private removeAbortListener: (() => void) | undefined;

  constructor(private readonly source: AbortableAsyncIterable<SseEvent>, signal?: AbortSignal) {
    this.finalResultPromise = new Promise<OpenAIChatCompletionResponse>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
    if (signal !== undefined) {
      const onAbort = (): void => this.abort();
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        this.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
    }
  }

  get finalResult(): Promise<OpenAIChatCompletionResponse> {
    return this.finalResultPromise;
  }

  abort(): void {
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    this.source.abort?.();
    this.rejectFinal(new OllamaAbortError('OpenAI Chat Completion stream aborted'));
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
    let completed = false;

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
      completed = true;
      this.removeAbortListener?.();
      this.removeAbortListener = undefined;
      this.resolveFinal(response);
    } catch (error) {
      this.removeAbortListener?.();
      this.removeAbortListener = undefined;
      this.rejectFinal(error);
      throw error;
    } finally {
      if (!completed) {
        this.source.abort?.();
        this.rejectFinal(new OllamaAbortError('OpenAI Chat Completion stream ended before completion'));
      }
    }
  }
}

export class OpenAICompletionStream implements AsyncIterable<OpenAICompletionChunk> {
  private readonly finalResultPromise: Promise<OpenAICompletionResponse>;
  private resolveFinal!: (value: OpenAICompletionResponse) => void;
  private rejectFinal!: (reason: unknown) => void;
  private removeAbortListener: (() => void) | undefined;

  constructor(private readonly source: AbortableAsyncIterable<SseEvent>, signal?: AbortSignal) {
    this.finalResultPromise = new Promise<OpenAICompletionResponse>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
    if (signal !== undefined) {
      const onAbort = (): void => this.abort();
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        this.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
    }
  }

  get finalResult(): Promise<OpenAICompletionResponse> {
    return this.finalResultPromise;
  }

  abort(): void {
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    this.source.abort?.();
    this.rejectFinal(new OllamaAbortError('OpenAI Completion stream aborted'));
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<OpenAICompletionChunk, void, undefined> {
    const texts = new Map<number, OpenAICompletionChoice>();
    let id = '';
    let model = '';
    let created = 0;
    let usage:
      | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      | undefined;
    let completed = false;

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
      completed = true;
      this.removeAbortListener?.();
      this.removeAbortListener = undefined;
      this.resolveFinal(response);
    } catch (error) {
      this.removeAbortListener?.();
      this.removeAbortListener = undefined;
      this.rejectFinal(error);
      throw error;
    } finally {
      if (!completed) {
        this.source.abort?.();
        this.rejectFinal(new OllamaAbortError('OpenAI Completion stream ended before completion'));
      }
    }
  }
}

export interface OpenAIResponsesEventBase { readonly response_id?: string | undefined; readonly sequence_number?: number | undefined; }

export interface OpenAIResponsesOutputTextDeltaEvent extends OpenAIResponsesEventBase { readonly type: 'response.output_text.delta'; readonly item_id: string; readonly output_index: number; readonly content_index: number; readonly delta: string; }
export interface OpenAIResponsesOutputTextDoneEvent extends OpenAIResponsesEventBase { readonly type: 'response.output_text.done'; readonly item_id: string; readonly output_index: number; readonly content_index: number; readonly text: string; }
export interface OpenAIResponsesFunctionCallArgumentsDeltaEvent extends OpenAIResponsesEventBase { readonly type: 'response.function_call_arguments.delta'; readonly item_id: string; readonly output_index: number; readonly delta: string; }
export interface OpenAIResponsesFunctionCallArgumentsDoneEvent extends OpenAIResponsesEventBase { readonly type: 'response.function_call_arguments.done'; readonly item_id: string; readonly output_index: number; readonly arguments: string; readonly name?: string | undefined; }
export interface OpenAIResponsesReasoningTextDeltaEvent extends OpenAIResponsesEventBase { readonly type: 'response.reasoning_text.delta'; readonly item_id: string; readonly output_index: number; readonly content_index: number; readonly delta: string; }
export interface OpenAIResponsesReasoningTextDoneEvent extends OpenAIResponsesEventBase { readonly type: 'response.reasoning_text.done'; readonly item_id: string; readonly output_index: number; readonly content_index: number; readonly text: string; }
export interface OpenAIResponsesReasoningSummaryPartAddedEvent extends OpenAIResponsesEventBase { readonly type: 'response.reasoning_summary_part.added'; readonly item_id: string; readonly output_index: number; readonly summary_index: number; readonly part: { readonly type: 'summary_text'; readonly text: string }; }
export interface OpenAIResponsesReasoningSummaryPartDoneEvent extends OpenAIResponsesEventBase { readonly type: 'response.reasoning_summary_part.done'; readonly item_id: string; readonly output_index: number; readonly summary_index: number; readonly part: { readonly type: 'summary_text'; readonly text: string }; readonly status?: 'incomplete' | undefined; }
export interface OpenAIResponsesReasoningSummaryTextDeltaEvent extends OpenAIResponsesEventBase { readonly type: 'response.reasoning_summary_text.delta'; readonly item_id: string; readonly output_index: number; readonly summary_index: number; readonly delta: string; }
export interface OpenAIResponsesReasoningSummaryTextDoneEvent extends OpenAIResponsesEventBase { readonly type: 'response.reasoning_summary_text.done'; readonly item_id: string; readonly output_index: number; readonly summary_index: number; readonly text: string; }
export interface OpenAIResponsesOutputItemAddedEvent extends OpenAIResponsesEventBase { readonly type: 'response.output_item.added'; readonly item: OpenAIResponsesOutputItem; readonly output_index: number; }
export interface OpenAIResponsesOutputItemDoneEvent extends OpenAIResponsesEventBase { readonly type: 'response.output_item.done'; readonly item: OpenAIResponsesOutputItem; readonly output_index: number; }
export interface OpenAIResponsesContentPartAddedEvent extends OpenAIResponsesEventBase { readonly type: 'response.content_part.added'; readonly item_id: string; readonly output_index: number; readonly content_index: number; readonly part: OpenAIResponsesOutputContent | { readonly type: string; readonly [key: string]: unknown }; }
export interface OpenAIResponsesContentPartDoneEvent extends OpenAIResponsesEventBase { readonly type: 'response.content_part.done'; readonly item_id: string; readonly output_index: number; readonly content_index: number; readonly part: OpenAIResponsesOutputContent | { readonly type: string; readonly [key: string]: unknown }; }
export interface OpenAIResponsesRefusalDeltaEvent extends OpenAIResponsesEventBase { readonly type: 'response.refusal.delta'; readonly item_id: string; readonly output_index: number; readonly content_index: number; readonly delta: string; }
export interface OpenAIResponsesRefusalDoneEvent extends OpenAIResponsesEventBase { readonly type: 'response.refusal.done'; readonly item_id: string; readonly output_index: number; readonly content_index: number; readonly refusal: string; }
export interface OpenAIResponsesCreatedEvent extends OpenAIResponsesEventBase { readonly type: 'response.created'; readonly response: OpenAIResponsesResponse; }
export interface OpenAIResponsesInProgressEvent extends OpenAIResponsesEventBase { readonly type: 'response.in_progress'; readonly response: OpenAIResponsesResponse; }
export interface OpenAIResponsesQueuedEvent extends OpenAIResponsesEventBase { readonly type: 'response.queued'; readonly response: OpenAIResponsesResponse; }
export interface OpenAIResponsesCompletedEvent extends OpenAIResponsesEventBase { readonly type: 'response.completed' | 'response.done'; readonly response: OpenAIResponsesResponse; }
export interface OpenAIResponsesFailedEvent extends OpenAIResponsesEventBase { readonly type: 'response.failed'; readonly response: OpenAIResponsesResponse; }
export interface OpenAIResponsesIncompleteEvent extends OpenAIResponsesEventBase { readonly type: 'response.incomplete'; readonly response: OpenAIResponsesResponse; }

export type OpenAIResponsesStreamEvent =
  | OpenAIResponsesOutputTextDeltaEvent | OpenAIResponsesOutputTextDoneEvent
  | OpenAIResponsesFunctionCallArgumentsDeltaEvent | OpenAIResponsesFunctionCallArgumentsDoneEvent
  | OpenAIResponsesReasoningTextDeltaEvent | OpenAIResponsesReasoningTextDoneEvent
  | OpenAIResponsesReasoningSummaryPartAddedEvent | OpenAIResponsesReasoningSummaryPartDoneEvent
  | OpenAIResponsesReasoningSummaryTextDeltaEvent | OpenAIResponsesReasoningSummaryTextDoneEvent
  | OpenAIResponsesOutputItemAddedEvent | OpenAIResponsesOutputItemDoneEvent
  | OpenAIResponsesContentPartAddedEvent | OpenAIResponsesContentPartDoneEvent
  | OpenAIResponsesRefusalDeltaEvent | OpenAIResponsesRefusalDoneEvent
  | OpenAIResponsesCreatedEvent | OpenAIResponsesInProgressEvent | OpenAIResponsesQueuedEvent
  | OpenAIResponsesCompletedEvent | OpenAIResponsesFailedEvent | OpenAIResponsesIncompleteEvent
  | { readonly type: string; readonly [key: string]: unknown };

type OpenAIResponsesOutputState = {
  itemId: string; kind: 'message' | 'function_call' | 'reasoning';
  content: Map<number, OpenAIResponsesOutputContent>; summary: Map<number, string>;
  arguments: string; name?: string | undefined; callId?: string | undefined; status?: OpenAIResponsesStatus | undefined;
  role?: string | undefined; phase?: string | undefined; reasoningText: string;
};
export class OpenAIResponsesStream implements AsyncIterable<OpenAIResponsesStreamEvent> {
  private readonly finalResultPromise: Promise<OpenAIResponsesResponse>;
  private resolveFinal!: (value: OpenAIResponsesResponse) => void;
  private rejectFinal!: (reason: unknown) => void;
  private removeAbortListener: (() => void) | undefined;

  constructor(private readonly source: AbortableAsyncIterable<SseEvent>, signal?: AbortSignal) {
    this.finalResultPromise = new Promise<OpenAIResponsesResponse>((resolve, reject) => { this.resolveFinal = resolve; this.rejectFinal = reject; });
    if (signal !== undefined) {
      const onAbort = (): void => this.abort();
      if (signal.aborted) onAbort();
      else { signal.addEventListener('abort', onAbort, { once: true }); this.removeAbortListener = () => signal.removeEventListener('abort', onAbort); }
    }
  }
  get finalResult(): Promise<OpenAIResponsesResponse> { return this.finalResultPromise; }
  abort(): void {
    this.removeAbortListener?.(); this.removeAbortListener = undefined; this.source.abort?.();
    this.rejectFinal(new OllamaAbortError('OpenAI Responses stream aborted'));
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<OpenAIResponsesStreamEvent, void, undefined> {
    let finalResponse: OpenAIResponsesResponse | undefined;
    let responseMeta: OpenAIResponsesResponse | undefined;
    let terminalFailure: OpenAIResponsesResponse | undefined;
    let terminalIncomplete: OpenAIResponsesResponse | undefined;
    const outputs = new Map<number, OpenAIResponsesOutputState>();
    const canonicalOutputItems = new Map<number, OpenAIResponsesOutputItem>();
    let completed = false;

    const ensureState = (outputIndex: number, itemId: string, kind: OpenAIResponsesOutputState['kind']): OpenAIResponsesOutputState => {
      const existing = outputs.get(outputIndex);
      if (existing) { if (itemId) existing.itemId = itemId; existing.kind = kind; return existing; }
      const state: OpenAIResponsesOutputState = { itemId, kind, content: new Map(), summary: new Map(), arguments: '', reasoningText: '' };
      outputs.set(outputIndex, state); return state;
    };

    const applyOutputItem = (outputIndex: number, item: OpenAIResponsesOutputItem): void => {
      const kind = item.type === 'message' ? 'message' : item.type === 'function_call' ? 'function_call' : 'reasoning';
      const state = ensureState(outputIndex, item.id ?? '', kind);
      state.itemId = item.id ?? state.itemId; state.status = item.status;
      if (item.type === 'message') { state.role = item.role; state.phase = item.phase; state.content.clear(); item.content.forEach((p, i) => state.content.set(i, p)); }
      else if (item.type === 'function_call') { state.callId = item.call_id; state.name = item.name; state.arguments = item.arguments; }
      else { state.summary.clear(); item.summary?.forEach((p, i) => state.summary.set(i, p.text)); state.reasoningText = item.text ?? ''; }
    };
    const applyContentPart = (outputIndex: number, itemId: string, contentIndex: number, part: OpenAIResponsesOutputContent): void => {
      const state = ensureState(outputIndex, itemId, 'message'); state.content.set(contentIndex, part);
    };
    const reconstructedOutput = (): readonly OpenAIResponsesOutputItem[] =>
      [...outputs.entries()].sort(([a], [b]) => a - b).map(([outputIndex, state]) => {
        const canonical = canonicalOutputItems.get(outputIndex); if (canonical) return canonical;
        if (state.kind === 'message') return { type: 'message', ...(state.itemId ? { id: state.itemId } : {}), ...(state.status ? { status: state.status } : {}), role: state.role ?? 'assistant', ...(state.phase ? { phase: state.phase } : {}), content: [...state.content.entries()].sort(([a], [b]) => a - b).map(([, p]) => p) };
        if (state.kind === 'function_call') return { type: 'function_call', ...(state.itemId ? { id: state.itemId } : {}), ...(state.callId ? { call_id: state.callId } : {}), ...(state.status ? { status: state.status } : {}), name: state.name ?? '', arguments: state.arguments };
        return { type: 'reasoning', ...(state.itemId ? { id: state.itemId } : {}), ...(state.status ? { status: state.status } : {}), ...(state.summary.size ? { summary: [...state.summary.entries()].sort(([a], [b]) => a - b).map(([, text]) => ({ type: 'summary_text' as const, text })) } : {}), ...(state.reasoningText ? { text: state.reasoningText } : {}) };
      });

    try {
      for await (const event of this.source) {
        if (event.data === '[DONE]') break;
        let payload: OpenAIResponsesStreamEvent;
        try { payload = JSON.parse(event.data) as OpenAIResponsesStreamEvent; } catch (error) { throw new Error('Failed to parse OpenAI Responses SSE payload', { cause: error }); }
        switch (payload.type) {
          case 'response.created': case 'response.in_progress': case 'response.queued': responseMeta = (payload as OpenAIResponsesCreatedEvent).response; break;
          case 'response.completed': case 'response.done': finalResponse = (payload as OpenAIResponsesCompletedEvent).response; break;
          case 'response.failed': terminalFailure = (payload as OpenAIResponsesFailedEvent).response; finalResponse = terminalFailure; break;
          case 'response.incomplete': terminalIncomplete = (payload as OpenAIResponsesIncompleteEvent).response; finalResponse = terminalIncomplete; break;
          case 'response.output_item.added': { const e = payload as OpenAIResponsesOutputItemAddedEvent; applyOutputItem(e.output_index, e.item); break; }
          case 'response.output_item.done': { const e = payload as OpenAIResponsesOutputItemDoneEvent; applyOutputItem(e.output_index, e.item); canonicalOutputItems.set(e.output_index, e.item); break; }
          case 'response.content_part.added': case 'response.content_part.done': {
            const e = payload as OpenAIResponsesContentPartAddedEvent | OpenAIResponsesContentPartDoneEvent;
            if (
              (e.part.type === 'output_text' && 'text' in e.part && typeof e.part.text === 'string') ||
              (e.part.type === 'refusal' && 'refusal' in e.part && typeof e.part.refusal === 'string')
            ) {
              applyContentPart(e.output_index, e.item_id, e.content_index, e.part as OpenAIResponsesOutputContent);
            }
            break;
          }
          case 'response.output_text.delta': { const e = payload as OpenAIResponsesOutputTextDeltaEvent; const s = ensureState(e.output_index, e.item_id, 'message'); const p=s.content.get(e.content_index); s.content.set(e.content_index,{type:'output_text',text:(p?.type==='output_text'?p.text:'')+e.delta}); break; }
          case 'response.output_text.done': { const e = payload as OpenAIResponsesOutputTextDoneEvent; const s=ensureState(e.output_index,e.item_id,'message'); s.content.set(e.content_index,{type:'output_text',text:e.text}); break; }
          case 'response.refusal.delta': { const e=payload as OpenAIResponsesRefusalDeltaEvent; const s=ensureState(e.output_index,e.item_id,'message'); const p=s.content.get(e.content_index); s.content.set(e.content_index,{type:'refusal',refusal:(p?.type==='refusal'?p.refusal:'')+e.delta}); break; }
          case 'response.refusal.done': { const e=payload as OpenAIResponsesRefusalDoneEvent; const s=ensureState(e.output_index,e.item_id,'message'); s.content.set(e.content_index,{type:'refusal',refusal:e.refusal}); break; }
          case 'response.function_call_arguments.delta': { const e=payload as OpenAIResponsesFunctionCallArgumentsDeltaEvent; const s=ensureState(e.output_index,e.item_id,'function_call'); s.arguments+=e.delta; break; }
          case 'response.function_call_arguments.done': { const e=payload as OpenAIResponsesFunctionCallArgumentsDoneEvent; const s=ensureState(e.output_index,e.item_id,'function_call'); s.arguments=e.arguments; if(e.name!==undefined) s.name=e.name; break; }
          case 'response.reasoning_summary_part.added': case 'response.reasoning_summary_part.done': { const e=payload as OpenAIResponsesReasoningSummaryPartAddedEvent | OpenAIResponsesReasoningSummaryPartDoneEvent; const s=ensureState(e.output_index,e.item_id,'reasoning'); s.summary.set(e.summary_index,e.part.text); break; }
          case 'response.reasoning_summary_text.delta': { const e=payload as OpenAIResponsesReasoningSummaryTextDeltaEvent; const s=ensureState(e.output_index,e.item_id,'reasoning'); s.summary.set(e.summary_index,(s.summary.get(e.summary_index)??'')+e.delta); break; }
          case 'response.reasoning_summary_text.done': { const e=payload as OpenAIResponsesReasoningSummaryTextDoneEvent; const s=ensureState(e.output_index,e.item_id,'reasoning'); s.summary.set(e.summary_index,e.text); break; }
          case 'response.reasoning_text.delta': { const e=payload as OpenAIResponsesReasoningTextDeltaEvent; const s=ensureState(e.output_index,e.item_id,'reasoning'); s.reasoningText+=e.delta; break; }
          case 'response.reasoning_text.done': { const e=payload as OpenAIResponsesReasoningTextDoneEvent; const s=ensureState(e.output_index,e.item_id,'reasoning'); s.reasoningText=e.text; break; }
          default: break;
        }
        yield payload;
      }
      if (terminalFailure || terminalIncomplete) {
        const response = terminalFailure ?? terminalIncomplete!; const status = terminalFailure ? 'failed' : 'incomplete';
        const detail = response.error?.message ?? response.incomplete_details?.reason ?? 'unknown error';
        throw new OpenAIResponsesStreamError('OpenAI Responses stream ' + status + ': ' + detail, response);
      }
      if (!finalResponse) {
        if (!responseMeta) throw new Error('OpenAI Responses stream ended without a terminal response payload');
        if (responseMeta.status === 'failed' || responseMeta.status === 'incomplete') {
          const detail=responseMeta.error?.message ?? responseMeta.incomplete_details?.reason ?? 'unknown error';
          throw new OpenAIResponsesStreamError('OpenAI Responses stream ' + responseMeta.status + ': ' + detail, responseMeta);
        }
        finalResponse={...responseMeta,output:reconstructedOutput(),status:'completed'};
      } else if (finalResponse.status === 'failed' || finalResponse.status === 'incomplete') {
        const detail=finalResponse.error?.message ?? finalResponse.incomplete_details?.reason ?? 'unknown error';
        throw new OpenAIResponsesStreamError('OpenAI Responses stream ' + finalResponse.status + ': ' + detail, finalResponse);
      }
      if (finalResponse.output.length===0 && outputs.size>0) finalResponse={...finalResponse,output:reconstructedOutput()};
      completed=true; this.removeAbortListener?.(); this.removeAbortListener=undefined; this.resolveFinal(finalResponse);
    } catch(error) { this.removeAbortListener?.(); this.removeAbortListener=undefined; this.rejectFinal(error); throw error; }
    finally { if(!completed){ this.source.abort?.(); this.rejectFinal(new OllamaAbortError('OpenAI Responses stream ended before completion')); } }
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
          }).then((source) => new OpenAIChatCompletionStream(source, requestSignal)),
        request.model,
        signal,
        (stream: OpenAIChatCompletionStream) => stream.finalResult,
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
    return this.request(
      (http, requestSignal) =>
        http.request<OpenAIModelItem>({
          path: `/v1/models/${encodeURIComponent(model)}`,
          method: 'GET',
          signal: requestSignal,
        }),
      model,
      signal,
    );
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
      return this.request(
        (http, requestSignal) =>
          http.requestSseStream({
            path: '/v1/completions',
            body: request,
            signal: requestSignal,
          }).then((source) => new OpenAICompletionStream(source, requestSignal)),
        request.model,
        signal,
        (stream: OpenAICompletionStream) => stream.finalResult,
      );
    }
    return this.request(
      (http, requestSignal) =>
        http.request<OpenAICompletionResponse>({
          path: '/v1/completions',
          body: request,
          signal: requestSignal,
        }),
      request.model,
      signal,
    );
  }

  async completions(
    request: OpenAICompletionRequest & { stream: true },
    signal?: AbortSignal,
  ): Promise<OpenAICompletionStream>;
  async completions(
    request: OpenAICompletionRequest & { stream?: false | undefined },
    signal?: AbortSignal,
  ): Promise<OpenAICompletionResponse>;
  async completions(
    request: OpenAICompletionRequest,
    signal?: AbortSignal,
  ): Promise<OpenAICompletionResponse | OpenAICompletionStream> {
    return this.createCompletion(request as never, signal);
  }

  async createEmbedding(
    request: OpenAIEmbeddingRequest,
    signal?: AbortSignal,
  ): Promise<OpenAIEmbeddingResponse> {
    return this.request(
      (http, requestSignal) =>
        http.request<OpenAIEmbeddingResponse>({
          path: '/v1/embeddings',
          body: request,
          signal: requestSignal,
        }),
      request.model,
      signal,
    );
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
      return this.request(
        (http, requestSignal) =>
          http.requestSseStream({
            path: '/v1/responses',
            body: request,
            signal: requestSignal,
          }).then((source) => new OpenAIResponsesStream(source, requestSignal)),
        request.model,
        signal,
        (stream: OpenAIResponsesStream) => stream.finalResult,
      );
    }
    return this.request(
      (http, requestSignal) =>
        http.request<OpenAIResponsesResponse>({
          path: '/v1/responses',
          body: request,
          signal: requestSignal,
        }),
      request.model,
      signal,
    );
  }

  async responses(
    request: OpenAIResponsesRequest & { stream: true },
    signal?: AbortSignal,
  ): Promise<OpenAIResponsesStream>;
  async responses(
    request: OpenAIResponsesRequest & { stream?: false | undefined },
    signal?: AbortSignal,
  ): Promise<OpenAIResponsesResponse>;
  async responses(
    request: OpenAIResponsesRequest,
    signal?: AbortSignal,
  ): Promise<OpenAIResponsesResponse | OpenAIResponsesStream> {
    return this.createResponses(request as never, signal);
  }
}
