/**
 * Multi-host model-affinity routing (see src/providers/model-affinity-router.ts
 * and ADR 0028).
 *
 * A fleet of interchangeable Ollama daemons: opt into
 * `endpointHealth.modelAffinity` and each request prefers the host already
 * holding the model in VRAM (GET /api/ps, TTL-cached, zero added request
 * latency) — no forced unload/cold-load swaps on OLLAMA_MAX_LOADED_MODELS-
 * bounded hosts. Pre-warm at startup so even the first request routes by
 * residency.
 *
 *   npm run example examples/multi-host-affinity.ts
 */
import { OllamaClient } from '../src/index.js';

async function main() {
  const hosts = (
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : ['http://localhost:11434', 'http://localhost:11435']
  ).join(',');
  const urls = hosts
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

  const client = new OllamaClient({
    endpoints: urls.map((baseUrl, i) => ({ name: `host-${i + 1}`, baseUrl })),
    endpointHealth: {
      // Spread load across interchangeable hosts…
      strategy: 'least-connections',
      // …and prefer whichever host already holds the model in VRAM.
      modelAffinity: { ttlMs: 30_000, failureRetryMs: 5_000 },
    },
  });

  // 0. Liveness + fleet audit before doing anything else.
  const ping = await client.ping(); // HEAD / — single best host, no failover
  console.log(
    `best host ${ping.baseUrl}: ${ping.healthy ? `alive (${ping.latencyMs}ms)` : `DOWN (${ping.error})`}`,
  );
  const fleet = await client.healthCheck(); // every host, + version
  for (const h of fleet) {
    console.log(
      `  ${h.name.padEnd(10)} ${h.baseUrl} — ${h.reachable ? `v${h.version} (${h.latencyMs}ms)` : `unreachable: ${h.error}`}`,
    );
  }

  // 1. Pre-warm the residency cache so the FIRST request already routes
  //    to a host holding the model (otherwise it self-warms in the background
  //    during the first request).
  await client.warmModelAffinity();
  console.log('\nresidency snapshots:');
  for (const s of client.modelAffinityStatus()) {
    console.log(
      `  ${s.endpointName.padEnd(10)} ${s.baseUrl} — [${s.loadedModels.join(', ') || 'nothing loaded'}] (fresh: ${s.fresh})`,
    );
  }

  // 2. Requests now prefer the resident host — this one line is the feature.
  const model = 'llama3.2';
  console.log(`\nchat(${model}) → routed to the host holding it in VRAM`);
  const res = await client.chat({
    model,
    messages: [{ role: 'user', content: 'Say hello in one word.' }],
  });
  console.log(`reply: ${res.message.content?.trim()}`);

  // 3. Observability: snapshots update in the background (TTL-bounded).
  await client.warmModelAffinity();
  console.log('\nafter the request, residency is now:');
  for (const s of client.modelAffinityStatus()) {
    console.log(
      `  ${s.endpointName.padEnd(10)} [${s.loadedModels.join(', ') || 'nothing loaded'}]`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
