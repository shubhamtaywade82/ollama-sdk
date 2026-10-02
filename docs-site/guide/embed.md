---
outline: [2, 3]
---

# Embeddings

The embed API (`POST /api/embed`) generates dense vector representations of text — the building block for retrieval-augmented generation (RAG), semantic search, clustering, and classification. This guide covers batch embedding, similarity, truncation, and choosing models.

## Single input

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient();

const { embeddings } = await client.embed({
  model: 'nomic-embed-text:latest',
  input: 'Production-grade TypeScript SDK for Ollama',
});

console.log(embeddings[0]); // number[] of length 768 (model-dependent)
console.log(`Dimensions: ${embeddings[0].length}`);
```

## Batch input

`input` accepts an array — Ollama processes the batch in a single round-trip:

```typescript
const { embeddings, totalDuration, loadDuration } = await client.embed({
  model: 'nomic-embed-text:latest',
  input: [
    'Machine learning and neural networks',
    'Artificial intelligence algorithms',
    'Baking traditional French sourdough bread',
  ],
});

console.log(`Generated ${embeddings.length} vectors, ${embeddings[0].length} dimensions each`);
```

### `embedText` shortcut

If you only need the vectors:

```typescript
const [vec] = await client.embedText('nomic-embed-text:latest', 'Hello, world.');
const [a, b] = await client.embedText('nomic-embed-text:latest', ['First doc.', 'Second doc.']);
```

## Cosine similarity

Ollama doesn't return a similarity endpoint — compute it client-side from the vectors. The SDK doesn't ship a vector math library (to stay zero-dep), so a 5-line cosine function is all you need:

```typescript
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! ** 2;
    normB += b[i]! ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const query = 'TypeScript SDK for LLMs';
const docs = [
  'A production-grade Ollama SDK in TypeScript',
  'How to bake sourdough bread at home',
  'Running local LLMs with Ollama',
];

const [qVec, ...docVecs] = await client.embedText('nomic-embed-text:latest', [query, ...docs]);
const ranked = docs
  .map((doc, i) => ({ doc, score: cosine(qVec!, docVecs[i]!) }))
  .sort((a, b) => b.score - a.score);

console.log(ranked);
// [{ doc: 'A production-grade Ollama SDK in TypeScript', score: 0.78 }, ...]
```

## Building a RAG index

A minimal in-memory RAG index — no external vector database required for prototyping:

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient();
const MODEL = 'nomic-embed-text:latest';

interface Doc {
  id: string;
  text: string;
  vec: number[];
}

class InMemoryIndex {
  private docs: Doc[] = [];

  async add(texts: string[]): Promise<void> {
    const vectors = await client.embedText(MODEL, texts);
    for (let i = 0; i < texts.length; i++) {
      this.docs.push({ id: `doc-${this.docs.length}`, text: texts[i]!, vec: vectors[i]! });
    }
  }

  async search(query: string, k = 3): Promise<{ doc: Doc; score: number }[]> {
    const [qVec] = await client.embedText(MODEL, query);
    return this.docs
      .map((doc) => ({ doc, score: cosine(qVec!, doc.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

const index = new InMemoryIndex();
await index.add([
  'The Ollama SDK supports multi-endpoint failover with circuit breakers.',
  'Agents loop until the model responds without requesting further tool calls.',
  'System One exposes typed choice, noul, and score questions.',
]);

const hits = await index.search('How does the SDK handle failures?');
console.log(hits[0]?.doc.text);
// 'The Ollama SDK supports multi-endpoint failover with circuit breakers.'
```

## Choosing a model

| Model                         | Dimensions | Notes                                                       |
| ----------------------------- | ---------- | ----------------------------------------------------------- |
| `nomic-embed-text:latest`     | 768        | Strong general-purpose embedding model. Recommended default. |
| `mxbai-embed-large:latest`    | 1024       | Higher accuracy on retrieval benchmarks, more memory.       |
| `all-minilm:latest`           | 384        | Smaller and faster; fine for prototyping.                   |
| `snowflake-arctic-embed2:latest` | 1024    | Multilingual support.                                       |

Pull with `ollama pull <name>` and check dimensions with:

```typescript
const info = await client.showModel({ model: 'nomic-embed-text:latest' });
console.log(info.model_info); // includes embedding dimensions
```

## Truncation and dimensions

Ollama supports per-request `truncate` (drop tokens that exceed the model's context) and, for some models, `dimensions` (Matryoshka truncation to a smaller vector):

```typescript
const { embeddings } = await client.embed({
  model: 'nomic-embed-text:latest',
  input: 'A very long document that exceeds the model context window...',
  truncate: true, // default: true
  // dimensions: 256, // Matryoshka — only supported by some models
});
```

`truncate: false` throws a server error if the input exceeds the model's context window.

## Legacy `/api/embeddings` (deprecated)

The older single-prompt endpoint is available as `client.embeddings()` for backward compatibility:

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient();

// @deprecated — prefer client.embed()
const { embedding } = await client.embeddings({
  model: 'nomic-embed-text:latest',
  prompt: 'legacy single-prompt embedding',
});
```

New code should use `embed()` — it supports batch input, `truncate`, and `dimensions`, all of which the legacy endpoint lacks.

## Edge runtime

`embed` is fully Edge-runtime safe — no Node APIs, native `fetch` only. Use it directly in Cloudflare Workers or Vercel Edge:

```typescript
// A Cloudflare Worker that returns embeddings
export default {
  async fetch(req: Request): Promise<Response> {
    const { text } = await req.json() as { text: string };
    const client = new OllamaClient({ baseUrl: 'https://my-ollama.example.com' });
    const [vec] = await client.embedText('nomic-embed-text:latest', text);
    return Response.json({ embedding: vec });
  },
};
```

## Failover and model-scoped routing

`embed` participates in [multi-endpoint failover](./failover) just like `chat` and `generate`. A common pattern is to scope an embedding model to a specific endpoint:

```typescript
const client = new OllamaClient({
  endpoints: [
    { name: 'local-llm', baseUrl: 'http://localhost:11434', models: ['qwen3:8b'] },
    {
      name: 'cloud-embeddings',
      baseUrl: 'https://ollama.com',
      apiKey: process.env.OLLAMA_API_KEY!,
      models: ['nomic-embed-text:latest'],
    },
  ],
});

// Routes to 'cloud-embeddings' automatically:
await client.embed({ model: 'nomic-embed-text:latest', input: '...' });
```

## Next steps

- **[Chat](./chat)** — feed retrieved documents into a chat turn
- **[Failover & Routing](./failover)** — model-scoped endpoint routing
- **[Structured Output](./structured-output)** — typed responses for classification pipelines
- **[Agents & Tool Calling](./agents)** — let the model call a vector search as a tool
