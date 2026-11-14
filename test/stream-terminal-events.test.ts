import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { OllamaAbortError, OllamaStreamError } from '../src/errors.js';

/**
 * Terminal-event contract for the OpenAI and Anthropic compatibility streams.
 *
 * A stream that ends at an event boundary without its terminal signal (`[DONE]`
 * for OpenAI Chat and Completions, `message_stop` for Anthropic) was truncated.
 * Before this contract the adapters resolved `finalResult` with whatever had
 * accumulated, so a cut-off response looked complete. These tests pin the
 * rejection, and that a caller abort still reports as an abort.
 */

function sseBody(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
}

function sseFetchMock(events: string[]) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, body: sseBody(events) });
}

/**
 * Emits `events`, then stays open until the transport aborts. The body closes
 * cleanly on abort, so the parser sees an ordinary EOF; only the adapter's own
 * abort state tells that apart from truncation.
 */
function abortableFetchMock(events: string[]) {
  return vi.fn().mockImplementation(async (_url: string, init: { signal?: AbortSignal }) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        init.signal?.addEventListener('abort', () => controller.close(), { once: true });
      },
    });
    return { ok: true, status: 200, body };
  });
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<{ items: T[]; error: unknown }> {
  const items: T[] = [];
  try {
    for await (const item of iterable) items.push(item);
    return { items, error: undefined };
  } catch (error) {
    return { items, error };
  }
}

const chatChunk = (content: string, finishReason: string | null = null): string =>
  `data: ${JSON.stringify({
    id: 'chat-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'qwen3',
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: finishReason,
      },
    ],
    usage: null,
  })}\n\n`;

const completionChunk = (text: string, finishReason: string | null = null): string =>
  `data: ${JSON.stringify({
    id: 'cmpl-1',
    object: 'text_completion',
    created: 1,
    model: 'qwen3',
    choices: [{ index: 0, text, finish_reason: finishReason }],
  })}\n\n`;

describe('OpenAI Chat: [DONE] is required', () => {
  it('rejects the final result when the stream ends at an event boundary without [DONE]', async () => {
    const client = new OllamaClient({
      fetch: sseFetchMock([chatChunk('Hel'), chatChunk('lo', 'stop')]) as never,
    });
    const stream = await client.openai.chatCompletions({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    const { items, error } = await drain(stream);

    expect(items).toHaveLength(2);
    expect(error).toBeInstanceOf(OllamaStreamError);
    expect(error).toMatchObject({ message: expect.stringContaining('[DONE]') });
    await expect(stream.finalResult).rejects.toBeInstanceOf(OllamaStreamError);
  });

  it('resolves when [DONE] terminates the stream', async () => {
    const client = new OllamaClient({
      fetch: sseFetchMock([chatChunk('Hel'), chatChunk('lo', 'stop'), 'data: [DONE]\n\n']) as never,
    });
    const stream = await client.openai.chatCompletions({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    await drain(stream);
    const final = await stream.finalResult;
    expect(final.choices[0]?.message.content).toBe('Hello');
  });
});

describe('OpenAI Completions: [DONE] is required', () => {
  it('rejects the final result when the stream ends at an event boundary without [DONE]', async () => {
    const client = new OllamaClient({
      fetch: sseFetchMock([completionChunk('Hel'), completionChunk('lo', 'stop')]) as never,
    });
    const stream = await client.openai.completions({ model: 'qwen3', prompt: 'hi', stream: true });

    const { items, error } = await drain(stream);

    expect(items).toHaveLength(2);
    expect(error).toBeInstanceOf(OllamaStreamError);
    await expect(stream.finalResult).rejects.toBeInstanceOf(OllamaStreamError);
  });
});

describe('Anthropic Messages: message_stop is required', () => {
  it('rejects the final result when the stream ends after content but before message_stop', async () => {
    const client = new OllamaClient({
      fetch: sseFetchMock([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"qwen3","content":[],"stop_reason":null,"usage":{"input_tokens":4,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      ]),
    });
    const stream = await client.anthropic.messages({
      model: 'qwen3',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });

    const { error } = await drain(stream);

    expect(error).toBeInstanceOf(OllamaStreamError);
    expect(error).toMatchObject({ message: expect.stringContaining('message_stop') });
    await expect(stream.finalResult).rejects.toBeInstanceOf(OllamaStreamError);
  });
});

describe('OpenAI Responses: terminal completion is required', () => {
  it('rejects a clean EOF after response.created when no terminal event arrives', async () => {
    const created = {
      type: 'response.created',
      response: {
        id: 'resp_truncated',
        object: 'response',
        created: 7,
        model: 'qwen3',
        status: 'in_progress',
        output: [],
      },
    };
    const delta = {
      type: 'response.output_text.delta',
      item_id: 'msg_truncated',
      output_index: 0,
      content_index: 0,
      delta: 'partial',
    };
    const client = new OllamaClient({
      fetch: sseFetchMock([
        `event: response.created\ndata: ${JSON.stringify(created)}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify(delta)}\n\n`,
      ]) as never,
    });
    const stream = await client.openai.responses({
      model: 'qwen3',
      input: 'hi',
      stream: true,
    });

    const { items, error } = await drain(stream);

    expect(items).toHaveLength(2);
    expect(error).toBeInstanceOf(OllamaStreamError);
    expect(error).toMatchObject({ message: expect.stringContaining('response.completed') });
    await expect(stream.finalResult).rejects.toBeInstanceOf(OllamaStreamError);
  });
});

describe('caller abort is not reported as truncation', () => {
  it('OpenAI Chat: an aborted stream whose body closes cleanly rejects with OllamaAbortError', async () => {
    const client = new OllamaClient({
      fetch: abortableFetchMock([chatChunk('Hel')]) as never,
    });
    const controller = new AbortController();
    const stream = await client.openai.chatCompletions(
      { model: 'qwen3', messages: [{ role: 'user', content: 'hi' }], stream: true },
      controller.signal,
    );

    const consumed = drain(stream);
    controller.abort();
    const { error } = await consumed;

    expect(error).toBeInstanceOf(OllamaAbortError);
    expect(error).not.toBeInstanceOf(OllamaStreamError);
    await expect(stream.finalResult).rejects.toBeInstanceOf(OllamaAbortError);
  });

  it('Anthropic: an aborted stream whose body closes cleanly rejects with OllamaAbortError', async () => {
    const client = new OllamaClient({
      fetch: abortableFetchMock([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"qwen3","content":[],"stop_reason":null,"usage":{"input_tokens":4,"output_tokens":0}}}\n\n',
      ]) as never,
    });
    const controller = new AbortController();
    const stream = await client.anthropic.messages(
      {
        model: 'qwen3',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      },
      controller.signal,
    );

    const consumed = drain(stream);
    controller.abort();
    const { error } = await consumed;

    expect(error).toBeInstanceOf(OllamaAbortError);
    expect(error).not.toBeInstanceOf(OllamaStreamError);
    await expect(stream.finalResult).rejects.toBeInstanceOf(OllamaAbortError);
  });
});
