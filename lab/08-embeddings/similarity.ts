import { OllamaClient } from '../../src/index.js';
import { getLabEnv } from '../support/env.js';
import { labLogger } from '../support/logger.js';

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function main(): Promise<void> {
  const env = getLabEnv();
  const client = new OllamaClient({ baseUrl: env.localBaseUrl });
  const documents = [
    'Ollama is an open-source framework for running LLMs locally on your machine.',
    'Vitest is a blazing fast unit test framework powered by Vite.',
    'Docker containers package applications and dependencies into standardized units.',
  ];
  const query = 'How do I run local AI models on my computer?';

  try {
    const docRes = await client.embed({ model: env.embedModel, input: documents });
    const queryRes = await client.embed({ model: env.embedModel, input: query });
    const qVec = queryRes.embeddings[0] ?? [];

    const scored = documents
      .map((doc, idx) => ({
        doc,
        similarity: Number(cosineSimilarity(qVec, docRes.embeddings[idx] ?? []).toFixed(4)),
      }))
      .sort((x, y) => y.similarity - x.similarity);

    await labLogger.log({
      experimentId: '08-embeddings-similarity',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.embedModel,
      operation: 'vector-cosine-similarity-search',
      response: { query, rankedResults: scored },
    });
  } catch (err) {
    await labLogger.log({
      experimentId: '08-embeddings-similarity',
      timestamp: new Date().toISOString(),
      provider: 'local',
      endpoint: env.localBaseUrl,
      model: env.embedModel,
      operation: 'vector-cosine-similarity-search',
      error: (err as Error).message,
    });
  }
}

void main();
