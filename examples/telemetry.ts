/**
 * Standardized telemetry (see src/telemetry/metrics.ts).
 *
 * Ollama reports durations in nanoseconds plus raw token counters on every
 * generation response. formatTelemetry() turns them into ms, tokens/second
 * and a prompt-cache hit ratio, with the formulas from the official docs.
 *
 *   npm run example examples/telemetry.ts
 */
import { OllamaClient, formatTelemetry } from '../src/index.js';

async function main() {
  const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
  const model = process.env.OLLAMA_MODEL ?? 'llama3.2';

  const messages = [
    { role: 'system' as const, content: 'You are a concise assistant.' },
    { role: 'user' as const, content: 'Explain KV-cache reuse in two sentences.' },
  ];

  // Two identical calls: the second should be served largely from the prompt cache.
  for (const attempt of [1, 2]) {
    const res = await client.chat({ model, messages });
    const t = formatTelemetry(res);
    console.log(
      `#${attempt}: ${t.tokensPerSecond} tok/s | total ${t.totalLatencyMs} ms ` +
        `(load ${t.modelLoadMs} ms, prompt ${t.promptEvalMs} ms, gen ${t.generationMs} ms) | ` +
        `${Math.round(t.cacheHitRatio * 100)}% prompt cache hit`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
