import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/transport/http.js';
import { parseSseStream } from '../src/streaming/sse.js';

function byteStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index] ?? ''));
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

describe('SSE parser', () => {
  it('parses event, id, retry, comments, and repeated data fields', async () => {
    const stream = parseSseStream(
      byteStream(
        ': keep-alive\r\n',
        'id: 42\r\nevent: message\r\ndata: first\r\n',
        'data: second\r\nretry: 1500\r\n\r\n',
        'data: terminal',
      ),
    );

    const events = [];
    for await (const event of stream) events.push(event);

    expect(events).toEqual([
      {
        id: '42',
        event: 'message',
        data: 'first\nsecond',
        retry: 1500,
      },
      {
        id: '42',
        data: 'terminal',
      },
    ]);
  });

  it('handles LF and CR-only line endings and blank data fields', async () => {
    const stream = parseSseStream(
      byteStream('data: hello\n\ndata:\r\rdata: world\r\r'),
    );

    const events = [];
    for await (const event of stream) events.push(event);

    expect(events).toEqual([{ data: 'hello' }, { data: '' }, { data: 'world' }]);
  });

  it('ignores NUL-containing ids and malformed retry values', async () => {
    const stream = parseSseStream(
      byteStream('id: first\ndata: one\n\n', 'id: bad\0id\nretry: nope\ndata: two\n\n'),
    );

    const events = [];
    for await (const event of stream) events.push(event);

    expect(events).toEqual([{ id: 'first', data: 'one' }, { id: 'first', data: 'two' }]);
  });

  it('handles a UTF-8 code point split across byte chunks', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: café\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, bytes.length - 2));
        controller.enqueue(bytes.slice(bytes.length - 2));
        controller.close();
      },
    });

    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);

    expect(events).toEqual([{ data: 'café' }]);
  });
});

describe('HttpClient SSE transport', () => {
  it('requests text/event-stream and exposes parsed events', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: byteStream('event: message\ndata: {"delta":"hi"}\n\n'),
    });

    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: fetchMock as never,
    });

    const source = await http.requestSseStream({ path: '/v1/chat/completions' });
    const events = [];
    for await (const event of source) events.push(event);

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Accept).toBe('text/event-stream');
    expect(events).toEqual([{ event: 'message', data: '{"delta":"hi"}' }]);
  });
});
