import { z } from 'zod';
import { Agent, defineTool, OllamaClient, ToolRegistry } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

const executeStepTool = defineTool({
  name: 'execute_step',
  description: 'Executes an atomic plan step',
  schema: z.object({ stepNumber: z.number(), description: z.string() }),
  execute: async ({ stepNumber, description }) => ({
    stepNumber,
    description,
    status: 'COMPLETED',
  }),
});

async function main(): Promise<void> {
  const env = getLabEnv();
  const client = new OllamaClient({ baseUrl: env.localBaseUrl });
  const registry = new ToolRegistry([executeStepTool]);
  const agent = new Agent(client, { tools: registry, maxIterations: 6 });
  const start = Date.now();

  try {
    const res = await agent.run({
      model: env.localModel,
      messages: [
        {
          role: 'user',
          content:
            'Plan 2 steps to deploy a TypeScript web server and execute each step using execute_step.',
        },
      ],
    });

    await labLogger.log({
      experimentId: '14-scenarios-planner-executor',
      timestamp: new Date().toISOString(),
      provider: 'agent',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'agent-scenario-planner-executor',
      durationMs: Date.now() - start,
      response: {
        finalAnswer: res.finalMessage.content,
        totalIterations: res.totalIterations,
      },
    });
  } catch (err) {
    await labLogger.log({
      experimentId: '14-scenarios-planner-executor',
      timestamp: new Date().toISOString(),
      provider: 'agent',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'agent-scenario-planner-executor',
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
  }
}

void main();
