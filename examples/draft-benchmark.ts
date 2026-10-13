/**
 * Speculative-decoding benchmark — does `draft_num_predict` actually pay off
 * for YOUR prompt? (compareDraftPerformance; see ADR 0030)
 *
 * Upstream reports no draft-token acceptance counter: speculative efficiency
 * is only observable as effective throughput. This example runs the
 * deterministic A/B — identical prompt on both sides, temperature 0 + a
 * fixed seed, warm-up discard, median of several samples per side.
 *
 *   npm run example examples/draft-benchmark.ts -- <model> [prompt]
 */
import { OllamaClient, compareDraftPerformance } from '../src/index.js';

async function main() {
  const [model, prompt] = process.argv.slice(2);
  if (!model) {
    console.error('usage: draft-benchmark.ts <model> [prompt]');
    process.exit(1);
  }

  const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
  const ping = await client.ping();
  if (!ping.healthy) {
    console.error(`Ollama is not reachable: ${ping.error ?? 'unknown error'}`);
    process.exit(1);
  }

  const comparison = await compareDraftPerformance(client, {
    model,
    prompt:
      prompt ??
      'Extract the sender, subject, and date from this email as JSON:\n' +
        'From: ada@example.com | Subject: Q4 review | Sent: 2026-10-13',
    draftNumPredict: 4,
  });

  console.log(`model:    ${comparison.model}`);
  console.log(`baseline  (draft_num_predict=0): ${comparison.baselineTokensPerSec} tok/s`);
  console.log(
    `drafting  (draft_num_predict=${comparison.draftNumPredict}): ${comparison.speculativeTokensPerSec} tok/s`,
  );
  console.log(
    `speedup:  ${comparison.speedupMultiplier}x (gain threshold ${comparison.gainThreshold})`,
  );
  console.log(`effective gain: ${comparison.effectiveGain}`);
  console.log(`samples:  baseline [${comparison.baseline.sampleTokensPerSecond.join(', ')}]`);
  console.log(`          drafting [${comparison.speculative.sampleTokensPerSecond.join(', ')}]`);

  if (comparison.speedupMultiplier < 1.05) {
    console.log(
      '\nA ~1.0x speedup usually means the model has no draft network — the\n' +
        'server silently ignores draft_num_predict. Try a model whose\n' +
        'distribution ships a draft network (or embeds MTP tensors).',
    );
  }
}

void main();
