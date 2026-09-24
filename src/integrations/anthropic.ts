/**
 * Anthropic Compatibility interfaces and client helpers for Ollama.
 * Ollama supports the Anthropic Messages API format.
 */

import type { AbortableAsyncIterable } from '../streaming/types.js';
import type { SseEvent } from '../streaming/sse.js';
import type { HttpClient } from '../transport/http.js';
import type { RequestRunner } from '../transport/runner.js';
import { OllamaAbortError } from '../errors.js';

export interface AnthropicCacheControl {
  readonly type: 'ephemeral';
}

export interface AnthropicTextContentBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: AnthropicCacheControl | undefined;
}

export interface AnthropicImageContentBlock {
  readonly type: 'image';
  readonly source: {
    readonly type: 'base64';
    readonly media_type: string;
    readonly data: string;
  };
}

export interface AnthropicToolUseContentBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface AnthropicToolResultContentBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content?: string | readonly AnthropicTextContentBlock[] | undefined;
  readonly is_error?: boolean | undefined;
}

export interface AnthropicThinkingContentBlock {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly signature?: string | undefined;
}

export interface AnthropicRedactedThinkingContentBlock {
  readonly type: 'redacted_thinking';
  readonly data: string;
}

export type AnthropicContentBlock =
  | AnthropicTextContentBlock
  | AnthropicImageContentBlock
  | AnthropicToolUseContentBlock
  | AnthropicToolResultContentBlock
  | AnthropicThinkingContentBlock
  | AnthropicRedactedThinkingContentBlock;

export interface AnthropicMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly AnthropicContentBlock[];
}

export interface AnthropicSystemTextBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: AnthropicCacheControl | undefined;
}

export type AnthropicSystem = string | readonly AnthropicSystemTextBlock[];

export interface AnthropicTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly input_schema: Record<string, unknown>;
  readonly eager_input_streaming?: boolean | undefined;
}

export type AnthropicToolChoice =
  | { readonly type: 'auto' }
  | { readonly type: 'any' }
  | { readonly type: 'tool'; readonly name: string };

export interface AnthropicThinkingConfig {
  readonly type: 'enabled' | 'disabled' | 'adaptive';
  readonly display?: 'omitted' | 'summarized' | 'updates' | undefined;
}

export interface AnthropicOutputConfig {
  readonly effort?: string | undefined;
}

export interface AnthropicMessagesRequest {
  readonly model: string;
  readonly messages: readonly AnthropicMessage[];
  readonly system?: AnthropicSystem | undefined;
  readonly max_tokens?: number | undefined;
  readonly temperature?: number | undefined;
  readonly top_p?: number | undefined;
  readonly top_k?: number | undefined;
  readonly stop_sequences?: readonly string[] | undefined;
  readonly stream?: boolean | undefined;
  readonly tools?: readonly AnthropicTool[] | undefined;
  readonly thinking?: AnthropicThinkingConfig | undefined;
  readonly output_config?: AnthropicOutputConfig | undefined;
  readonly tool_choice?: AnthropicToolChoice | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface AnthropicMessagesResponse {
  readonly id: string;
  readonly type: 'message';
  readonly role: 'assistant';
  readonly content: readonly AnthropicContentBlock[];
  readonly model: string;
  readonly stop_reason: string | null;
  readonly stop_sequence?: string | null | undefined;
  readonly usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  } | undefined;
}

export interface AnthropicMessageStartEvent {
  readonly type: 'message_start';
  readonly message: AnthropicMessagesResponse;
}

export interface AnthropicContentBlockStartEvent {
  readonly type: 'content_block_start';
  readonly index: number;
  readonly content_block: AnthropicContentBlock;
}

export type AnthropicContentBlockDelta =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'input_json_delta'; readonly partial_json: string }
  | { readonly type: 'thinking_delta'; readonly thinking: string }
  | { readonly type: 'signature_delta'; readonly signature: string };

export interface AnthropicContentBlockDeltaEvent {
  readonly type: 'content_block_delta';
  readonly index: number;
  readonly delta: AnthropicContentBlockDelta;
}

