import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '../src/agent/agent.js';
import { OllamaClient } from '../src/client.js';
import { defineTool, ToolRegistry } from '../src/tools/index.js';
import type { ChatResponse, GenerateResponse, ModelOptions } from '../src/types.js';

function jsonFetchMock(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

describe('next Ollama API parity', () => {
  it('forwards image-generation parameters on /api/generate', async () => {
    const fetchMock = jsonFetchMock({
      model: 'x/flux',
      created_at: '2026-09-25T00:00:00Z',
      response: '',
      done: true,
      image: 'base64-image',
      completed: 20,
      total: 20,
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    const response = await client.generate({
      model: 'x/flux',
      prompt: 'A futuristic city',
      width: 1024,
      height: 768,
      steps: 20,
      stream: false,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.width).toBe(1024);
    expect(body.height).toBe(768);
    expect(body.steps).toBe(20);
    expect(response.image).toBe('base64-image');
    expect(response.completed).toBe(20);
    expect(response.total).toBe(20);
  });

  it('forwards draft_num_predict in model options and accepts cached prompt counts', async () => {
    const fetchMock = jsonFetchMock({
      model: 'llama3.2',
      created_at: '2026-09-25T00:00:00Z',
      message: { role: 'assistant', content: 'ok' },
      done: true,
      prompt_eval_count: 100,
      prompt_eval_cached_count: 80,
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    const options: ModelOptions = { draft_num_predict: 4 };
    const response = await client.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hello' }],
      options,
      stream: false,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.options.draft_num_predict).toBe(4);
    expect(response.prompt_eval_cached_count).toBe(80);
  });

  it('preserves native Ollama tool_name while retaining synthetic tool_call_id correlation', async () => {
    const captured: Array<{ messages: readonly { role: string; tool_name?: string; tool_call_id?: string }[] }> = [];
    const chat = vi
      .fn()
      .mockImplementationOnce(async (request: { messages: readonly { role: string; tool_name?: string; tool_call_id?: string }[] }) => {
        captured.push({ messages: request.messages });
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Tokyo' } } }],
          },
        };
      })
      .mockImplementationOnce(async (request: { messages: readonly { role: string; tool_name?: string; tool_call_id?: string }[] }) => {
        captured.push({ messages: request.messages });
        return {
          message: { role: 'assistant', content: 'It is sunny.' },
        };
      });

    const tool = defineTool({
      name: 'get_weather',
      description: 'Get weather',
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, condition: 'sunny' }),
    });

    const agent = new Agent(
      { chat } as never,
      { tools: new ToolRegistry([tool]), maxIterations: 2 },
    );

    await agent.run({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'Weather in Tokyo?' }],
    });

    const toolMessage = captured[1]?.messages.at(-1);
    expect(toolMessage?.role).toBe('tool');
    expect(toolMessage?.tool_name).toBe('get_weather');
    expect(toolMessage?.tool_call_id).toMatch(/^call_/);
  });

  it('keeps image-generation and cached-count fields part of the public response types', () => {
    const chat: ChatResponse = {
      model: 'llama3.2',
      created_at: '2026-09-25T00:00:00Z',
      message: { role: 'assistant', content: 'ok' },
      done: true,
      prompt_eval_cached_count: 1,
    };
    const generated: GenerateResponse = {
      model: 'x/flux',
      created_at: '2026-09-25T00:00:00Z',
      response: '',
      done: true,
      image: 'base64-image',
      completed: 1,
      total: 1,
    };

    expect(chat.prompt_eval_cached_count).toBe(1);
    expect(generated.image).toBe('base64-image');
  });
});
