import { z } from 'zod';
import { defineTool, OllamaClient, ToolRegistry } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

const failingTool = defineTool({
  name: 'buggy_database_query',
  description: 'Simulates a database query that fails',
  schema: z.object({ query: z.string() }),
  execute: async () => {
    throw new Error('Database connection reset by peer (simulated)');
  },
});

async function main(): Promise<void> {
  const env = getLabEnv();
  const client = new OllamaClient({ baseUrl: env.localBaseUrl });
  const registry = new ToolRegistry([failingTool]);
  const start = Date.now();

  try {
    const res = await client.chat({
      model: env.localModel,
      messages: [
        { role: 'user', content: 'Run buggy_database_query with query "SELECT * FROM users"' },
      ],
      tools: registry.definitions(),
    });

    let toolExecutions: unknown = undefined;
    if (res.message.tool_calls?.length) {
      toolExecutions = await registry.executeToolCalls(res.message.tool_calls);
    }

    await labLogger.log({
      experimentId: '05-tools-tool-errors',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'chat-tool-error-resilience',
      durationMs: Date.now() - start,
      response: res.message.content || '(executed tool call)',
      toolCalls: res.message.tool_calls as readonly Record<string, unknown>[] | undefined,
      toolResults: toolExecutions as readonly Record<string, unknown>[] | undefined,
    });
  } catch (err) {
    await labLogger.log({
      experimentId: '05-tools-tool-errors',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'chat-tool-error-resilience',
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
  }
}

void main();
