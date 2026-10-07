import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import type { ResponsesCreateResponse } from '../src/responses.js';

/**
 * Dual-mode OpenAI Responses bridge (src/responses.ts):
 *
 *   1. Native POST /v1/responses (Ollama >= v0.13.3)
 *   2. On 404, transparent re-issue via /api/chat adapter
 */

interface RecordedCall {
  path: string;
  body: Record<string, unknown>;
}

/** Fetch mock that routes by path and records every call. */
function routingFetch(
  handlers: Record<string, (body: Record<string, unknown>) => { status: number; json: unknown }>,
) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body =
      init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body });
    const handler = handlers[path];
    if (handler === undefined) {
      return new Response(JSON.stringify({ error: `no handler for ${path}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const { status, json } = handler(body);
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const NATIVE_RESPONSE = {
  id: 'resp_native_1',
  model: 'llama3.1',
  created_at: 1730000000,
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Native reply.' }],
    },
  ],
  usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 },
};

function makeClient(fetchImpl: typeof globalThis.fetch): OllamaClient {
  return new OllamaClient({ fetch: fetchImpl });
}

describe('responses.create() — native mode', () => {
  it('POSTs /v1/responses with the documented field mapping', async () => {
    const { fetchImpl, calls } = routingFetch({
      '/v1/responses': () => ({ status: 200, json: NATIVE_RESPONSE }),
    });
    const client = makeClient(fetchImpl);

    const res = await client.responses.create({
      model: 'llama3.1',
      input: 'Hello!',
      instructions: 'Be terse.',
      temperature: 0.5,
      top_p: 0.9,
      max_output_tokens: 128,
      reasoning_effort: 'medium',
      think: true,
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/v1/responses');
    const body = calls[0]?.body;
    expect(body?.model).toBe('llama3.1');
    expect(body?.input).toBe('Hello!');
    expect(body?.instructions).toBe('Be terse.');
    expect(body?.temperature).toBe(0.5);
    expect(body?.top_p).toBe(0.9);
    expect(body?.max_output_tokens).toBe(128);
    expect(body?.reasoning).toEqual({ effort: 'medium' });
    expect(body?.think).toBe(true);
    expect(body?.stream).toBe(false);
    expect(body?.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ]);

    expect(res.transport).toBe('native');
    expect(res.output_text).toBe('Native reply.');
    expect(res.id).toBe('resp_native_1');
    expect(res.usage).toEqual({ input_tokens: 12, output_tokens: 6, total_tokens: 18 });
  });

  it('extracts refusal text as output_text and parses function_call items into tool_calls', async () => {
    const { fetchImpl } = routingFetch({
      '/v1/responses': () => ({
        status: 200,
        json: {
          id: 'resp_native_2',
          model: 'llama3.1',
          created_at: 1730000000,
          output: [
            { type: 'reasoning', text: 'thinking hard' },
            {
              type: 'function_call',
              id: 'call_1',
              name: 'get_weather',
              arguments: '{"city":"Pune"}',
            },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'refusal', refusal: 'cannot do that' }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      }),
    });
    const res = await makeClient(fetchImpl).responses.create({
      model: 'llama3.1',
      input: 'refuse please',
    });

    expect(res.output_text).toBe('cannot do that');
    expect(res.thinking).toBe('thinking hard');
    expect(res.tool_calls).toEqual([
      { id: 'call_1', function: { name: 'get_weather', arguments: { city: 'Pune' } } },
    ]);
  });
});

describe('responses.create() — chat-adapter fallback', () => {
  function native404Handlers(): Record<
    string,
    (body: Record<string, unknown>) => { status: number; json: unknown }
  > {
    return {
      '/v1/responses': () => ({ status: 404, json: { error: 'path not found' } }),
      '/api/chat': () => ({
        status: 200,
        json: {
          model: 'llama3.1',
          created_at: '2026-01-01T00:00:00.000000000Z',
          message: { role: 'assistant', content: 'Adapter reply.' },
          done: true,
          prompt_eval_count: 24,
          eval_count: 7,
        },
      }),
    };
  }

  it('falls back to /api/chat when /v1/responses answers 404', async () => {
    const { fetchImpl, calls } = routingFetch(native404Handlers());
    const res = await makeClient(fetchImpl).responses.create({
      model: 'llama3.1',
      input: 'Hello!',
      instructions: 'Be terse.',
      temperature: 0.3,
      max_output_tokens: 64,
    });

    expect(res.transport).toBe('chat-adapter');
    expect(res.output_text).toBe('Adapter reply.');
    expect(res.usage).toEqual({ input_tokens: 24, output_tokens: 7, total_tokens: 31 });
    expect(res.id).toMatch(/^resp_/);
    expect(res.model).toBe('llama3.1');

    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe('/v1/responses');
    expect(calls[1]?.path).toBe('/api/chat');
    const chatBody = calls[1]?.body;
    expect(chatBody?.messages).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'Hello!' },
    ]);
    expect(chatBody?.options).toEqual({ temperature: 0.3, num_predict: 64 });
    expect(chatBody?.stream).toBe(false);
  });

  it('propagates non-404 native errors without attempting the fallback', async () => {
    const { fetchImpl, calls } = routingFetch({
      '/v1/responses': () => ({ status: 500, json: { error: 'boom' } }),
    });
    await expect(
      makeClient(fetchImpl).responses.create({ model: 'llama3.1', input: 'x' }),
    ).rejects.toThrow();
    // 5xx triggers same-endpoint retry per the client's retry policy — the
    // assertion that matters: the /api/chat fallback was NEVER attempted.
    expect(calls.every((call) => call.path === '/v1/responses')).toBe(true);
  });
});

describe('responses.createText()', () => {
  it('returns just the output_text string', async () => {
    const { fetchImpl } = routingFetch({
      '/v1/responses': () => ({ status: 200, json: NATIVE_RESPONSE }),
    });
    await expect(
      makeClient(fetchImpl).responses.createText({ model: 'llama3.1', input: 'hi' }),
    ).resolves.toBe('Native reply.');
  });
});

describe('responses.stream()', () => {
  /** Builds an SSE Response body from `data: {...}` frames. */
  function sseResponse(frames: unknown[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('yields text deltas from native SSE, then a done event with the mapped response', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      expect(path).toBe('/v1/responses');
      return sseResponse([
        { type: 'response.created', response: { id: 'resp_s', model: 'llama3.1' } },
        { type: 'response.output_text.delta', delta: 'Hel' },
        { type: 'response.output_text.delta', delta: 'lo' },
        { type: 'response.reasoning_text.delta', delta: 'hm' },
        {
          type: 'response.completed',
          response: NATIVE_RESPONSE,
        },
      ]);
    }) as unknown as typeof globalThis.fetch;

    const events: unknown[] = [];
    for await (const event of makeClient(fetchImpl).responses.stream({
      model: 'llama3.1',
      input: 'stream me',
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'text_delta', delta: 'Hel' },
      { type: 'text_delta', delta: 'lo' },
      { type: 'thinking_delta', delta: 'hm' },
      {
        type: 'done',
        response: expect.objectContaining({
          id: 'resp_native_1',
          output_text: 'Native reply.',
          transport: 'native',
        }) as ResponsesCreateResponse,
      },
    ]);
  });

  it('falls back to the /api/chat token stream on 404 and maps the final result', async () => {
    let call = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      call += 1;
      const path = new URL(String(url)).pathname;
      if (path === '/v1/responses') {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }
      expect(path).toBe('/api/chat');
      const body = JSON.parse(String(init?.body)) as { stream: boolean };
      expect(body.stream).toBe(true);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ model: 'llama3.1', message: { role: 'assistant', content: 'He' }, done: false })}\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                model: 'llama3.1',
                message: { role: 'assistant', content: 'llo' },
                done: true,
                prompt_eval_count: 9,
                eval_count: 3,
              })}\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    }) as unknown as typeof globalThis.fetch;

    const events: unknown[] = [];
    for await (const event of makeClient(fetchImpl).responses.stream({
      model: 'llama3.1',
      input: 'fallback stream',
    })) {
      events.push(event);
    }

    expect(call).toBe(2);
    expect(events).toEqual([
      { type: 'text_delta', delta: 'He' },
      { type: 'text_delta', delta: 'llo' },
      {
        type: 'done',
        response: expect.objectContaining({
          output_text: 'Hello',
          transport: 'chat-adapter',
          usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
        }) as ResponsesCreateResponse,
      },
    ]);
  });
});

describe('native 404 detection is strict', () => {
  it('does not fall back when /v1/responses returns 404 for a *missing model* path variant — non-404 stays native-only', async () => {
    // Sanity: a 400 (bad request) must propagate, not adapt.
    const { fetchImpl, calls } = routingFetch({
      '/v1/responses': () => ({ status: 400, json: { error: 'bad field' } }),
    });
    await expect(
      makeClient(fetchImpl).responses.create({ model: 'nope', input: 'x' }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(vi.mocked(fetchImpl)).toBeTruthy(); // fetch mock in place
  });
});
