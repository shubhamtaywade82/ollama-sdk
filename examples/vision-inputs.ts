/**
 * Vision ingestion — the universal asset resolver (see src/vision.ts).
 *
 * Run against a local Ollama server (vision model, e.g. `ollama pull llava`):
 *   npm run example examples/vision-inputs.ts
 */
import { OllamaClient, resolveImageInput } from '../src/index.js';

async function main() {
  const client = new OllamaClient();

  // Standalone resolver: every polymorphic form -> raw base64.
  const fromDataUri = await resolveImageInput('data:image/png;base64,aGVsbG8=');
  console.log('data URI resolved:', fromDataUri); // "aGVsbG8=" — header stripped

  const fromBytes = await resolveImageInput(new TextEncoder().encode('raw bytes'));
  console.log('bytes resolved:', fromBytes.slice(0, 16) + '…');

  // In the request pipeline: pass URLs, file paths, data URIs, or bytes —
  // chat()/generate() normalize everything before it reaches the wire.
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
