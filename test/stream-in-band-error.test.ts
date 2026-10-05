import { describe, expect, it } from 'vitest';
import { parseNdjsonStream } from '../src/streaming/ndjson.js';
import { normalizeChatStream, normalizeGenerateStream } from '../src/streaming/normalize.js';
import {
  OllamaClientError,
  OllamaServerError,
  OllamaStreamError,
} from '../src/errors.js';
import type { ChatResponse, GenerateResponse } from '../src/types.js';

/**
 * In-band stream-error trapping — see `src/streaming/ndjson.ts`.
 *
 * Ollama's streaming endpoints (chat / generate / pull / push / create)
 * start with HTTP 200 OK and use chunked transfer encoding. If an error
 * occurs mid-generation (GPU OOM, driver crash, context window overflow,
 * model unload race), the server emits a final JSON chunk of the form
 * `{"error": "..."}` and closes the stream.
 *
 * The HTTP status code never changes from 200, so HTTP-status-based
 * error detection misses these errors entirely — they would silently
 * bleed into the assistant's content stream as garbage tokens or
 * undefined-field accesses.
 *
 * The parser detects `{"error": "..."}` frames and throws
 * {@link OllamaStreamError} immediately.
 */

/** Build a ReadableStream emitting the given NDJSON chunks in order. */
function ndjsonStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Build an AbortableAsyncIterable wrapper around parseNdjsonStream output. */
async function* collect<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  yield* parseNdjsonStream<T>(stream);
}

describe('parseNdjsonStream: in-band error frame trapping', () => {
  it('throws OllamaStreamError on a bare {"error":"..."} frame mid-stream', async () => {
    const stream = ndjsonStream([
      '{"model":"llama3","created_at":"t","message":{"role":"assistant","content":"hi"},"done":false}\n',
      '{"error":"CUDA out of memory"}\n',
    ]);

    const generator = collect<ChatResponse>(stream);
    const first = await generator.next();
    expect(first.value).toMatchObject({ model: 'llama3' });

    let caught: unknown;
    try {
      await generator.next();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OllamaStreamError);
    expect((caught as OllamaStreamError).message).toBe('CUDA out of memory');
  });

  it('throws OllamaStreamError immediately if the FIRST frame is an error', async () => {
    const stream = ndjsonStream(['{"error":"model not found"}\n']);

    await expect(collect<ChatResponse>(stream).next()).rejects.toBeInstanceOf(
      OllamaStreamError,
    );
  });

  it('throws OllamaStreamError if the error frame is in the trailing buffer (no trailing newline)', async () => {
    // The final line has no trailing \n — it lives in the parser's
    // buffer until the stream closes. This covers the trailing-buffer
    // code path in parseNdjsonStream.
    const stream = ndjsonStream([
      '{"model":"llama3","created_at":"t","message":{"role":"assistant","content":"hi"},"done":false}\n',
      '{"error":"context window exceeded"}',
    ]);

    const generator = collect<ChatResponse>(stream);
    await generator.next(); // consume the first chunk
    await expect(generator.next()).rejects.toMatchObject({
      name: 'OllamaStreamError',
      message: 'context window exceeded',
    });
  });

  it('does NOT treat valid chat chunks with no error field as in-band errors', async () => {
    const stream = ndjsonStream([
      '{"model":"llama3","created_at":"t","message":{"role":"assistant","content":"hello"},"done":false}\n',
      '{"model":"llama3","created_at":"t","message":{"role":"assistant","content":" world"},"done":true,"done_reason":"stop","eval_count":2}\n',
    ]);

    const chunks: ChatResponse[] = [];
    for await (const c of parseNdjsonStream<ChatResponse>(stream)) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.message.content).toBe('hello');
    expect(chunks[1]?.message.content).toBe(' world');
    expect(chunks[1]?.done).toBe(true);
  });

  it('does NOT treat valid generate chunks as in-band errors', async () => {
    const stream = ndjsonStream([
      '{"model":"llama3","created_at":"t","response":"hello","done":false}\n',
      '{"model":"llama3","created_at":"t","response":" world","done":true,"done_reason":"stop","eval_count":2}\n',
    ]);

    const chunks: GenerateResponse[] = [];
    for await (const c of parseNdjsonStream<GenerateResponse>(stream)) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.response).toBe('hello');
    expect(chunks[1]?.response).toBe(' world');
  });

  it('does NOT treat progress chunks (status field) as in-band errors', async () => {
    const stream = ndjsonStream([
      '{"status":"pulling manifest"}\n',
      '{"status":"downloading","digest":"sha256:abc","total":100,"completed":50}\n',
      '{"status":"success"}\n',
    ]);

    const chunks: Array<{ status: string; digest?: string; total?: number; completed?: number }> =
      [];
    for await (const c of parseNdjsonStream(stream)) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(3);
    expect(chunks[1]?.completed).toBe(50);
  });

  it('the thrown OllamaStreamError carries code="stream_error" and retryable=false', async () => {
    const stream = ndjsonStream(['{"error":"driver crash"}\n']);

    try {
      await collect<ChatResponse>(stream).next();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaStreamError);
      const e = err as OllamaStreamError;
      expect(e.code).toBe('stream_error');
      expect(e.retryable).toBe(false);
      // Also extends OllamaServerError? No — stream errors are their own
      // class. Verify the inheritance chain.
      expect(e).not.toBeInstanceOf(OllamaServerError);
      expect(e).toBeInstanceOf(OllamaClientError);
    }
  });
});

