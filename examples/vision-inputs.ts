/**
 * Vision ingestion — the universal asset resolver (see src/vision.ts and ADR 0041).
 *
 * Run against a local Ollama server (vision model, e.g. `ollama pull llava`):
 *   npm run example examples/vision-inputs.ts
 */
import { OllamaClient, resolveImageInput } from '../src/index.js';

async function main() {
  // The imageResolution policy governs URL fetches, data URIs, and file
  // paths: byte caps, a fetch timeout, a redirect cap, a host allowlist,
  // and an SSRF guard that refuses private/reserved targets by default
  // (ADR 0041). Untrusted image input fails closed.
  const client = new OllamaClient({
    imageResolution: {
      allowedImageHosts: ['upload.wikimedia.org', '*.wikimedia.org'],
      maxImageBytes: 20 * 1024 * 1024,
      fetchTimeoutMs: 15_000,
    },
  });

  // Standalone resolver: every polymorphic form -> raw base64.
  const fromDataUri = await resolveImageInput('data:image/png;base64,aGVsbG8=');
  console.log('data URI resolved:', fromDataUri); // "aGVsbG8=" — header stripped

  const fromBytes = await resolveImageInput(new TextEncoder().encode('raw bytes'));
  console.log('bytes resolved:', fromBytes.slice(0, 16) + '…');

  // In the request pipeline: pass URLs, file paths, data URIs, or bytes —
  // chat()/generate() normalize everything before it reaches the wire.
  // Remote fetches use this client's configured fetch and the policy above:
  // a redirect to another host, an oversized body, or a private target all
  // fail with a clear error instead of silently happening.
  const answer = await client.chatText({
    model: 'llava',
    messages: [
      {
        role: 'user',
        content: 'What is in this image? Answer in one short sentence.',
        // Swap in any of: './photo.jpg' | 'data:image/png;base64,…' | Buffer | Uint8Array
        images: [
          'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png',
        ],
      },
    ],
  });
  console.log('Vision answer:', answer);
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