export interface AnthropicContentBlockStopEvent {
  readonly type: 'content_block_stop';
  readonly index: number;
}

export interface AnthropicMessageDeltaEvent {
  readonly type: 'message_delta';
  readonly delta: {
    readonly stop_reason?: string | null | undefined;
    readonly stop_sequence?: string | null | undefined;
  };
  readonly usage?: {
    readonly output_tokens: number;
  } | undefined;
}

export interface AnthropicMessageStopEvent {
  readonly type: 'message_stop';
}

export interface AnthropicPingEvent {
  readonly type: 'ping';
}

export interface AnthropicErrorEvent {
  readonly type: 'error';
  readonly error: {
    readonly type: string;
    readonly message: string;
  };
}

export type AnthropicMessageStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent;

function parseAnthropicEvent(event: SseEvent): AnthropicMessageStreamEvent {
  return JSON.parse(event.data) as AnthropicMessageStreamEvent;
}

function mergeContentBlock(
  current: AnthropicContentBlock,
  delta: AnthropicContentBlockDelta,
): AnthropicContentBlock {
  if (delta.type === 'text_delta' && current.type === 'text') {
    return { ...current, text: current.text + delta.text };
  }
  if (delta.type === 'input_json_delta' && current.type === 'tool_use') {
    return current;
  }
  if (delta.type === 'thinking_delta' && current.type === 'thinking') {
    return { ...current, thinking: current.thinking + delta.thinking };
  }
  if (delta.type === 'signature_delta' && current.type === 'thinking') {
    return { ...current, signature: (current.signature ?? '') + delta.signature };
  }
  return current;
}

export class AnthropicMessagesStream implements AsyncIterable<AnthropicMessageStreamEvent> {
  private readonly finalResultPromise: Promise<AnthropicMessagesResponse>;
  private resolveFinal!: (value: AnthropicMessagesResponse) => void;
  private rejectFinal!: (reason: unknown) => void;
  private removeAbortListener: (() => void) | undefined;

