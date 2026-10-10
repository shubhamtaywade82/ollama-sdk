/**
 * Multi-host model-affinity routing (see src/providers/model-affinity-router.ts
 * and ADR 0028), plus the HEAD / liveness ping.
 *
 * With several interchangeable Ollama hosts, requests prefer the host whose
 * GET /api/ps shows the model already resident, avoiding a cold-load swap.
 * Reordering is cache-only: requests never wait for a probe.
 *
 *   OLLAMA_HOSTS=http://gpu-a:11434,http://gpu-b:11434 npm run example examples/multi-host-affinity.ts
 */
import { OllamaClient } from '../src/index.js';

async function main() {
  const hosts = (process.env.OLLAMA_HOSTS ?? 'http://localhost:11434')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const model = process.env.OLLAMA_MODEL ?? 'llama3.2';

  const client = new OllamaClient({
    endpoints: hosts.map((baseUrl, i) => ({ name: `host-${i + 1}`, baseUrl })),
    endpointHealth: {
      strategy: 'least-connections',
      modelAffinity: { ttlMs: 30_000 },
    },
  });

  // Single-host liveness (HEAD /): resolves, never throws on an unhealthy host.
  console.log('ping:', await client.ping());

  // Pre-warm the residency cache so even the first request is routed by affinity.
  await client.warmModelAffinity();
  for (const s of client.modelAffinityStatus()) {
    console.log(
      `${s.endpointName} (${s.baseUrl}) fresh=${s.fresh} loaded=[${s.loadedModels.join(', ')}]`,
    );
  }

  const res = await client.chat({ model, messages: [{ role: 'user', content: 'Say hi.' }] });
  console.log('reply:', res.message.content);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
