/**
 * Standardized telemetry (see src/telemetry/metrics.ts).
 *
 * Ollama reports every duration in nanoseconds. `formatTelemetry` turns any
 * response object into the summary you actually log — ms latencies,
 * tokens/second per the official Usage-doc formulas, and the KV cache-hit
 * ratio (cached / (cached + evaluated): a FULL cache hit reports
 * prompt_eval_count 0, so dividing by prompt_eval_count alone would read a
 * perfect cache as "no caching").
 *
 *   npm run example examples/telemetry.ts
 */
import { OllamaClient, formatTelemetry } from '../src/index.js';

async function main() {
  const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
  const model = process.argv[2] ?? 'llama3.2';

  // 1. Liveness first — the official ultra-lightweight root probe (HEAD /).
  const ping = await client.ping();
  if (!ping.healthy) {
    console.error(`Ollama is not reachable: ${ping.error ?? 'unknown error'}`);
    process.exit(1);
  }
  console.log(`daemon alive at ${ping.baseUrl} (${ping.latencyMs}ms)\n`);

  // 2. Cold request — watch the model-load time in the telemetry.
  const first = await client.chat({
    model,
    messages: [{ role: 'user', content: 'Explain KV caches in two sentences.' }],
  });
  const cold = formatTelemetry(first); // any response object, as-is
  console.log(
    `[cold] ${cold.totalLatencyMs}ms total | load ${cold.modelLoadMs}ms | ${cold.tokensPerSecond} tok/s`,
  );

  // 3. Same prompt again — a warm server and the KV prefix cache change the math.
  const second = await client.chat({
    model,
    messages: [{ role: 'user', content: 'Explain KV caches in two sentences.' }],
  });
  const warm = formatTelemetry(second);
  console.log(
    `[warm] ${warm.totalLatencyMs}ms total | load ${warm.modelLoadMs}ms | ${warm.tokensPerSecond} tok/s`,
  );

  // 4. The cache-hit ratio: 0.0–1.0, same semantics as session.cacheStats.
  const pct = Math.round(warm.cacheHitRatio * 100);
  console.log(`[warm] prompt cache hit: ${pct}% | pre-fill ${warm.promptTokensPerSecond} tok/s`);
  console.log('\nvalues derive from:');
  console.log(`  total_duration        ${first.total_duration ?? 0} ns`);
  console.log(`  load_duration         ${first.load_duration ?? 0} ns`);
  console.log(`  prompt_eval_duration  ${first.prompt_eval_duration ?? 0} ns`);
  console.log(`  eval_count/duration   ${first.eval_count ?? 0} / ${first.eval_duration ?? 0} ns`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
