import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '../src/agent/agent.js';
import { defineTool } from '../src/tools/define-tool.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ModelOptions } from '../src/types.js';

describe('Agent Loop', () => {
  it('executes tool call and returns final message', async () => {
    const getWeather = defineTool({
      name: 'get_weather',
      description: 'Get weather for city',
      schema: z.object({ city: z.string() }),
      execute: ({ city }) => `Sunny in ${city}, 25°C`,
    });

    const registry = new ToolRegistry();
    registry.register(getWeather);

    let turn = 0;
    const mockChatClient = {
      chat: vi.fn().mockImplementation(async () => {
        turn++;
        if (turn === 1) {
          return {
            message: {
              role: 'assistant' as const,
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'get_weather',
                    arguments: { city: 'Tokyo' },
                  },
                },
              ],
            },
          };
        }
        return {
          message: {
            role: 'assistant' as const,
            content: 'The weather in Tokyo is Sunny, 25°C.',
          },
        };
      }),
    };

    const agent = new Agent(mockChatClient, {
      tools: registry,
      maxIterations: 5,
      validateToolCapability: false,
    });
    const result = await agent.run({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    });

    expect(result.finalMessage.content).toBe('The weather in Tokyo is Sunny, 25°C.');
    expect(result.totalIterations).toBe(2);
  });
});


describe('Agent tool preflight and context management', () => {
  const tool = defineTool({
    name: 'get_weather',
    description: 'Get weather',
    schema: z.object({ city: z.string() }),
    execute: ({ city }) => 'Sunny in ' + city,
  });

  it('skips capability discovery and automatic context sizing when preflight is disabled', async () => {
    const tool = defineTool({
      name: 'echo',
      description: 'Echo',
      schema: z.object({ text: z.string() }),
      execute: ({ text }) => text,
    });
    const capabilities = vi.fn();
    const requests: Array<{ options?: ModelOptions }> = [];
    const client = {
      capabilities,
      chat: vi.fn().mockImplementation(async (request) => {
        requests.push(request);
        return {
          message: { role: 'assistant' as const, content: 'done' },
        };
      }),
    };

    const agent = new Agent(client, {
      tools: new ToolRegistry([tool]),
      validateToolCapability: false,
    });

    await agent.run({
      model: 'legacy',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(capabilities).not.toHaveBeenCalled();
    expect(requests[0]?.options).toBeUndefined();
  });

  it('rejects tool loops when the model does not advertise tool support', async () => {
    const chat = vi.fn();
    const client = {
      capabilities: vi.fn().mockResolvedValue({
        model: 'tiny',
        reported: ['completion'],
        supportsTools: false,
        supportsVision: false,
        supportsEmbedding: false,
        supportsCompletion: true,
        supportsThinking: false,
        supportsStreaming: true,
        supportsStructuredOutputRequest: true,
      }),
      chat,
    };

    const agent = new Agent(client, {
      tools: new ToolRegistry([tool]),
      maxIterations: 2,
    });

    await expect(
      agent.run({
        model: 'tiny',
        messages: [{ role: 'user', content: 'use get_weather' }],
      }),
    ).rejects.toMatchObject({
      code: 'incompatible_model',
      model: 'tiny',
      capability: 'tools',
    });
    expect(chat).not.toHaveBeenCalled();
  });

  it('defaults tool-enabled agent turns to 32768 context tokens and respects explicit overrides', async () => {
    const requests: Array<{ options?: ModelOptions }> = [];
    const client = {
      capabilities: vi.fn().mockResolvedValue({
        model: 'large',
        reported: ['completion', 'tools'],
        supportsTools: true,
        supportsVision: false,
        supportsEmbedding: false,
        supportsCompletion: true,
        supportsThinking: false,
        supportsStreaming: true,
        supportsStructuredOutputRequest: true,
        contextLength: 65536,
      }),
      chat: vi.fn().mockImplementation(async (request) => {
        requests.push(request);
        return {
          message:
            requests.length === 1
              ? {
                  role: 'assistant' as const,
                  content: '',
                  tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Tokyo' } } }],
                }
              : { role: 'assistant' as const, content: 'done' },
        };
      }),
    };

    const agent = new Agent(client, {
      tools: new ToolRegistry([tool]),
      maxIterations: 2,
    });

    await agent.run({
      model: 'large',
      messages: [{ role: 'user', content: 'weather?' }],
    });

    expect(requests[0]?.options?.num_ctx).toBe(32768);

    requests.length = 0;
    const secondAgent = new Agent(client, {
      tools: new ToolRegistry([tool]),
      maxIterations: 2,
    });
    await secondAgent.run({
      model: 'large',
      messages: [{ role: 'user', content: 'weather?' }],
      options: { num_ctx: 8192 },
    });

    expect(requests[0]?.options?.num_ctx).toBe(8192);
  });

  it('clamps the automatic tool context default to the model-reported context length', async () => {
    const requests: Array<{ options?: ModelOptions }> = [];
    const client = {
      capabilities: vi.fn().mockResolvedValue({
        model: 'small',
        reported: ['completion', 'tools'],
        supportsTools: true,
        supportsVision: false,
        supportsEmbedding: false,
        supportsCompletion: true,
        supportsThinking: false,
        supportsStreaming: true,
        supportsStructuredOutputRequest: true,
        contextLength: 16384,
      }),
      chat: vi.fn().mockImplementation(async (request) => {
        requests.push(request);
        return { message: { role: 'assistant' as const, content: 'done' } };
      }),
    };

    const agent = new Agent(client, {
      tools: new ToolRegistry([tool]),
      maxIterations: 2,
    });

    await agent.run({
      model: 'small',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(requests[0]?.options?.num_ctx).toBe(16384);
  });
});
