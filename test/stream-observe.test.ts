import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { observeStream } from '../src/streaming/observe.js';
import { OllamaClient } from '../src/client.js';
import {
  createMockOllamaServer,
  mockTextChunks,
  type OllamaMockServer,
} from '../src/testing/index.js';

/**
 * `observeStream` — the zero-copy multi-sink alternative to
 * `ReadableStream.tee()` (see src/streaming/observe.ts module docs and
 * ADR 0031). The contract under test is one-sided in favor of the PRIMARY
 * consumer: observers are passive, best-effort, ordered, and can never
 * block or fail the stream they observe.
 */

/** An async source that records whether its iterator-return (close) ran. */
function trackedSource<T>(chunks: T[]): {
  source: AsyncGenerator<T, void, undefined>;
  closed: () => boolean;
  pulled: () => number;
} {
  let closed = false;
  let pulled = 0;
  async function* generate(): AsyncGenerator<T, void, undefined> {
    try {
      for (const chunk of chunks) {
        pulled += 1;
        yield chunk;
      }
    } finally {
      closed = true;
    }
  }
  return { source: generate(), closed: () => closed, pulled: () => pulled };
}

/** Await enough ticks for the serialized observer chain to drain. */
async function settleObserverChain(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('observeStream: passthrough', () => {
  it('yields every chunk exactly once, in order, and nothing else', async () => {
    const input = [1, 2, 3, 4, 5];
    const out: number[] = [];
    for await (const chunk of observeStream(trackedSource(input).source, {})) {
      out.push(chunk);
    }
    expect(out).toEqual(input);
  });

  it('works with no callbacks at all (pure identity wrapper)', async () => {
    const out: string[] = [];
    for await (const chunk of observeStream(trackedSource(['a', 'b']).source)) {
      out.push(chunk);
    }
    expect(out).toEqual(['a', 'b']);
  });
});

describe('observeStream: observer isolation (the anti-poisoning guarantees)', () => {
  it('routes a sync onChunk throw to onListenerError and keeps streaming', async () => {
    const seen: number[] = [];
    const failures: Array<{ phase: string; message: string }> = [];
    const out: number[] = [];
    for await (const chunk of observeStream(trackedSource([1, 2, 3]).source, {
      onChunk: (c) => {
        if (c === 2) throw new Error('logger exploded');
        seen.push(c);
      },
      onListenerError: (error, phase) => {
        failures.push({ phase, message: (error as Error).message });
      },
    })) {
      out.push(chunk);
    }
    expect(out).toEqual([1, 2, 3]); // primary consumer unaffected
    expect(seen).toEqual([1, 3]); // observer saw the other chunks
    expect(failures).toEqual([{ phase: 'chunk', message: 'logger exploded' }]);
  });

  it('routes an async onChunk rejection to onListenerError with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const failures: Array<{ phase: string; message: string }> = [];
      const out: number[] = [];
      for await (const chunk of observeStream(trackedSource([1, 2]).source, {
        onChunk: async (c) => {
          await Promise.resolve();
          throw new Error(`sink ${c} failed`);
        },
        onListenerError: (error, phase) => {
          failures.push({ phase, message: (error as Error).message });
        },
      })) {
        out.push(chunk);
      }
      expect(out).toEqual([1, 2]);
      await settleObserverChain();
      expect(failures.map((f) => f.message).sort()).toEqual(['sink 1 failed', 'sink 2 failed']);
      expect(failures.every((f) => f.phase === 'chunk')).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('swallows a failing onListenerError itself (the reporter is never the next crash)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const out: number[] = [];
      for await (const chunk of observeStream(trackedSource([1]).source, {
        onChunk: () => {
          throw new Error('observer down');
        },
        onListenerError: () => {
          throw new Error('reporter down too');
        },
      })) {
        out.push(chunk);
      }
      expect(out).toEqual([1]);
      await settleObserverChain();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a throwing onError hook cannot mask the original source error', async () => {
    const failures: Array<{ phase: string; message: string }> = [];
    async function* failing(): AsyncGenerator<number, void, undefined> {
      yield 1;
      throw new Error('source died');
    }
    await expect(async () => {
      for await (const _chunk of observeStream(failing(), {
        onError: () => {
          throw new Error('error-hook exploded');
        },
        onListenerError: (error, phase) => {
          failures.push({ phase, message: (error as Error).message });
        },
      })) {
        // drain
      }
    }).rejects.toThrow('source died');
    expect(failures).toEqual([{ phase: 'error', message: 'error-hook exploded' }]);
  });

  it('a throwing onAbandon hook is reported and the early break still completes', async () => {
    const failures: Array<{ phase: string; message: string }> = [];
    const { source } = trackedSource([1, 2, 3]);
    for await (const chunk of observeStream(source, {
      onAbandon: () => {
        throw new Error('abandon-hook exploded');
      },
      onListenerError: (error, phase) => {
        failures.push({ phase, message: (error as Error).message });
      },
    })) {
      if (chunk === 2) break;
    }
    expect(failures).toEqual([{ phase: 'abandoned', message: 'abandon-hook exploded' }]);
  });
});

describe('observeStream: async sink discipline (the anti-tee() guarantees)', () => {
  it('runs async observers strictly FIFO with concurrency of exactly one', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const out: number[] = [];
    for await (const chunk of observeStream(trackedSource([1, 2, 3]).source, {
      onChunk: async (c) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${c}`);
        await gates[c - 1].promise;
        active -= 1;
        events.push(`end:${c}`);
      },
    })) {
      out.push(chunk);
    }
    expect(out).toEqual([1, 2, 3]);
    // Resolve in REVERSE order: chunk 2's gate opening before chunk 1 has
    // finished must NOT let chunk 2's observer start out of order.
    gates[2].resolve();
    gates[1].resolve();
    gates[0].resolve();
    await settleObserverChain();
    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
    expect(maxActive).toBe(1);
  });

  it('never delays the primary consumer behind a stalled async sink', async () => {
    const gate = deferred();
    const out: number[] = [];
    for await (const chunk of observeStream(trackedSource([1, 2, 3]).source, {
      onChunk: async () => {
        await gate.promise; // never resolves until we say so
      },
    })) {
      out.push(chunk);
    }
    // The consumer finished the whole stream while the very first observer
    // callback was still pending — the exact behavior tee() cannot provide.
    expect(out).toEqual([1, 2, 3]);
    gate.resolve();
    await settleObserverChain();
  });

  it('enqueues onDone only after the last chunk observer settles', async () => {
    const gate = deferred();
    const events: string[] = [];
    for await (const _chunk of observeStream(trackedSource([1, 2]).source, {
      onChunk: async (c) => {
        if (c === 2) {
          await gate.promise;
        }
      },
      onDone: () => {
        events.push('done');
      },
    })) {
      // drain
    }
    await settleObserverChain(2);
    expect(events).toEqual([]); // done is held behind chunk 2's sink
    gate.resolve();
    await settleObserverChain();
    expect(events).toEqual(['done']);
  });
});

describe('observeStream: lifecycle', () => {
  it('fires onDone exactly once on natural completion; onAbandon stays silent', async () => {
    let doneCount = 0;
    let abandoned = false;
    for await (const _chunk of observeStream(trackedSource([1, 2]).source, {
      onDone: () => {
        doneCount += 1;
      },
      onAbandon: () => {
        abandoned = true;
      },
    })) {
      // drain
    }
    await settleObserverChain();
    expect(doneCount).toBe(1);
    expect(abandoned).toBe(false);
  });

  it('fires onError and rethrows the source error to the primary consumer', async () => {
    const caught: unknown[] = [];
    async function* failing(): AsyncGenerator<number, void, undefined> {
      yield 1;
      throw new Error('wire cut');
    }
    await expect(async () => {
      for await (const _chunk of observeStream(failing(), {
        onError: (error) => {
          caught.push(error);
        },
      })) {
        // drain
      }
    }).rejects.toThrow('wire cut');
    expect(caught).toHaveLength(1);
    expect((caught[0] as Error).message).toBe('wire cut');
  });

  it('fires onAbandon (not onDone) when the consumer breaks early, after the source closed', async () => {
    const { source, closed } = trackedSource([1, 2, 3]);
    let abandonedAtSourceClosed = false;
    let doneFired = false;
    for await (const chunk of observeStream(source, {
      onAbandon: () => {
        abandonedAtSourceClosed = closed();
      },
      onDone: () => {
        doneFired = true;
      },
    })) {
      if (chunk === 2) break;
    }
    expect(abandonedAtSourceClosed).toBe(true); // iterator-return already closed the source
    expect(doneFired).toBe(false);
  });

  it('sees every chunk in order through a sync observer', async () => {
    const seen: string[] = [];
    for await (const _chunk of observeStream(trackedSource(['x', 'y', 'z']).source, {
      onChunk: (c) => {
        seen.push(c);
      },
    })) {
      // drain
    }
    await settleObserverChain();
    expect(seen).toEqual(['x', 'y', 'z']);
  });
});

describe('observeStream: over the SDK streaming surface', () => {
  let server: OllamaMockServer;

  beforeEach(() => {
    server = createMockOllamaServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('taps a streaming client.chat() — token counting + audit log while the consumer renders', async () => {
    server.register('/api/chat', {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
      chunks: mockTextChunks('Hello observed world', { chunkSize: 5 }),
    });
    await server.start();
    const client = new OllamaClient({ baseUrl: server.baseUrl });

    const stream = await client.chat({
      model: 'llama4',
      messages: [{ role: 'user', content: 'say hi' }],
      stream: true,
    });

    const auditLog: string[] = [];
    let observedTokens = 0;
    let auditDone = false;
    let consumerTokens = 0;
    const rendered: string[] = [];

    for await (const event of observeStream(stream, {
      onChunk: (event) => {
        if (event.type === 'token') {
          observedTokens += 1;
          auditLog.push(event.data.delta);
        }
      },
      onDone: () => {
        auditDone = true;
      },
    })) {
      if (event.type === 'token') {
        consumerTokens += 1;
        rendered.push(event.data.delta);
      }
    }
    await settleObserverChain();

    // Both sides saw the same token stream — one pass, zero forking.
    expect(observedTokens).toBe(consumerTokens);
    expect(observedTokens).toBeGreaterThan(0);
    expect(auditLog.join('')).toBe('Hello observed world');
    expect(rendered.join('')).toBe('Hello observed world');
    expect(auditDone).toBe(true);
    // The request was sent exactly once — no duplicated dispatch.
    expect(server.requests.filter((r) => r.path === '/api/chat')).toHaveLength(1);
  });
});
