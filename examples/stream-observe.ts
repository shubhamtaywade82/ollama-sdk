/**
 * Zero-copy stream observation — stream to a UI while feeding an audit log
 * and a token counter, without ReadableStream.tee() (see ADR 0031).
 *
 * tee() branches share one upstream pull: a slow branch (a logger waiting
 * on a database write) forces every intermediate chunk to be queued in that
 * branch, throttles the fast branch through shared backpressure, and leaks
 * heap if the slow sink stalls. observeStream is single-pass: the primary
 * consumer below iterates at full speed while the (deliberately slow,
 * 10ms-per-chunk) audit sink drains on its own serialized chain.
 *
 *   npm run example examples/stream-observe.ts -- [model]
 */
import { OllamaClient, observeStream } from '../src/index.js';

async function main() {
  const model = process.argv[2] ?? 'llama3.2';

  const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
  const ping = await client.ping();
  if (!ping.healthy) {
    console.error(`Ollama is not reachable: ${ping.error ?? 'unknown error'}`);
    process.exit(1);
  }

  const stream = await client.chat({
    model,
    messages: [{ role: 'user', content: 'Explain speculative decoding in exactly two sentences.' }],
    stream: true,
  });

  // --- the multi-sink wiring this example exists to show -------------------
  const auditLog: string[] = [];
  let auditTokens = 0;
  let auditDone = false;

  const observed = observeStream(stream, {
    // Async on purpose: simulate a slow sink (10ms per write). The consumer
    // below still finishes at full speed — the sink throttles only itself.
    onChunk: async (event) => {
      if (event.type === 'token') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        auditLog.push(event.data.delta);
        auditTokens += 1;
        process.stdout.write(`.`);
      }
    },
    // Fires only after the last chunk's sink write has settled.
    onDone: () => {
      auditDone = true;
    },
    // Fires when the consumer breaks early — not in this run, but wired so
    // the audit trail can be marked incomplete instead of silently short.
    onAbandon: () => {
      auditLog.push('\n[abandoned by consumer]');
    },
    // The observation failure channel: a logging bug can never poison the
    // pipeline or surface as an unhandled rejection.
    onListenerError: (err, phase) => {
      console.error(`\naudit sink error (${phase}):`, err);
    },
  });

  // --- the primary consumer — full speed, full order -----------------------
  const rendered: string[] = [];
  let consumedTokens = 0;
  for await (const event of observed) {
    if (event.type === 'token') {
      rendered.push(event.data.delta);
      consumedTokens += 1;
    }
  }

  // Wait for the deliberately-slow audit sink to finish draining — it lags
  // the consumer by design (that's the whole point), so poll its done
  // marker instead of guessing a fixed delay.
  const drainDeadline = Date.now() + 10_000;
  while (!auditDone && Date.now() < drainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  console.log('\n--- primary consumer (real-time render) ---');
  console.log(rendered.join(''));
  console.log(`\n--- auxiliary sinks ---`);
  console.log(`tokens seen by consumer: ${consumedTokens}`);
  console.log(`tokens seen by audit log: ${auditTokens} (flushed after drain: ${auditDone})`);
  console.log(`audit log content matches render: ${auditLog.join('') === rendered.join('')}`);
}

void main();
