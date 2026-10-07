/**
 * Context-window safety (see src/context-safety.ts) — guards against
 * Ollama's silent prompt truncation when num_ctx is unset.
 *
 *   npm run example examples/context-safety.ts
 */
import { OllamaClient, estimateTokens } from '../src/index.js';

async function main() {
  // Heuristic estimators, exported for ad-hoc use:
  console.log('English estimate:', estimateTokens('The quick brown fox jumps over the lazy dog.'));
  console.log('CJK estimate:', estimateTokens('你好世界，键值缓存前缀复用'));

  const client = new OllamaClient({
    // Makes the effective window explicit on every request that omits
    // options.num_ctx — injected as num_ctx on the wire.
    defaultContextLength: 8192,

    // 'warn' (default) logs and sends anyway; 'throw' rejects client-side.
    onContextOverflow: 'warn',
    debug: true, // route warnings to the console logger
  });

  // Comfortably inside the window — no warning.
  const ok = await client.chatText({
    model: 'qwen3:8b',
    messages: [{ role: 'user', content: 'Say "safe".' }],
  });
  console.log('in-window reply:', ok);

  // ~30k-char prompt (~7.5k estimated tokens) — under 8192 but watch the
  // warning fire when you shrink defaultContextLength below the estimate.
  const big = 'Explain caching. '.repeat(2000);
  const warn = await client.chatText({
    model: 'qwen3:8b',
    messages: [{ role: 'user', content: big.slice(0, 32_000) }],
  });
  console.log('large-prompt reply:', warn.slice(0, 80) + '…');
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
