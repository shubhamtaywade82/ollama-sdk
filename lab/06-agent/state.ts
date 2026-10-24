import { z } from 'zod';
import { Agent, defineTool, OllamaClient, ToolRegistry } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

const agentMemory = new Map<string, string>();

const saveMemoryTool = defineTool({
  name: 'save_memory',
  description: 'Saves a key-value pair into agent memory',
  schema: z.object({ key: z.string(), value: z.string() }),
  execute: async ({ key, value }) => {
    agentMemory.set(key, value);
    return { status: 'stored', key, value };
  },
});

const getMemoryTool = defineTool({
  name: 'get_memory',
  description: 'Retrieves a value by key from agent memory',
  schema: z.object({ key: z.string() }),
  execute: async ({ key }) => ({ key, value: agentMemory.get(key) ?? null }),
});

async function main(): Promise<void> {
  const env = getLabEnv();
  const client = new OllamaClient({ baseUrl: env.localBaseUrl });
  const registry = new ToolRegistry([saveMemoryTool, getMemoryTool]);
  const agent = new Agent(client, { tools: registry, maxIterations: 6 });

  try {
    const res = await agent.run({
      model: env.localModel,
      messages: [
        {
          role: 'user',
          content:
            'Save the secret code "LAB_42" under key "passcode", then fetch it back and confirm.',
        },
      ],
    });

    await labLogger.log({
      experimentId: '06-agent-state',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'agent-stateful-memory',
      response: {
        finalAnswer: res.finalMessage.content,
        finalMemoryState: Object.fromEntries(agentMemory.entries()),
      },
    });
  } catch (err) {
    await labLogger.log({
      experimentId: '06-agent-state',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'agent-stateful-memory',
      error: (err as Error).message,
    });
  }
}

void main();
