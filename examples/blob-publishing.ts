/**
 * Blob management & custom GGUF model publishing (see src/models-client.ts).
 *
 * Implements Ollama's documented import protocol: push a blob per file
 * (content-addressed by SHA-256), then POST /api/create with
 * files: { <fileName>: <digest> }.
 *
 *   npm run example examples/blob-publishing.ts /path/to/model.gguf my-model
 */
import { OllamaClient } from '../src/index.js';

async function main() {
  const [ggufPath, modelName] = process.argv.slice(2) as [string?, string?];
  if (ggufPath === undefined || modelName === undefined) {
    console.error('Usage: tsx examples/blob-publishing.ts <path-to.gguf> <model-name>');
    process.exitCode = 1;
    return;
  }

  const client = new OllamaClient();

  // 1. Digest + existence check + upload (skips the POST when already present).
  const upload = await client.models.createBlobFromFile(ggufPath);
  console.log(
    `uploaded: digest=${upload.digest} alreadyExisted=${upload.alreadyExisted} fileName=${upload.fileName}`,
  );

  // 2. Create the model from the uploaded blob.
  const created = await client.models.createModelFromGguf(modelName, ggufPath, {
    template: '{{ .Prompt }}',
  });
  console.log('created:', created.status);

  // 3. Ready to use — the new model is in the local catalog.
  const models = await client.listModels();
  console.log('catalog:', models.map((m) => m.name).join(', '));
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
