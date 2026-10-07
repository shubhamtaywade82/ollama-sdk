/**
 * KV-cache-aware conversation sessions (see src/conversation.ts).
 *
 *   npm run example examples/conversation-session.ts
 */
import { OllamaClient } from '../src/index.js';

async function main() {
  const client = new OllamaClient();

  // The system prompt is pinned for the session's lifetime — mutating it
  // mid-conversation is the #1 silent KV-cache killer, so there is no API to.
  const session = client.session('qwen3:8b', 'You are a concise technical assistant.');

  await session.send('What is a KV cache?');
  console.log('turn 1 cache:', (await session.sendTurn('And prefix reuse?')).cache);

  // A later turn whose entire prompt should hit the cache:
  const warm = await session.sendTurn('Summarize both answers in one line.');
  console.log('turn 3 cache:', warm.cache); // note hitRate: 1 when evaluatedTokens is 0

  console.log('cumulative:', session.cacheStats);
  console.log('history length:', session.getMessages().length);
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
