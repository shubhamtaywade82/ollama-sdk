/**
 * Dual-mode (AsyncIterator and EventEmitter-like) stream wrapper.
 */

import {
  mapError,
  OllamaAbortError,
  OllamaStreamError,
  type OllamaClientError,
} from '../errors.js';
import type { AbortableAsyncIterable, OllamaStreamEvent, OllamaStreamEventType } from './types.js';

/**
 * Extract accumulated partial content from a stream's intermediate
 * aggregation state, used to enrich {@link OllamaStreamError} when
 * the underlying NDJSON parser detects an in-band `{"error": "..."}`
 * frame mid-flight.
 *
 * Returns `''` for aggregator states that don't carry content (e.g.
 * progress streams for pull/push). The shape is intentionally a
 * best-effort string extractor — callers who want richer partial
 * state should consume the stream's `on('message', …)` events
 * directly.
 */
function extractPartialContent<TFinal>(accumulated: TFinal): string {
  if (typeof accumulated !== 'object' || accumulated === null) return '';
  const record = accumulated as Record<string, unknown>;
  // ChatStreamResult carries `message.content`.
  const message = record.message;
  if (typeof message === 'object' && message !== null) {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
  }
  // GenerateStreamResult carries `response`.
  const response = record.response;
  if (typeof response === 'string') return response;
  // ProgressStreamResult and others don't accumulate content.
  return '';
}

type ChunkMapper<TChunk, TFinal> = (
  chunk: TChunk,
  accumulated: TFinal,
) => Array<OllamaStreamEvent<TChunk, TFinal>>;

type Aggregator<TChunk, TFinal> = (accumulated: TFinal, chunk: TChunk) => TFinal;

type Listener<TChunk, TFinal> = (event: OllamaStreamEvent<TChunk, TFinal>) => void;

export class OllamaStream<TChunk, TFinal> implements AsyncIterable<
  OllamaStreamEvent<TChunk, TFinal>
> {
  private mode: 'unconsumed' | 'iterator' | 'events' = 'unconsumed';
  private readonly listeners = new Map<string, Set<Listener<TChunk, TFinal>>>();
  private readonly finalResultPromise: Promise<TFinal>;
  private resolveFinal!: (value: TFinal) => void;
  private rejectFinal!: (reason: OllamaClientError) => void;
  private removeAbortListener: (() => void) | undefined;

  constructor(
    private readonly source: AbortableAsyncIterable<TChunk>,
    private readonly mapChunk: ChunkMapper<TChunk, TFinal>,
    private readonly aggregate: Aggregator<TChunk, TFinal>,
    private readonly initial: TFinal,
    signal?: AbortSignal,
  ) {
    this.finalResultPromise = new Promise<TFinal>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });

    if (signal !== undefined) {
      const onAbort = (): void => this.abort();
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        this.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      }
    }
  }

  get finalResult(): Promise<TFinal> {
    return this.finalResultPromise;
  }

  abort(): void {
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    this.source.abort?.();
    this.rejectFinal(new OllamaAbortError('Ollama stream aborted'));
  }

  on<TType extends OllamaStreamEventType>(
    type: TType,
    listener: (event: Extract<OllamaStreamEvent<TChunk, TFinal>, { type: TType }>) => void,
  ): () => void {
    if (this.mode === 'iterator') {
      throw new Error(
        'Cannot register event listeners: this stream is already being consumed via async iteration.',
      );
    }

    const genericListener = listener as Listener<TChunk, TFinal>;
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(genericListener);

    if (this.mode !== 'events') {
      this.mode = 'events';
      void this.pump();
    }

    return () => {
      set?.delete(genericListener);
    };
  }

  private emit(event: OllamaStreamEvent<TChunk, TFinal>): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
  }

  private async pump(): Promise<void> {
    let accumulated = this.initial;
    try {
      for await (const chunk of this.source) {
        accumulated = this.aggregate(accumulated, chunk);
        for (const event of this.mapChunk(chunk, accumulated)) {
          this.emit(event);
          if (event.type === 'done') {
            this.resolveFinal(event.data.result);
          }
        }
      }
      this.removeAbortListener?.();
      this.removeAbortListener = undefined;
    } catch (error) {
      this.removeAbortListener?.();
      this.removeAbortListener = undefined;
      // Enrich OllamaStreamError with whatever content was accumulated
      // before the in-band error frame arrived — callers use this for
      // diagnostics ("what did the model say before it died?").
      const mapped =
        error instanceof OllamaStreamError && error.partialContent === ''
          ? new OllamaStreamError(error.message, {
              partialContent: extractPartialContent(accumulated),
              cause: error,
            })
          : mapError(error);
      this.emit({ type: 'error', data: { error: mapped } });
      this.rejectFinal(mapped);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<
    OllamaStreamEvent<TChunk, TFinal>,
    void,
    undefined
  > {
    if (this.mode === 'events') {
      throw new Error(
        'Cannot use async iteration: this stream already has event listeners registered via .on().',
      );
    }
    this.mode = 'iterator';
    let accumulated = this.initial;
    let completed = false;
    try {
      for await (const chunk of this.source) {
        accumulated = this.aggregate(accumulated, chunk);
        const events = this.mapChunk(chunk, accumulated);
        for (const event of events) {
          if (event.type === 'done') {
            completed = true;
            this.resolveFinal(event.data.result);
          }
          yield event;
        }
      }
    } catch (error) {
      // Enrich OllamaStreamError with whatever content was accumulated
      // before the in-band error frame arrived.
      const mapped =
        error instanceof OllamaStreamError && error.partialContent === ''
          ? new OllamaStreamError(error.message, {
              partialContent: extractPartialContent(accumulated),
              cause: error,
            })
          : mapError(error);
      this.rejectFinal(mapped);
      yield { type: 'error', data: { error: mapped } };
    } finally {
      this.removeAbortListener?.();
      this.removeAbortListener = undefined;
      if (!completed) {
        this.source.abort?.();
        this.rejectFinal(new OllamaAbortError('Ollama stream ended before completion'));
      }
    }
  }
}
