import { OllamaClient } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

async function main(): Promise<void> {
  const env = getLabEnv();
  const local = new OllamaClient({ baseUrl: env.localBaseUrl });
  const cloud = new OllamaClient({
    baseUrl: env.cloudBaseUrl,
    ...(env.apiKey !== undefined ? { apiKey: env.apiKey } : {}),
  });
  const prompt = 'What is the speed of light in vacuum?';

  const t0 = Date.now();
  let localResult: string;
  let localTime = 0;
  try {
    const res = await local.chatText({
      model: env.localModel,
      messages: [{ role: 'user', content: prompt }],
    });
    localResult = res;
    localTime = Date.now() - t0;
  } catch (e) {
    localResult = `Local Error: ${(e as Error).message}`;
  }

  const t1 = Date.now();
  let cloudResult: string;
  let cloudTime = 0;
  try {
    const res = await cloud.chatText({
      model: env.cloudModel,
      messages: [{ role: 'user', content: prompt }],
    });
    cloudResult = res;
    cloudTime = Date.now() - t1;
  } catch (e) {
    cloudResult = `Cloud Error: ${(e as Error).message}`;
  }

  await labLogger.log({
    experimentId: '00-smoke-compare-local-cloud',
    timestamp: new Date().toISOString(),
    provider: 'comparison',
    endpoint: 'multi',
    model: `${env.localModel} vs ${env.cloudModel}`,
    operation: 'compare',
    response: {
      local: { latencyMs: localTime, output: localResult },
      cloud: { latencyMs: cloudTime, output: cloudResult },
      latencyDiffMs: cloudTime - localTime,
    },
  });
}

void main();
