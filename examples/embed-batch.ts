/**
 * Batched embeddings with backpressure (see src/embed-batch.ts).
 *
 * High-volume RAG ingestion the safe way: `client.embedBatch()` splits a
 * corpus of any size into bounded /api/embed batches (defaults: 32 inputs
 * per request, 3 requests in flight) instead of the Promise.all flood that
 * OOMs local daemons and saturates OLLAMA_MAX_QUEUE. Order-preserving,
 * fail-fast, progress-reporting, abortable — and per-string context-window
 * pre-flight guards against Ollama's *silent* truncation of oversized
 * embedding inputs.
 *
 *   npm run example examples/embed-batch.ts
 */
import { OllamaClient } from '../src/index.js';

async function main() {
  const client = new OllamaClient({
    baseUrl: 'http://localhost:11434',
    // Making the window explicit also arms embedBatch's per-string pre-flight:
    // inputs whose token estimate exceeds 2048 warn (or throw, under
    // onContextOverflow: 'throw') before any request is sent.
    defaultContextLength: 2048,
  });

  const corpus = [
    'Machine learning and neural networks',
    'Artificial intelligence algorithms',
    'Baking traditional French sourdough bread',
    '量子計算とその将来性について', // CJK-aware estimation (~1 token/char)
    'The history of the Roman Empire',
    'Distributed systems and consensus protocols',
  ];

  try {
    // 1. Defaults: 32 inputs per batch, 3 batches in flight. For 6 inputs
    //    that's a single batch — but the same call scales unchanged to 50k.
    const single = await client.embedBatch({
      model: 'nomic-embed-text:latest',
      input: corpus,
    });
    console.log(
      `[defaults]   ${single.embeddings.length} vectors across ` +
        `${single.batchCount} batch(es), dim=${single.embeddings[0]?.length ?? 0}`,
    );

    // 2. Explicit backpressure for a constrained daemon (e.g. a laptop GPU):
    //    smaller batches, strictly sequential dispatch, progress reporting.
    const careful = await client.embedBatch({
      model: 'nomic-embed-text:latest',
      input: corpus,
      batchSize: 2,
      concurrency: 1,
      keep_alive: '10m', // keep the model pinned for the whole ingestion
      onBatchComplete: (done, total) => console.log(`  progress: ${done}/${total}`),
    });
    console.log(
      `[careful]    ${careful.embeddings.length} vectors across ${careful.batchCount} batches`,
    );

    // 3. Order preservation: embeddings[i] always maps to corpus[i], so a
    //    straight zip into a vector store is safe regardless of completion
    //    order.
    corpus.forEach((text, i) => {
      const vector = careful.embeddings[i];
      console.log(`  vector[${i}] <- ${JSON.stringify(text)} (${vector?.length ?? 0} dims)`);
    });

    // 4. Abortability: the caller's signal cancels queued and in-flight
    //    batches alike with OllamaAbortError (code 'aborted').
    const controller = new AbortController();
    const ingestion = client.embedBatch({
      model: 'nomic-embed-text:latest',
      input: Array.from({ length: 500 }, (_, i) => `synthetic document ${i}`),
      batchSize: 4,
      concurrency: 2,
      signal: controller.signal,
      onBatchComplete: (done) => {
        if (done === 3) controller.abort(); // simulate a pipeline shutdown
      },
    });
    const aborted = await ingestion.catch((error: { code?: string }) => {
      return error.code === 'aborted' ? 'aborted as expected' : `unexpected: ${String(error)}`;
    });
    console.log(`[abortable]  ${aborted}`);
  } finally {
    // 5. Teardown: abort anything still in flight — the clean-exit path for
    //    worker threads and short-lived scripts.
    const torn = client.destroy('example finished');
    if (torn > 0) console.log(`[teardown]   aborted ${torn} in-flight operation(s)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
