/**
 * NDJSON (newline-delimited JSON) stream reader for native fetch Response bodies.
 */

import { OllamaGenericClientError } from '../errors.js';

/**
 * Parses a byte stream from fetch body into an async generator of typed JSON chunks.
 */
export async function* parseNdjsonStream<T>(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<T, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
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
        try {
          yield JSON.parse(trimmed) as T;
        } catch (err) {
          throw new OllamaGenericClientError(`Failed to parse stream JSON chunk: ${trimmed}`, {
            cause: err,
          });
        }
      }
    }

    if (buffer.trim()) {
      yield JSON.parse(buffer.trim()) as T;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or errored.
    }
    reader.releaseLock();
  }
}
