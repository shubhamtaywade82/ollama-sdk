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

  it('forwards Anthropic cache_control on content blocks in the request body', async () => {
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
    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});
