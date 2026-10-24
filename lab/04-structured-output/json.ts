import { OllamaClient } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

async function main(): Promise<void> {
  const env = getLabEnv();
  const client = new OllamaClient({ baseUrl: env.localBaseUrl });
  const start = Date.now();

  try {
    const res = await client.chat({
      model: env.localModel,
      messages: [
        {
          role: 'user',
          content: 'Output a user object with name "Alice", age 30, and role "admin" in JSON.',
        },
      ],
      format: 'json',
    });

    const parsed = JSON.parse(res.message.content) as Record<string, unknown>;

    await labLogger.log({
      experimentId: '04-structured-json',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'chat-json-format',
      durationMs: Date.now() - start,
      response: parsed,
    });
  } catch (err) {
    await labLogger.log({
      experimentId: '04-structured-json',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'chat-json-format',
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
  }
}

void main();
