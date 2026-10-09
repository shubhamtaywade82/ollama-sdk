/**
 * Context-window discovery + compaction (see src/context-discovery.ts and
 * src/conversation.ts).
 *
 * Stop guessing whether the window is 2048, 4096, or 131072: ask the server.
 * `models.getContextLength()` resolves the *allocated* window of the running
 * instance (/api/ps), the Modelfile `num_ctx` default, and the native GGUF
 * maximum (/api/show model_info) in precedence order — then `session.compact()`
 * keeps a long conversation inside that window when it finally outgrows it.
 *
 *   npm run example examples/context-window-discovery.ts
 */
import { OllamaClient } from '../src/index.js';

async function main() {
  const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
  const model = process.argv[2] ?? 'llama3.1:latest';

  // 1. Discover the real window — one lookup, every signal the server has.
  const window = await client.models.getContextLength({ model });
  console.log(`[${model}]`);
  console.log(`  effective window : ${window.contextLength} (source: ${window.source})`);
  if (window.runningContextLength !== undefined) {
    console.log(`  allocated (ps)   : ${window.runningContextLength}`);
  }
  if (window.parameterContextLength !== undefined) {
    console.log(`  Modelfile num_ctx: ${window.parameterContextLength}`);
  }
  if (window.nativeContextLength !== undefined) {
    console.log(`  native GGUF max  : ${window.nativeContextLength} <- the raiseable ceiling`);
  }

  // 2. Wire it into the client's own pre-flight checks — no more 2048 guesswork.
  const tuned = new OllamaClient({
    baseUrl: 'http://localhost:11434',
    defaultContextLength: window.contextLength,
  });

  // 3. A session that outgrows its window: compact() is the explicit fix.
  const session = tuned.session(model, 'You are a precise assistant.', {
    options: { num_ctx: window.contextLength },
  });
  for (let i = 1; i <= 12; i += 1) {
    await session.send(`Question ${i}: ${'explain distributed consensus in detail. '.repeat(8)}`);
  }
  console.log(
    `\n[session] ${session.cacheStats.turns} turns, hit rate ` +
      `${(session.cacheStats.hitRate * 100).toFixed(1)}%`,
  );

  const result = session.compact();
  console.log(
    `[compact] dropped ${result.droppedMessages} messages, ` +
      `~${result.estimatedTokensBefore} -> ~${result.estimatedTokensAfter} tokens ` +
      `(budget ${result.effectiveBudget})`,
  );
  console.log('  (next turn starts with a cold KV cache — the visible cost of compaction)');

  const reply = await session.send('Summarize what we discussed.');
  console.log(`[after]    ${reply.slice(0, 80)}…`);
}

main().catch((err) => {
  console.error('Is Ollama running on http://localhost:11434?', err);
  process.exit(1);
});
