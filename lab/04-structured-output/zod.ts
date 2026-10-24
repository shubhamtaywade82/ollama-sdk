import { z } from 'zod';
import { OllamaClient } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

const TradeIdeaSchema = z.object({
  symbol: z.string(),
  side: z.enum(['BUY', 'SELL']),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

type TradeIdea = z.infer<typeof TradeIdeaSchema>;

async function main(): Promise<void> {
  const env = getLabEnv();
  const client = new OllamaClient({ baseUrl: env.localBaseUrl });
  const start = Date.now();

  try {
    const tradeIdea: TradeIdea = await client.chatWithSchema(
      {
        model: env.localModel,
        messages: [
          {
            role: 'user',
            content: 'Generate a trading signal for BTC/USDT based on strong momentum.',
          },
        ],
      },
      TradeIdeaSchema,
    );

    await labLogger.log({
      experimentId: '04-structured-zod',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'chatWithSchema',
      durationMs: Date.now() - start,
      response: tradeIdea,
    });
  } catch (err) {
    await labLogger.log({
      experimentId: '04-structured-zod',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.localModel,
      operation: 'chatWithSchema',
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
  }
}

void main();
