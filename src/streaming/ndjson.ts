/**
 * NDJSON (newline-delimited JSON) stream reader for native fetch Response bodies.
 *
 * Ollama's streaming endpoints (chat / generate / pull / push / create)
 * emit newline-delimited JSON objects. Each line is a complete JSON
 * document. The transport is chunked HTTP with status 200 OK — meaning
 * the HTTP status never changes mid-stream even when the server
 * encounters an error after generation has started.
 *
 * Instead, Ollama emits a final JSON frame of the form
 * `{"error": "..."}` and closes the stream. This reader detects such
 * in-band error frames and throws {@link OllamaStreamError} immediately,
 * so callers don't see the error message bleed into the assistant's
 * content stream as garbage tokens.
 */

import { OllamaGenericClientError, OllamaStreamError } from '../errors.js';
import { disposableReader } from '../utils.js';

/**
 * A frame carrying an in-band stream error. Ollama emits this shape as
 * the final chunk of a stream when generation fails mid-flight (GPU
 * OOM, driver crash, context window overflow, model unload race, etc).
 *
 * Note that not every chunk with an `error` field is an error frame —
 * some valid Ollama response shapes carry `error` as a property name
 * for unrelated purposes (none documented in the public API, but the
 * generated schema set has a few). We only treat a frame as an
 * in-band error when it has an `error` field that is a non-empty
 * string AND no other top-level fields that would identify it as a
 * valid response chunk (e.g. `model`, `response`, `message`, `status`,
 * `done`).
 */
interface InBandErrorFrame {
  readonly error: string;
}

/**
 * Returns `true` if `value` looks like an Ollama in-band stream error
 * frame — i.e. it has a non-empty string `error` field and none of
 * the markers that would identify it as a valid response chunk.
 *
 * The valid-chunk markers (`model`, `response`, `message`, `status`,
 * `done`) cover every documented Ollama streaming endpoint: chat
 * chunks carry `message` and `done`; generate chunks carry `response`
 * and `done`; pull/push/create chunks carry `status`; all chunks
 * carry `model` once the model has loaded. A bare `{"error": "..."}`
 * frame with none of these is unambiguously an in-band error.
 */
function isInBandErrorFrame(value: unknown): value is InBandErrorFrame {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.error !== 'string' || record.error.length === 0) return false;
  // Reject frames that look like valid response chunks which happen to
  // also carry an `error` field (none documented, but defensive).
  return (
    !('model' in record) &&
    !('response' in record) &&
    !('message' in record) &&
    !('status' in record) &&
    !('done' in record)
  );
}

/**
 * Parses a byte stream from fetch body into an async generator of typed JSON chunks.
 *
 * Throws {@link OllamaStreamError} immediately upon encountering an
 * in-band `{"error": "..."}` frame. The thrown error carries an empty
 * `partialContent` (this low-level parser does not accumulate content;
 * the higher-level aggregator in `streaming/normalize.ts` is the
 * right place to surface partial content if needed).
 */
export async function* parseNdjsonStream<T>(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<T, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  await using _reader = disposableReader(reader);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // Keep the last partial line in buffer
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let json: unknown;
      try {
        json = JSON.parse(trimmed);
      } catch (err) {
        throw new OllamaGenericClientError(`Failed to parse stream JSON chunk: ${trimmed}`, {
          cause: err,
        });
      }

      // In-band error trapping: detect `{"error": "..."}` frames
      // before they reach the typed-chunk consumer. This is the
      // critical fix for the "HTTP 200 OK + mid-stream error" case
      // documented in Ollama's errors.md — without it, the error
      // message would either bleed into content or hit undefined-field
      // accesses downstream.
      if (isInBandErrorFrame(json)) {
        throw new OllamaStreamError((json as InBandErrorFrame).error);
      }

      yield json as T;
    }
  }

  if (buffer.trim()) {
    const trimmed = buffer.trim();
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch (err) {
      throw new OllamaGenericClientError(`Failed to parse stream JSON chunk: ${trimmed}`, {
        cause: err,
      });
    }
    if (isInBandErrorFrame(json)) {
      throw new OllamaStreamError((json as InBandErrorFrame).error);
    }
    yield json as T;
  }
  // reader.cancel() + reader.releaseLock() called automatically via `await using _reader`
}