  constructor(private readonly source: AbortableAsyncIterable<SseEvent>, signal?: AbortSignal) {
    this.finalResultPromise = new Promise<AnthropicMessagesResponse>((resolve, reject) => {
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

  get finalResult(): Promise<AnthropicMessagesResponse> {
    return this.finalResultPromise;
  }

  abort(): void {
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    this.source.abort?.();
    this.rejectFinal(new OllamaAbortError('Anthropic Messages stream aborted'));
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AnthropicMessageStreamEvent, void, undefined> {
    let message:
      | AnthropicMessagesResponse
      | undefined;
    const blocks = new Map<number, AnthropicContentBlock>();
    const toolInputJson = new Map<number, string>();
    let completed = false;

    try {
      for await (const rawEvent of this.source) {
        let event: AnthropicMessageStreamEvent;
        try {
          event = parseAnthropicEvent(rawEvent);
        } catch (error) {
          throw new Error('Failed to parse Anthropic message SSE payload', { cause: error });
        }

        if (event.type === 'error') {
          throw new Error(event.error.message);
        }

        if (event.type === 'message_start') {
          message = {
            ...event.message,
            content: [],
            ...(event.message.usage !== undefined ? { usage: event.message.usage } : {}),
          };
        } else if (event.type === 'content_block_start') {
          blocks.set(event.index, event.content_block);
        } else if (event.type === 'content_block_delta') {
          const current = blocks.get(event.index);
          if (event.delta.type === 'input_json_delta') {
            toolInputJson.set(event.index, (toolInputJson.get(event.index) ?? '') + event.delta.partial_json);
          }
          if (current) blocks.set(event.index, mergeContentBlock(current, event.delta));
        } else if (event.type === 'content_block_stop') {
          const current = blocks.get(event.index);
          if (current?.type === 'tool_use') {
            const rawJson = toolInputJson.get(event.index);
            if (rawJson !== undefined && rawJson !== '') {
              try {
                const parsed = JSON.parse(rawJson) as Record<string, unknown>;
                blocks.set(event.index, { ...current, input: parsed });
              } catch {
                // Keep the provider-provided partial object when the accumulated JSON is malformed.
                blocks.set(event.index, current);
              }
            }
          }
        } else if (event.type === 'message_delta') {
          if (message) {
            message = {
              ...message,
              stop_reason:
                event.delta.stop_reason !== undefined && event.delta.stop_reason !== null
                  ? event.delta.stop_reason
                  : message.stop_reason,
              stop_sequence: event.delta.stop_sequence ?? message.stop_sequence,
              ...(event.usage !== undefined
                ? {
                    usage: {
                      input_tokens: message.usage?.input_tokens ?? 0,
                      output_tokens: event.usage.output_tokens,
                    },
                  }
                : {}),
            };
          }
        } else if (event.type === 'message_stop' && message) {
          message = {
            ...message,
            content: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block),
          };
        }

        yield event;
      }

      if (!message) {
        throw new Error('Anthropic Messages stream ended without message_start');
      }

      const final: AnthropicMessagesResponse = {
        ...message,
        content: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block),
      };
      completed = true;
      this.removeAbortListener?.();
      this.removeAbortListener = undefined;
      this.resolveFinal(final);
    } catch (error) {
      this.removeAbortListener?.();
      this.removeAbortListener = undefined;
      this.rejectFinal(error);
      throw error;
    } finally {
      if (!completed) {
        this.source.abort?.();
        this.rejectFinal(new OllamaAbortError('Anthropic Messages stream ended before completion'));
      }
    }
  }
}

export class AnthropicCompatClient {
  constructor(
    private readonly http: HttpClient,
    private readonly runner?: RequestRunner | undefined,
  ) {}

  private request<T>(
    operation: (http: HttpClient, signal?: AbortSignal) => Promise<T>,
    model: string,
    signal?: AbortSignal,
    holdUntil?: ((result: T) => Promise<unknown>) | undefined,
  ): Promise<T> {
    if (this.runner) {
      return this.runner(
        (http, runnerSignal) => operation(http, runnerSignal),
        {
          model,
          ...(signal !== undefined ? { signal } : {}),
          ...(holdUntil !== undefined ? { holdUntil } : {}),
        },
      );
    }
    return operation(this.http, signal);
  }

  async createMessage(
    request: AnthropicMessagesRequest & { stream: true },
    signal?: AbortSignal,
  ): Promise<AnthropicMessagesStream>;
  async createMessage(
    request: AnthropicMessagesRequest & { stream?: false | undefined },
    signal?: AbortSignal,
  ): Promise<AnthropicMessagesResponse>;
  async createMessage(
    request: AnthropicMessagesRequest & ({ stream: true } | { stream?: false | undefined }),
    signal?: AbortSignal,
  ): Promise<AnthropicMessagesResponse | AnthropicMessagesStream>; 
  async createMessage(
    request: AnthropicMessagesRequest,
    signal?: AbortSignal,
  ): Promise<AnthropicMessagesResponse | AnthropicMessagesStream> {
    if (request.stream) {
      return this.request(
        (http, requestSignal) =>
          http.requestSseStream({
            path: '/v1/messages',
            body: request,
            signal: requestSignal,
          }).then((source) => new AnthropicMessagesStream(source, requestSignal)),
        request.model,
        signal,
        (stream: AnthropicMessagesStream) => stream.finalResult,
      );
    }
    return this.request(
      (http, requestSignal) =>
        http.request<AnthropicMessagesResponse>({
          path: '/v1/messages',
          body: request,
          signal: requestSignal,
        }),
      request.model,
      signal,
    );
  }

  async messages(
    request: AnthropicMessagesRequest & { stream: true },
    signal?: AbortSignal,
  ): Promise<AnthropicMessagesStream>;
  async messages(
    request: AnthropicMessagesRequest & { stream?: false | undefined },
    signal?: AbortSignal,
  ): Promise<AnthropicMessagesResponse>;
  async messages(
    request: AnthropicMessagesRequest,
    signal?: AbortSignal,
  ): Promise<AnthropicMessagesResponse | AnthropicMessagesStream> {
    if (request.stream) {
      return this.createMessage(request, signal);
    }
    return this.createMessage(request, signal);
  }
}
