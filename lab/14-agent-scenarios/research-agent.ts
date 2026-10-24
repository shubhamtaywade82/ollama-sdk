import { z } from 'zod';
import { Agent, defineTool, OllamaClient, ToolRegistry } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

const searchDocsTool = defineTool({
  name: 'search_knowledge_base',
  description: 'Search documentation database for a topic',
  schema: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    return {
      query,
      results: [
        'Ollama Client TS supports auto failover across healthy endpoints.',
        'Structured outputs convert Zod schemas to valid JSON schema.',
        'Tool calls are executed with bounded concurrency and configurable timeouts.',
      ],
    };
  },
});

async function main(): Promise<void> {
  const env = getLabEnv();
  const client = new OllamaClient({ baseUrl: env.localBaseUrl });
  const registry = new ToolRegistry([searchDocsTool]);
  const agent = new Agent(client, { tools: registry, maxIterations: 5 });
  const start = Date.now();

  try {
    const res = await agent.run({
      model: env.localModel,
      messages: [
        {
          role: 'user',
          content:
            'Search the knowledge base for Ollama Client TS features and give me a brief 2-point summary.',
        },
      ],
    });

    await labLogger.log({
      experimentId: '14-scenarios-research-agent',
      timestamp: new Date().toISOString(),
      provider: 'agent',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'agent-scenario-research',
      durationMs: Date.now() - start,
      response: {
        finalAnswer: res.finalMessage.content,
        iterations: res.totalIterations,
      },
    });
  } catch (err) {
    await labLogger.log({
      experimentId: '14-scenarios-research-agent',
      timestamp: new Date().toISOString(),
      provider: 'agent',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'agent-scenario-research',
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
  }
}

void main();
