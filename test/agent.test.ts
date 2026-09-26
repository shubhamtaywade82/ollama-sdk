import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '../src/agent/agent.js';
import { defineTool } from '../src/tools/define-tool.js';
import { ToolRegistry } from '../src/tools/registry.js';

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

    const agent = new Agent(mockChatClient, { tools: registry, maxIterations: 5 });
    const result = await agent.run({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    });

    expect(result.finalMessage.content).toBe('The weather in Tokyo is Sunny, 25°C.');
    expect(result.totalIterations).toBe(2);
  });
});


  it('enforces a run-level maximum tool-call budget', async () => {
    const tool = defineTool({
      name: 'loop',
      description: 'Always loops',
      schema: z.object({ value: z.number() }),
      execute: ({ value }) => ({ value }),
    });

    const registry = new ToolRegistry([tool]);
    const chat = vi.fn().mockResolvedValue({
      message: {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ function: { name: 'loop', arguments: { value: 1 } } }],
      },
    });

    const agent = new Agent({ chat }, {
      tools: registry,
      maxIterations: 10,
      maxToolCalls: 2,
    });

    await expect(
      agent.run({ model: 'llama3.2', messages: [{ role: 'user', content: 'loop' }] }),
    ).rejects.toMatchObject({
      code: 'agent_max_tool_calls_exceeded',
      maxToolCalls: 2,
    });

    expect(chat).toHaveBeenCalledTimes(3);
  });
