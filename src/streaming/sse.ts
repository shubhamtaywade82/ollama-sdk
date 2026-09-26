/**
 * Server-Sent Events parser for OpenAI-compatible streaming endpoints.
 *
 * Supports multiline data fields and terminates on the OpenAI [DONE] sentinel.
 */
import { OllamaGenericClientError } from '../errors.js';

export async function* parseSseStream<T>(
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
      const events = buffer.split(/?
?
/);
      buffer = events.pop() ?? '';

      for (const event of events) {
        const data = event
          .split(/?
/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');

        if (!data || data === '[DONE]') {
          if (data === '[DONE]') return;
          continue;
        }

        try {
          yield JSON.parse(data) as T;
        } catch (err) {
          throw new OllamaGenericClientError(`Failed to parse SSE JSON chunk: ${data}`, {
            cause: err,
          });
        }
      }
    }

    if (buffer.trim()) {
      const data = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data && data !== '[DONE]') {
        try {
          yield JSON.parse(data) as T;
        } catch (err) {
          throw new OllamaGenericClientError(`Failed to parse SSE JSON chunk: ${data}`, {
            cause: err,
          });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
