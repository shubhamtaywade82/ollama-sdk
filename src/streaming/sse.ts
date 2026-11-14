/**
 * Server-Sent Events (SSE) parser for OpenAI/Anthropic-compatible streaming endpoints.
 *
 * Implements standard event-stream field rules without coupling the parser to
 * any provider-specific event schema.
 */

import { OllamaStreamError } from '../errors.js';
import { disposableReader } from '../utils.js';

export interface SseEvent {
  /** Event type; omitted when the server emitted no explicit event field. */
  readonly event?: string | undefined;
  /** Event data with consecutive data fields joined by a newline. */
  readonly data: string;
  /** Last event id associated with this dispatch, when present. */
  readonly id?: string | undefined;
  /** Reconnection delay requested by the server, in milliseconds, when valid. */
  readonly retry?: number | undefined;
}

function dispatch(
  event: string | undefined,
  data: string[],
  id: string | undefined,
  retry: number | undefined,
): SseEvent | undefined {
  if (data.length === 0) return undefined;

  // WHATWG Server-Sent Events § dispatch: every `data` field appends its value
  // plus one LF to the data buffer, and dispatch removes exactly one trailing
  // LF. Building the buffer explicitly (value + LF per field) and stripping the
  // single final LF keeps a trailing LF that belongs to the data itself — e.g.
  // `data: first` followed by an empty `data: ` dispatches `first\n`, not
  // `first`.
  const buffer = data.map((line) => `${line}\n`).join('');
  return {
    ...(event !== undefined ? { event } : {}),
    data: buffer.slice(0, -1),
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}

/**
 * Parses an SSE byte stream into discrete events, per the WHATWG "event stream
 * interpretation" (https://html.spec.whatwg.org/multipage/server-sent-events.html).
 *
 * Supports CRLF, CR, and LF line endings; comments; repeated data fields;
 * event/id/retry fields; and UTF-8 chunks split across arbitrary byte boundaries.
 *
 * End-of-stream is strict. An event is dispatched only by its blank-line
 * terminator, so a final event whose terminator never arrived is discarded, as
 * the spec requires. The discard is then reported by throwing
 * {@link OllamaStreamError}: a stream that ends mid-event was truncated, and a
 * silent discard would let a truncated response look complete.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let eventType: string | undefined;
  let data: string[] = [];
  let lastEventId: string | undefined;
  let retry: number | undefined;

  const processLine = (line: string): SseEvent | undefined => {
    if (line.length === 0) {
      const event = dispatch(eventType, data, lastEventId, retry);
      eventType = undefined;
      data = [];
      retry = undefined;
      return event;
    }

    if (line.startsWith(':')) return undefined;

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        eventType = value;
        break;
      case 'data':
        data.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) lastEventId = value;
        break;
      case 'retry': {
        if (/^\d+$/.test(value)) {
          const parsed = Number(value);
          if (Number.isSafeInteger(parsed)) retry = parsed;
        }
        break;
      }
      default:
        break;
    }

    return undefined;
  };

  /**
   * Consumes every complete line in `buffer`, yielding dispatched events. A CR
   * at the very end of the buffer is held back until the next chunk shows
   * whether it begins a CRLF pair. At end of stream there is no next chunk, so
   * that CR is a complete line terminator and is consumed.
   */
  function* drainLines(endOfStream: boolean): Generator<SseEvent, void, undefined> {
    while (true) {
      const lf = buffer.indexOf('\n');
      const cr = buffer.indexOf('\r');
      if (lf === -1 && cr === -1) return;
      if (!endOfStream && lf === -1 && cr === buffer.length - 1) return;

      const lineEnd = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
      const separatorLength = buffer[lineEnd] === '\r' && buffer[lineEnd + 1] === '\n' ? 2 : 1;

      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + separatorLength);

      const event = processLine(line);
      if (event) yield event;
    }
  }

  await using _reader = disposableReader(reader);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    yield* drainLines(false);
  }

  buffer += decoder.decode();
  yield* drainLines(true);

  // Anything still pending is an incomplete event: its data lines were never
  // terminated by a blank line, or its final line was cut off mid-way. Reaching
  // here means the stream ended with it, so it is discarded and reported.
  if (data.length > 0 || buffer.length > 0) {
    throw new OllamaStreamError('SSE stream ended mid-event; the incomplete event was discarded');
  }
  // reader.cancel() + reader.releaseLock() called automatically via `await using _reader`
}
