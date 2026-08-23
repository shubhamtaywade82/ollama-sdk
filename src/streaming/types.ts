/**
 * Streaming event types, listener contracts, and aggregated result shapes.
 */

import type {
  ChatResponse,
  GenerateResponse,
  ProgressResponse,
  ToolCall,
  Message,
} from '../types.js';
import type { OllamaClientError } from '../errors.js';
import type { TokenUsage } from '../usage.js';

export interface TokenEvent {
  readonly type: 'token';
  readonly data: { readonly delta: string; readonly role?: string | undefined };
}

export interface ThinkingEvent {
  readonly type: 'thinking';
  readonly data: { readonly delta: string };
}

export interface ToolCallEvent {
  readonly type: 'tool_call';
  readonly data: { readonly toolCall: ToolCall };
}

export interface MessageEvent<TChunk> {
  readonly type: 'message';
  readonly data: { readonly chunk: TChunk };
}

export interface DoneEvent<TFinal> {
  readonly type: 'done';
  readonly data: { readonly result: TFinal };
}

export interface ErrorEvent {
  readonly type: 'error';
  readonly data: { readonly error: OllamaClientError };
}

export type OllamaStreamEvent<TChunk, TFinal> =
  | TokenEvent
  | ThinkingEvent
  | ToolCallEvent
  | MessageEvent<TChunk>
  | DoneEvent<TFinal>
  | ErrorEvent;

export type OllamaStreamEventType = OllamaStreamEvent<unknown, unknown>['type'];

export interface ChatStreamResult {
  readonly message: Message;
  readonly model: string;
  readonly done: boolean;
  /** Mirrors the final chunk's `done_reason` (e.g. `"stop"`, `"load"`, `"unload"`). */
  readonly doneReason?: string | undefined;
  readonly totalDurationMs?: number | undefined;
  readonly usage?: TokenUsage | undefined;
  readonly raw?: ChatResponse | undefined;
}

export interface GenerateStreamResult {
  readonly response: string;
  readonly model: string;
  readonly done: boolean;
  /** Mirrors the final chunk's `done_reason` (e.g. `"stop"`, `"load"`, `"unload"`). */
  readonly doneReason?: string | undefined;
  readonly totalDurationMs?: number | undefined;
  readonly usage?: TokenUsage | undefined;
  readonly raw?: GenerateResponse | undefined;
}

export interface ProgressStreamResult {
  readonly status: string;
  readonly completed?: number | undefined;
  readonly total?: number | undefined;
  readonly done: boolean;
  readonly raw?: ProgressResponse | undefined;
}

export interface AbortableAsyncIterable<T> extends AsyncIterable<T> {
  abort?: (() => void) | undefined;
}
