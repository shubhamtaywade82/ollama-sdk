import { z } from 'zod';
import {
  Agent,
  defineTool,
  OllamaAgentMaxIterationsError,
  OllamaClient,
  ToolRegistry,
} from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

const infiniteTool = defineTool({
  name: 'loop_tool',
  description: 'A tool that asks to be called again',
  schema: z.object({ step: z.number() }),
  execute: async ({ step }) => ({
    nextStep: step + 1,
    message: 'Please call loop_tool again with nextStep',
  }),
});

async function main(): Promise<void> {
  const env = getLabEnv();
  const client = new OllamaClient({ baseUrl: env.localBaseUrl });
  const registry = new ToolRegistry([infiniteTool]);
  const agent = new Agent(client, { tools: registry, maxIterations: 2 });
  const start = Date.now();

  try {
    const res = await agent.run({
      model: env.localModel,
      messages: [{ role: 'user', content: 'Call loop_tool with step 1 and keep going.' }],
    });

    await labLogger.log({
      experimentId: '06-agent-max-iterations',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'agent-max-iterations-test',
      durationMs: Date.now() - start,
      response: res.finalMessage.content,
    });
  } catch (err) {
    const isExpected = err instanceof OllamaAgentMaxIterationsError;
    await labLogger.log({
      experimentId: '06-agent-max-iterations',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'agent-max-iterations-test',
      durationMs: Date.now() - start,
      response: {
        caughtExpectedError: isExpected,
        errorMessage: (err as Error).message,
      },
    });
  }
}

void main();
