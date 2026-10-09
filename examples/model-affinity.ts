/**
 * Model-affinity scheduling (see src/affinity.ts).
 *
 * Multi-model workloads thrash a local daemon when they interleave models
 * arbitrarily: each switch queues until the first model goes idle or is
 * evicted (OLLAMA_MAX_LOADED_MODELS), paying an unload/cold-load swap.
 * ModelAffinityScheduler keeps the working set small — per-model serial
 * queues, one model hot at a time by default, and candidate routing to
 * whichever model is already loaded.
 *
 *   npm run example examples/model-affinity.ts
 */
import { ModelAffinityScheduler, OllamaClient } from '../src/index.js';

async function main() {
  const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });

  const scheduler = new ModelAffinityScheduler(client, {
    concurrentModels: 1, // one model hot at a time — the anti-thrash default
    perModelConcurrency: 1, // mirror a default OLLAMA_NUM_PARALLEL=1 daemon
  });

  const docs = Array.from({ length: 6 }, (_, i) => `source file #${i}`);
  const questions = ['Why is the sky blue?', 'Explain KV-cache reuse.'];

  try {
    // 1. Extraction tasks queue on the coder model — serialized, FIFO.
    const extraction = docs.map((doc, i) =>
      scheduler.run('qwen2.5:coder', async () => {
        const res = await client.generate({
          model: 'qwen2.5:coder',
          prompt: `Extract the function signatures from ${doc}. Answer in one line.`,
        });
        return `[extract ${i}] ${res.response.slice(0, 60)}`;
      }),
    );

    // 2. Reasoning tasks queue on the thinking model — they wait until the
    //    coder queue drains (one model hot at a time), instead of ping-ponging.
    const reasoning = questions.map((q) =>
      scheduler.run('deepseek-r1', async () => {
        const res = await client.chat({
          model: 'deepseek-r1',
          messages: [{ role: 'user', content: q }],
        });
        return `[reason] ${q} -> ${res.message.content.slice(0, 60)}`;
      }),
    );

    // 3. Either-or: pick whichever interchangeable model is already loaded
    //    (GET /api/ps, TTL-cached) — the affinity bonus.
    const summary = await scheduler.run(['qwen2.5:coder', 'qwen2.5:14b'], async (model) => {
      const res = await client.generate({
        model,
        prompt: 'Summarize the extraction results in one sentence.',
      });
      return `[${model}] ${res.response.slice(0, 60)}`;
    });

    const results = await Promise.all([...extraction, ...reasoning, summary]);
    for (const line of results) console.log(line);

    console.log('\nstats:', scheduler.stats); // { activeModels: [], queuedTasks: 0 }
    await scheduler.dispose(); // waits for every queue to drain (already dry here)
  } finally {
    client.destroy('example finished');
  }
}

main().catch((err) => {
  console.error(
    'Is Ollama running on http://localhost:11434? (models: qwen2.5:coder, deepseek-r1)',
    err,
  );
  process.exit(1);
});
