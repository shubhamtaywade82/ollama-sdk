import { z } from 'zod';
import { OllamaClient } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

const BookSchema = z.object({
  title: z.string(),
  author: z.string(),
  year: z.number().int(),
  genres: z.array(z.string()),
});

async function main(): Promise<void> {
  const env = getLabEnv();
  const client = new OllamaClient({ baseUrl: env.localBaseUrl });
  const models = [env.localModel];
  const results: Record<string, unknown> = {};

  for (const model of models) {
    const start = Date.now();
    try {
      const book = await client.chatWithSchema(
        {
          model,
          messages: [{ role: 'user', content: 'Provide details for "1984" by George Orwell.' }],
        },
        BookSchema,
      );
      results[model] = { success: true, durationMs: Date.now() - start, output: book };
    } catch (err) {
      results[model] = {
        success: false,
        durationMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  await labLogger.log({
    experimentId: '04-structured-compare-models',
    timestamp: new Date().toISOString(),
    provider: 'local',
    endpoint: env.localBaseUrl,
    model: models.join(', '),
    operation: 'compare-schema-models',
    response: results,
  });
}

void main();
