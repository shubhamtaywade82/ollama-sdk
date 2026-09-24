/**
 * Dual-mode (AsyncIterator and EventEmitter-like) stream wrapper.
 */

import { mapError, OllamaAbortError, type OllamaClientError } from '../errors.js';
import type { AbortableAsyncIterable, OllamaStreamEvent, OllamaStreamEventType } from './types.js';

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
      if (signal.aborted) {
        this.abort();
      } else {
        signal.addEventListener('abort', () => this.abort(), { once: true });
      }
    }
  }

  get finalResult(): Promise<TFinal> {
    return this.finalResultPromise;
  }

  abort(): void {
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
    } catch (error) {
      const mapped = mapError(error);
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
      const mapped = mapError(error);
      this.rejectFinal(mapped);
      yield { type: 'error', data: { error: mapped } };
    } finally {
      if (!completed) {
        this.source.abort?.();
        this.rejectFinal(new OllamaAbortError('Ollama stream ended before completion'));
      }
    }
  }
}
