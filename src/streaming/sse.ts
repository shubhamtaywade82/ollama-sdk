/**
 * Server-Sent Events (SSE) parser for OpenAI/Anthropic-compatible streaming endpoints.
 *
 * Implements standard event-stream field rules without coupling the parser to
 * any provider-specific event schema.
 */

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

  const joined = data.join('\n');
  return {
    ...(event !== undefined ? { event } : {}),
    data: joined.endsWith('\n') ? joined.slice(0, -1) : joined,
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}

/**
 * Parses an SSE byte stream into discrete events.
 *
 * Supports CRLF, CR, and LF line endings; comments; repeated data fields;
 * event/id/retry fields; UTF-8 chunks split across arbitrary byte boundaries;
 * and a terminal event without a trailing blank line.
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

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const lf = buffer.indexOf('\n');
        const cr = buffer.indexOf('\r');
        if (lf === -1 && cr === -1) break;
        // A CR may be the first half of a CRLF sequence split across two network chunks.
        if (cr !== -1 && lf === -1 && cr === buffer.length - 1) break;

        const lineEnd = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
        let separatorLength = 1;

        if (buffer[lineEnd] === '\r' && buffer[lineEnd + 1] === '\n') {
          separatorLength = 2;
        }

        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + separatorLength);

        const event = processLine(line);
        if (event) yield event;
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const event = processLine(buffer);
      if (event) yield event;
    }

    const terminal = dispatch(eventType, data, lastEventId, retry);
    if (terminal) yield terminal;
  } finally {
    reader.releaseLock();
  }
}
