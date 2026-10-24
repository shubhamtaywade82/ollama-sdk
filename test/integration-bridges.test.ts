import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { useVcr } from './vcr.js';

describe('Integration: OpenAI Compatibility Bridge with VCR', () => {
  const MODEL_NAME = 'qwen3.5:2b';

  it('lists models via OpenAI /v1/models endpoint', async () => {
    await useVcr('bridge_openai_models', async (client) => {
      const res = await client.openai.listModels();
      expect(res.object).toBe('list');
      expect(res.data.length).toBeGreaterThan(0);
      expect(res.data[0]?.id).toBeDefined();
    });
  }, 120_000);

  it('translates chat completions through OpenAI /v1/chat/completions bridge', async () => {
    await useVcr('bridge_openai_chat', async (client) => {
      const res = await client.openai.chatCompletions({
        model: MODEL_NAME,
        messages: [{ role: 'user', content: 'Say "42" only.' }],
        temperature: 0,
      });

      expect(res.choices.length).toBeGreaterThan(0);
      expect(res.choices[0]?.message.content).toContain('42');
      expect(res.choices[0]?.finish_reason).toBe('stop');
    });
  }, 120_000);
});

describe('Compatibility bridge request typing (mocked network)', () => {
  it('forwards OpenAI stream_options.include_usage in the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"llama3.2","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\\n\\n',
            ),
          );
          controller.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n'));
          controller.close();
        },
      }),
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    await client.openai.chatCompletions({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body).stream_options).toEqual({ include_usage: true });
  });

  it('forwards OpenAI tools (function definitions) in the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'x',
        object: 'chat.completion',
        created: 0,
        model: 'llama3.2',
        choices: [],
      }),
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    await client.openai.chatCompletions({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the current weather for a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.tools[0].function.name).toBe('get_weather');
    // tool_choice / parallel_tool_calls are typed as accepted-but-ignored — Ollama's
    // OpenAI-compat layer documents both as unsupported, so omitting them from the
    // request leaves them absent from the body.
    expect(body.tool_choice).toBeUndefined();
  });

  it('strips unsupported Anthropic cache_control from request content blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'x',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'llama3.2',
        stop_reason: 'end_turn',
      }),
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    await client.anthropic.messages({
      model: 'llama3.2',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a long reusable prefix', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
  });
});

describe('Compatibility endpoint routing and streaming lifecycle', () => {
  it('uses model-scoped failover for OpenAI compatibility calls', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('primary')) {
        return { ok: false, status: 503, text: async () => 'primary unavailable' };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'chat-2',
            object: 'chat.completion',
            created: 0,
            model: 'gpt-oss:20b',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'secondary' },
                finish_reason: 'stop',
              },
            ],
          }),
      };
    });

    const client = new OllamaClient({
      endpoints: [
        { name: 'primary', baseUrl: 'http://primary', models: ['gpt-oss:20b'] },
        { name: 'secondary', baseUrl: 'http://secondary', models: ['gpt-oss:20b'] },
      ],
      retries: 0,
      fetch: fetchMock as never,
    });

    const result = await client.openai.chatCompletions({
      model: 'gpt-oss:20b',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.choices[0]?.message.content).toBe('secondary');
    expect(fetchMock.mock.calls[0]?.[0]).toContain('http://primary');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('http://secondary');
  });

  it('keeps a compatibility stream slot until the stream final result resolves', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(
              'data: {"id":"chat-3","object":"chat.completion.chunk","created":1,"model":"qwen3","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\n',
            ),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
    });

    const client = new OllamaClient({
      endpoints: [{ name: 'compat', baseUrl: 'http://compat' }],
      endpointHealth: { maxConcurrentPerEndpoint: 1 },
      fetch: fetchMock as never,
    });

    const stream = await client.openai.chatCompletions({
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    expect(client.endpointStatus()[0]?.activeRequests).toBe(1);

    for await (const _ of stream) {
      // drain
    }

    await stream.finalResult;
    expect(client.endpointStatus()[0]?.activeRequests).toBe(0);
  });
});

describe('Direct Ollama Cloud access through the compatibility bridges', () => {
  // https://docs.ollama.com/api/introduction#base-urls — OpenAI clients use
  // https://ollama.com/v1, Anthropic clients use https://ollama.com (+ /v1/messages),
  // both authenticated with `Authorization: Bearer $OLLAMA_API_KEY` (x-api-key alone
  // is rejected by the hosted Anthropic endpoint).
  function jsonFetch(body: unknown) {
    return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
  }

  it('sends OpenAI chat completions to https://ollama.com/v1 with a bearer token', async () => {
    const fetchMock = jsonFetch({
      id: 'x',
      object: 'chat.completion',
      created: 0,
      model: 'gemma4:31b',
      choices: [],
    });
    const client = new OllamaClient({
      baseUrl: 'https://ollama.com',
      apiKey: 'cloud-key',
      fetch: fetchMock as never,
    });

    await client.openai.chatCompletions({
      model: 'gemma4:31b',
      messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://ollama.com/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer cloud-key');
  });

  it('sends Anthropic messages to https://ollama.com/v1/messages with bearer auth and anthropic-version 2023-06-01', async () => {
    const fetchMock = jsonFetch({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'gemma4:31b',
      content: [{ type: 'text', text: 'Hello.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const client = new OllamaClient({
      baseUrl: 'https://ollama.com',
      apiKey: 'cloud-key',
      fetch: fetchMock as never,
    });

    await client.anthropic.messages({
      model: 'gemma4:31b',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://ollama.com/v1/messages');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer cloud-key');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
  });

  it('sends stateless OpenAI Responses requests to https://ollama.com/v1/responses', async () => {
    const fetchMock = jsonFetch({
      id: 'resp_1',
      object: 'response',
      created_at: 0,
      model: 'gemma4:31b',
      status: 'completed',
      output: [],
    });
    const client = new OllamaClient({
      baseUrl: 'https://ollama.com',
      apiKey: 'cloud-key',
      fetch: fetchMock as never,
    });

    await client.openai.responses({ model: 'gemma4:31b', input: 'Say hello in one sentence.' });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://ollama.com/v1/responses');
  });
});
