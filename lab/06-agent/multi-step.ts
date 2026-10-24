import { z } from 'zod';
import { Agent, defineTool, OllamaClient, ToolRegistry } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

const getWeatherTool = defineTool({
  name: 'get_weather_celsius',
  description: 'Get temperature in Celsius for a city',
  schema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, celsius: 25 }),
});

const convertTool = defineTool({
  name: 'celsius_to_fahrenheit',
  description: 'Convert Celsius temperature to Fahrenheit',
  schema: z.object({ celsius: z.number() }),
  execute: async ({ celsius }) => ({ celsius, fahrenheit: (celsius * 9) / 5 + 32 }),
});

async function main(): Promise<void> {
  const env = getLabEnv();
  const client = new OllamaClient({ baseUrl: env.localBaseUrl });
  const registry = new ToolRegistry([getWeatherTool, convertTool]);
  const agent = new Agent(client, { tools: registry, maxIterations: 5 });
  const start = Date.now();

  try {
    const result = await agent.run({
      model: env.localModel,
      messages: [
        {
          role: 'user',
          content: 'What is the temperature in Paris in Fahrenheit? Use the available tools.',
        },
      ],
    });

    const traceFile = await labLogger.saveAgentTrace('agent-multi-step', result);

    await labLogger.log({
      experimentId: '06-agent-multi-step',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'agent-multi-step',
      durationMs: Date.now() - start,
      response: {
        finalAnswer: result.finalMessage.content,
        totalIterations: result.totalIterations,
        turnsCount: result.turns.length,
        savedTrace: traceFile,
      },
    });
  } catch (err) {
    await labLogger.log({
      experimentId: '06-agent-multi-step',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'agent-multi-step',
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
  }
}

void main();
