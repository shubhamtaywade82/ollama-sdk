import { OllamaClient } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

async function main(): Promise<void> {
  const env = getLabEnv();
  const client = new OllamaClient({ baseUrl: env.localBaseUrl });
  const start = Date.now();

  try {
    const res = await client.generate({
      model: env.thinkModel,
      prompt:
        'If a rooster lays an egg on top of a barn roof, which way does it roll? Reason step by step.',
      think: true,
    });

    await labLogger.log({
      experimentId: '02-generate-thinking',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.thinkModel,
      operation: 'generate-think',
      durationMs: Date.now() - start,
      response: {
        thinking: res.thinking ?? '(none)',
        response: res.response,
      },
    });
  } catch (err) {
    await labLogger.log({
      experimentId: '02-generate-thinking',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'generate-think',
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
  }
}

void main();
