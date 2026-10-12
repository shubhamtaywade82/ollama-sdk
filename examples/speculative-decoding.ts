/**
 * Speculative decoding — assembling a draft-accelerated model and measuring
 * the speedup (see CreateModelFromGgufOptions.draftGguf and ADR 0029).
 *
 * Ollama packages speculative decoding as a small "draft" network whose
 * token guesses are batch-verified against the primary weights in a single
 * forward pass. On the wire this is `draft_files` (draft GGUF digests) +
 * `draft_quantize` + the `draft_num_predict` parameter on `/api/create`, and
 * the `draft_num_predict` runtime option at generation time.
 *
 *   npm run example examples/speculative-decoding.ts -- <primary.gguf> <draft.gguf> [model]
 */
import { OllamaClient, formatTelemetry } from '../src/index.js';

async function main() {
  const [primaryPath, draftPath, modelName] = process.argv.slice(2);
  if (!primaryPath || !draftPath) {
    console.error('usage: speculative-decoding.ts <primary.gguf> <draft.gguf> [model-name]');
    process.exit(1);
  }
  const model = modelName ?? 'spec-model:latest';

  const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });

  // 1. Liveness — don't upload gigabytes at a dead daemon.
  const ping = await client.ping();
  if (!ping.healthy) {
    console.error(`Ollama is not reachable: ${ping.error ?? 'unknown error'}`);
    process.exit(1);
  }

  // 2. Assemble: primary + draft shards uploaded as blobs, draft weights
  //    quantized independently (draft tokens are verified, never returned,
  //    so aggressive draft compression is usually safe).
  console.log(`assembling ${model} from ${primaryPath} + draft ${draftPath} ...`);
  const progress = await client.models.createModelFromGguf(model, primaryPath, {
    draftGguf: draftPath,
    draft_quantize: 'q8_0',
    parameters: { draft_num_predict: 8 },
  });
  console.log(`created: ${progress.status}`);

  // 3. Measure: drafting on vs off, official tok/s math via formatTelemetry.
  for (const draftNumPredict of [0, 8]) {
    const response = await client.chat({
      model,
      messages: [{ role: 'user', content: 'Describe a lighthouse in a storm, one paragraph.' }],
      options: { draft_num_predict: draftNumPredict },
    });
    const t = formatTelemetry(response);
    console.log(
      `draft_num_predict=${draftNumPredict === 0 ? 'off' : draftNumPredict}: ` +
        `${t.tokensPerSecond} tok/s | ${t.totalLatencyMs}ms total | load ${t.modelLoadMs}ms`,
    );
  }
}

void main();