describe('parseNdjsonStream: defensive rejection of frames that LOOK like errors but are not', () => {
  it('does NOT treat a chunk with model+error fields as an in-band error frame', async () => {
    // Defensive: the parser only treats a frame as in-band error when it
    // has a non-empty string `error` field AND none of the valid-chunk
    // markers (model, response, message, status, done). A frame that
    // carries both `error` and `model` would pass through unchanged
    // (callers can branch on the error field if they want).
    const stream = ndjsonStream([
      '{"model":"llama3","error":"warning: low context"}\n',
    ]);

    const chunks: Array<{ model?: string; error?: string }> = [];
    for await (const c of parseNdjsonStream(stream)) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.model).toBe('llama3');
    expect(chunks[0]?.error).toBe('warning: low context');
  });

  it('does NOT treat a chunk with empty-string error as an in-band error frame', async () => {
    const stream = ndjsonStream(['{"error":""}\n']);

    const chunks: Array<{ error?: string }> = [];
    for await (const c of parseNdjsonStream(stream)) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.error).toBe('');
  });
});

describe('OllamaStream: partialContent enrichment', () => {
  it('chat stream surfaces partial content via OllamaStreamError.partialContent', async () => {
    // Two valid content chunks, then an in-band error frame.
    const stream = ndjsonStream([
      '{"model":"llama3","created_at":"t","message":{"role":"assistant","content":"hello "},"done":false}\n',
      '{"model":"llama3","created_at":"t","message":{"role":"assistant","content":"wor"},"done":false}\n',
      '{"error":"context window exceeded"}\n',
    ]);

    const wrapped = normalizeChatStream(
      { [Symbol.asyncIterator]: () => parseNdjsonStream<ChatResponse>(stream)[Symbol.asyncIterator]() },
      undefined,
    );
    const finalResult = wrapped.finalResult;

    // Drain the iterator — it yields an `{ type: 'error', ... }` event
    // (not a throw) when the in-band error frame arrives, then completes.
    const events: Array<{ type: string; delta?: string }> = [];
    for await (const event of wrapped) {
      if (event.type === 'token') {
        events.push({ type: 'token', delta: event.data.delta });
      }
      if (event.type === 'error') {
        events.push({ type: 'error' });
      }
    }
    // Both content tokens were emitted before the error frame.
    expect(events).toEqual([
      { type: 'token', delta: 'hello ' },
      { type: 'token', delta: 'wor' },
      { type: 'error' },
    ]);

    // The finalResult promise rejects with the enriched OllamaStreamError.
    await expect(finalResult).rejects.toBeInstanceOf(OllamaStreamError);
    try {
      await finalResult;
    } catch (err) {
      const e = err as OllamaStreamError;
      expect(e.partialContent).toBe('hello wor');
      expect(e.message).toBe('context window exceeded');
    }
  });

  it('generate stream surfaces partial content via OllamaStreamError.partialContent', async () => {
    const stream = ndjsonStream([
      '{"model":"llama3","created_at":"t","response":"foo ","done":false}\n',
      '{"model":"llama3","created_at":"t","response":"bar","done":false}\n',
      '{"error":"GPU OOM"}\n',
    ]);

    const wrapped = normalizeGenerateStream(
      { [Symbol.asyncIterator]: () => parseNdjsonStream<GenerateResponse>(stream)[Symbol.asyncIterator]() },
      undefined,
    );
    const finalResult = wrapped.finalResult;

    // Drain — the iterator yields the tokens then an error event.
    for await (const _event of wrapped) {
      // drain
    }

    await expect(finalResult).rejects.toBeInstanceOf(OllamaStreamError);
    try {
      await finalResult;
    } catch (err) {
      const e = err as OllamaStreamError;
      expect(e.partialContent).toBe('foo bar');
      expect(e.message).toBe('GPU OOM');
    }
  });

  it('partialContent is empty string when no content chunks were emitted before the error', async () => {
    const stream = ndjsonStream(['{"error":"model not found"}\n']);

    const wrapped = normalizeChatStream(
      { [Symbol.asyncIterator]: () => parseNdjsonStream<ChatResponse>(stream)[Symbol.asyncIterator]() },
      undefined,
    );
    const finalResult = wrapped.finalResult;

    for await (const _event of wrapped) {
      // drain
    }

    await expect(finalResult).rejects.toBeInstanceOf(OllamaStreamError);
    try {
      await finalResult;
    } catch (err) {
      const e = err as OllamaStreamError;
      expect(e.partialContent).toBe('');
    }
  });
});
