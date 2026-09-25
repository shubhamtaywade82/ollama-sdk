import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';

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
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: sseBody(events),
  });
}

describe('OpenAI compatibility streaming', () => {
  it('aggregates chat text and fragmented tool calls and captures final usage', async () => {
    const fetchMock = sseFetchMock([
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"qwen3","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}],"usage":null}\n\n',
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"qwen3","choices":[{"index":0,"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}],"usage":null}\n\n',
      'data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"qwen3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \\"Bengaluru\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const client = new OllamaClient({ fetch: fetchMock as never });

    const stream = await client.openai.chatCompletions({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'weather?' }],
      stream: true,
      stream_options: { include_usage: true },
    });

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks).toHaveLength(3);
    const final = await stream.finalResult;
    expect(final.choices[0]?.message.content).toBe('Hello');
    expect(final.choices[0]?.message.tool_calls?.[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city": "Bengaluru"}' },
    });
    expect(final.choices[0]?.finish_reason).toBe('tool_calls');
    expect(final.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });
});

describe('OpenAI Responses compatibility streaming', () => {
  it('exposes typed response SSE events and preserves the completed response', async () => {
    const fetchMock = sseFetchMock([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hello"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","object":"response","created":1,"model":"qwen3","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}],"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n',
    ]);
    const client = new OllamaClient({ fetch: fetchMock as never });

    const stream = await client.openai.responses({
      model: 'qwen3',
      input: 'Hi',
      stream: true,
    });

    const events = [];
    for await (const event of stream) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      'response.output_text.delta',
      'response.completed',
    ]);
    expect((events[0] as { delta: string }).delta).toBe('Hello');
    expect((await stream.finalResult).usage?.total_tokens).toBe(3);
  });

  it('reconstructs output items when the terminal response payload is omitted', async () => {
    const fetchMock = sseFetchMock([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_2","object":"response","created":2,"model":"qwen3","output":[]}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_2","output_index":0,"content_index":0,"delta":"Hello"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_2","output_index":0,"content_index":0,"delta":" world"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"call_2","output_index":1,"delta":"{\\"city\\":"}\n\n',
      'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"call_2","output_index":1,"name":"get_weather","arguments":"{\\"city\\":\\"Bengaluru\\"}"}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","item_id":"reason_2","output_index":2,"summary_index":0,"delta":"checked"}\n\n',
      'data: [DONE]\n\n',
    ]);
    const client = new OllamaClient({ fetch: fetchMock as never });

    const stream = await client.openai.responses({
      model: 'qwen3',
      input: 'Hi',
      stream: true,
    });

    for await (const _ of stream) {
      // drain
    }

    const final = await stream.finalResult;
    expect(final.output[0]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello world' }],
    });
    expect(final.output[1]).toEqual({
      type: 'function_call',
      id: 'call_2',
      name: 'get_weather',
      arguments: '{"city":"Bengaluru"}',
    });
    expect(final.output[2]).toEqual({
      type: 'reasoning',
      id: 'reason_2',
      summary: [{ type: 'summary_text', text: 'checked' }],
    });
  });

  it('rejects finalResult and releases endpoint capacity when aborted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_3","object":"response","created":3,"model":"qwen3","output":[]}}\n\n',
            ),
          );
        },
      }),
    });

    const client = new OllamaClient({
      endpoints: [{ name: 'compat', baseUrl: 'http://compat' }],
      endpointHealth: { maxConcurrentPerEndpoint: 1 },
      fetch: fetchMock as never,
    });

    const stream = await client.openai.responses({
      model: 'qwen3',
      input: 'Hi',
      stream: true,
    });

    expect(client.endpointStatus()[0]?.activeRequests).toBe(1);
    stream.abort();
    await expect(stream.finalResult).rejects.toMatchObject({ code: 'aborted' });
    expect(client.endpointStatus()[0]?.activeRequests).toBe(0);
  });
});

describe('OpenAI completion compatibility streaming', () => {
  it('aggregates text completion chunks', async () => {
    const fetchMock = sseFetchMock([
      'data: {"id":"cmpl-1","object":"text_completion","created":1,"model":"llama3.2","choices":[{"index":0,"text":"Hel","finish_reason":null}],"usage":null}\n\n',
      'data: {"id":"cmpl-1","object":"text_completion","created":1,"model":"llama3.2","choices":[{"index":0,"text":"lo","finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const client = new OllamaClient({ fetch: fetchMock as never });

    const stream = await client.openai.completions({
      model: 'llama3.2',
      prompt: 'Hi',
      stream: true,
      stream_options: { include_usage: true },
    });

    for await (const _ of stream) {
      // drain
    }

    const final = await stream.finalResult;
    expect(final.choices[0]?.text).toBe('Hello');
    expect(final.choices[0]?.finish_reason).toBe('stop');
    expect(final.usage?.total_tokens).toBe(3);
  });
});

describe('Anthropic compatibility streaming', () => {
  it('aggregates text and fragmented tool input JSON', async () => {
    const fetchMock = sseFetchMock([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"qwen3","content":[],"stop_reason":null,"usage":{"input_tokens":4,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"get_weather","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \\"Bengaluru\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":8}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    const client = new OllamaClient({ fetch: fetchMock as never });

    const stream = await client.anthropic.messages({
      model: 'qwen3',
      max_tokens: 256,
      stream: true,
    });

    const eventTypes = [];
    for await (const event of stream) eventTypes.push(event.type);

    expect(eventTypes).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const final = await stream.finalResult;
    expect(final.content[0]).toEqual({ type: 'text', text: 'Hello' });
    expect(final.content[1]).toEqual({
      type: 'tool_use',
      id: 'tool_1',
      name: 'get_weather',
      input: { city: 'Bengaluru' },
    });
    expect(final.stop_reason).toBe('tool_use');
    expect(final.usage).toEqual({ input_tokens: 4, output_tokens: 8 });
  });

  it('preserves unknown Anthropic SSE events for forward compatibility', async () => {
    const fetchMock = sseFetchMock([
      'event: future_event\ndata: {"type":"future_event","value":{"new_field":true}}\n\n',
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_future","type":"message","role":"assistant","model":"qwen3","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    const client = new OllamaClient({ fetch: fetchMock as never });
    const stream = await client.anthropic.messages({
      model: 'qwen3',
      max_tokens: 32,
      stream: true,
    });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events[0]).toEqual({ type: 'future_event', value: { new_field: true } });
    await expect(stream.finalResult).resolves.toMatchObject({ id: 'msg_future' });
  });

  it('aggregates thinking deltas and signatures', async () => {
    const fetchMock = sseFetchMock([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","model":"qwen3","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Reasoning"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    const client = new OllamaClient({ fetch: fetchMock as never });

    const stream = await client.anthropic.messages({
      model: 'qwen3',
      max_tokens: 256,
      stream: true,
      thinking: { type: 'enabled' },
    });

    for await (const _ of stream) {
      // drain
    }

    const final = await stream.finalResult;
    expect(final.content[0]).toEqual({
      type: 'thinking',
      thinking: 'Reasoning',
      signature: 'sig',
    });
  });
});
