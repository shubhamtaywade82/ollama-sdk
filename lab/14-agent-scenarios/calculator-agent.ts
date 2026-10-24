import { z } from 'zod';
import { Agent, defineTool, OllamaClient, ToolRegistry } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

const addTool = defineTool({
  name: 'add_numbers',
  description: 'Add two numbers',
  schema: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => ({ result: a + b }),
});

const multiplyTool = defineTool({
  name: 'multiply_numbers',
  description: 'Multiply two numbers',
  schema: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => ({ result: a * b }),
});

async function main(): Promise<void> {
  const env = getLabEnv();
  const client = new OllamaClient({ baseUrl: env.localBaseUrl });
  const registry = new ToolRegistry([addTool, multiplyTool]);
  const agent = new Agent(client, { tools: registry, maxIterations: 6 });
  const start = Date.now();

  try {
    const res = await agent.run({
      model: env.localModel,
      messages: [
        {
          role: 'user',
          content: 'First calculate (12 + 18), then multiply that result by 4. Use tools.',
        },
      ],
    });

    await labLogger.log({
      experimentId: '14-scenarios-calculator-agent',
      timestamp: new Date().toISOString(),
      provider: 'agent',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'agent-scenario-calculator',
      durationMs: Date.now() - start,
      response: {
        finalAnswer: res.finalMessage.content,
        totalIterations: res.totalIterations,
        turns: res.turns.map((t) => ({ iteration: t.iteration, toolCalls: t.toolCalls })),
      },
    });
  } catch (err) {
    await labLogger.log({
      experimentId: '14-scenarios-calculator-agent',
      timestamp: new Date().toISOString(),
      provider: 'agent',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'agent-scenario-calculator',
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
  }
}

void main();
