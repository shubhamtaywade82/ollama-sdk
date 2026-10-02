---
outline: [2, 3]
---

# Structured Output

Structured output lets you ask the model for a JSON response that conforms to a schema — and get back typed data instead of a raw string. The SDK supports both Zod schemas (recommended) and raw JSON Schema, via `chatWithSchema`, `generateWithSchema`, and the `format` option on `chat`/`generate`.

## With Zod (recommended)

Pass a Zod schema to `chatWithSchema` and get back typed data — the SDK handles JSON Schema conversion, sends the schema to Ollama via `format`, parses the response, and validates it:

```typescript
import { z } from 'zod';
import { OllamaClient } from '@nemesis-oss/ollama-sdk';

const client = new OllamaClient();

const SentimentSchema = z.object({
  label: z.enum(['positive', 'negative', 'neutral']),
  score: z.number().min(0).max(1),
  rationale: z.string(),
});

type Sentiment = z.infer<typeof SentimentSchema>;

const result: Sentiment = await client.chatWithSchema(
  {
    model: 'qwen3:8b',
    messages: [
      { role: 'user', content: 'Analyze: "This SDK is fantastic — clean API, great docs."' },
    ],
  },
  SentimentSchema,
);

console.log(result.label);    // 'positive'
console.log(result.score);    // 0.92
console.log(result.rationale); // 'The text uses strong positive words...'
```

### `generateWithSchema`

Same pattern for `generate`:

```typescript
const SummarySchema = z.object({
  title: z.string(),
  bullets: z.array(z.string()).min(2).max(5),
  keywords: z.array(z.string()),
});

const summary = await client.generateWithSchema(
  {
    model: 'qwen3:8b',
    prompt: 'Summarize the key ideas of REST APIs.',
    system: 'You are a technical writer.',
  },
  SummarySchema,
);
```

## How it works

Under the hood, `chatWithSchema(req, schema)` is equivalent to:

```typescript
const res = await client.chat({
  ...req,
  format: zodToJsonSchema(schema),
  stream: false,
});
return parseStructuredOutput(res.message.content, schema);
```

1. **`zodToJsonSchema(schema)`** — converts the Zod schema to a JSON Schema object. Uses Zod v4's native `z.toJSONSchema` when available, falling back to a structural walker for Zod v3.
2. **`format: { ...jsonSchema }`** — Ollama uses this to constrain the model's output to the schema at decode time (where supported) and validates the result.
3. **`parseStructuredOutput(content, schema)`** — extracts the JSON substring (handling markdown-wrapped ` ```json ... ``` ` blocks), parses it, and validates with `schema.safeParse`. Throws `OllamaToolValidationError` on parse or validation failure.

## Zod v3 and v4 dual support

The SDK auto-detects which Zod major you have installed:

- **Zod v4** — uses the native `z.toJSONSchema(schema)` for full JSON Schema fidelity (including `anyOf`, `$ref`, format strings, etc.).
- **Zod v3** — falls back to a structural walker that handles `ZodObject`, `ZodString`, `ZodNumber`, `ZodBoolean`, `ZodArray`, `ZodEnum`, `ZodNativeEnum`, `ZodLiteral`, `ZodOptional`, `ZodNullable`, `ZodDefault`, `ZodEffects`, `ZodUnion`, `ZodRecord`. Unknown types default to `{ type: 'object' }`.

Both major versions work as first-class peers — `zod` is a peer dependency (`^3.22.0 || ^4.0.0`).

## Supported Zod features

| Feature             | Zod v4 | Zod v3 (fallback)        |
| ------------------- | ------ | ------------------------ |
| `z.object`           | ✅     | ✅                        |
| `z.string`           | ✅     | ✅                        |
| `z.number`           | ✅     | ✅                        |
| `z.boolean`          | ✅     | ✅                        |
| `z.array`            | ✅     | ✅                        |
| `z.enum`             | ✅     | ✅                        |
| `z.nativeEnum`       | ✅     | ✅                        |
| `z.literal`          | ✅     | ✅                        |
| `z.optional`/`nullable`/`default` | ✅ | ✅              |
| `z.union`            | ✅     | ✅                        |
| `z.record`           | ✅     | ✅                        |
| `z.date`             | ✅     | ✅ (as `string` format)   |
| `z.discriminatedUnion` | ✅   | ⚠️ falls back to `object` |
| `z.transform`/`refine` (`z.effects`) | ✅ | ✅ (unwraps inner schema) |

For complex schemas (discriminated unions, conditional refinements), prefer Zod v4 for full JSON Schema fidelity.

## Raw JSON Schema

Skip Zod and pass a JSON Schema directly via `format`:

```typescript
const res = await client.chat({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Generate a fictional user profile.' }],
  format: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number', minimum: 18, maximum: 99 },
      email: { type: 'string', format: 'email' },
      roles: { type: 'array', items: { type: 'string', enum: ['admin', 'user', 'guest'] } },
    },
    required: ['name', 'age'],
  },
  stream: false,
});

const user = JSON.parse(res.message.content);
console.log(user);
```

The trade-off vs. Zod: you lose compile-time types on the parsed result. Prefer Zod unless you have a pre-existing JSON Schema you can't convert.

## `'json'` format

For unstructured JSON (any valid JSON object), pass `format: 'json'`:

```typescript
const res = await client.chat({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'List 3 TypeScript frameworks as JSON.' }],
  format: 'json',
  stream: false,
});

const data = JSON.parse(res.message.content);
```

This doesn't enforce a specific shape — the model is just told to produce valid JSON.

## Error handling

`parseStructuredOutput` throws `OllamaToolValidationError` (a subclass of `OllamaClientError`) when:

1. The response isn't valid JSON (after markdown stripping).
2. The JSON parses but fails Zod `safeParse` validation.

```typescript
import { OllamaToolValidationError } from '@nemesis-oss/ollama-sdk';

try {
  const result = await client.chatWithSchema(req, SentimentSchema);
} catch (err) {
  if (err instanceof OllamaToolValidationError) {
    console.error('Schema validation failed:', err.issues); // ZodIssue[]
    console.error('Tool:', err.toolName); // 'structured_output'
    // Retry with a clearer prompt, or fall back to unstructured parsing.
  }
}
```

The error carries the original Zod issues array (`err.issues`) so you can inspect which fields failed.

### Resilient markdown parsing

Models sometimes wrap JSON in markdown fences — ` ```json\n{...}\n``` ` — or prepend text like "Here's the result:". The SDK's `extractJsonSubstring` handles all three cases:

1. **Direct JSON** — `{"label": "positive"}` → unchanged.
2. **Markdown-wrapped** — ` ```json\n{...}\n``` ` → extracts the code block.
3. **JSON with leading/trailing prose** — `Here's the result: {...}.` → extracts the `{...}` substring via first-`{`-to-last-`}` slicing.

You don't need to pre-process the model's output — `chatWithSchema` handles it.

## Cloud limitation

::: warning Ollama Cloud doesn't support structured output
Structured output (`format` with a JSON Schema) is **rejected pre-flight** against Ollama Cloud endpoints with `OllamaUnsupportedCapabilityError`. The SDK infers the runtime mode (`local` vs `cloud`) from the `baseUrl` and throws before any network call.

In a multi-endpoint setup, `unsupported_capability` is in `DEFAULT_FAILOVER_CODES`, so the request fails over to the next candidate that supports it (typically your local endpoint). If every candidate is rejected, the error surfaces to your `catch` block.

```typescript
const client = new OllamaClient({
  endpoints: [
    { name: 'cloud', baseUrl: 'https://ollama.com', apiKey: process.env.OLLAMA_API_KEY! },
    { name: 'local', baseUrl: 'http://localhost:11434' },
  ],
});

// Tries 'cloud' → OllamaUnsupportedCapabilityError → fails over to 'local' → succeeds.
const result = await client.chatWithSchema(req, Schema);
```
:::

## Choosing between `chat` and `generate`

| Use `chatWithSchema`                          | Use `generateWithSchema`                       |
| --------------------------------------------- | ---------------------------------------------- |
| Multi-turn conversation with structured turn  | One-shot completion with structured output     |
| Tool calling + structured output in same turn | Prompt-template-driven workflows               |
| System prompt as a message role               | System prompt as a top-level `system` field    |
| FIM / suffix-based completion                 | When you want suffix-based completion          |

## Combining with tool calling

You can combine `tools` with `format` — the model produces either a tool call _or_ a structured response. This is useful for "decide between calling a tool or returning a structured answer" workflows:

```typescript
const res = await client.chat({
  model: 'qwen3:8b',
  messages,
  tools: registry.definitions(),
  format: zodToJsonSchema(SentimentSchema),
  stream: false,
});

if (res.message.tool_calls?.length) {
  // The model decided to call a tool instead.
  const results = await registry.executeToolCalls(res.message.tool_calls);
  // ... feed results back and continue
} else {
  // The model returned a structured response.
  const sentiment = parseStructuredOutput(res.message.content, SentimentSchema);
  console.log(sentiment.label);
}
```

::: tip Prefer `chatWithSchema` for pure structured output
If you're not using tools, `chatWithSchema` is simpler — it skips the tool-call branch entirely and returns the parsed result directly.
:::

## Validating requests and responses runtime-wide

For the generated `NativeApi` surface (see [Contract-First Architecture](./contract-first)), you can opt into runtime-wide Zod validation:

```typescript
import { HttpClient } from '@nemesis-oss/ollama-sdk';
import { OllamaRuntime } from '@nemesis-oss/ollama-sdk/generated/runtime';
import { NativeApi } from '@nemesis-oss/ollama-sdk/generated/api';

const http = new HttpClient({ baseUrl: 'http://localhost:11434' });
const runtime = new OllamaRuntime({
  http,
  validateRequests: true,    // validate every request body against the IR-derived Zod schema
  validateResponses: true,   // validate every response body too
});

const api = new NativeApi(runtime);
// Every api.chat(...) / api.generate(...) / api.embed(...) call is now validated.
// Malformed requests throw OllamaRequestValidationError BEFORE any network call.
// Mismatched responses throw OllamaResponseValidationError.
```

This is a separate validation layer from `chatWithSchema` — it validates the wire-format contract, not your application's schema. See [ADR 0020](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0020-runtime-zod-validation.md) for the rationale.

## Next steps

- **[Chat](./chat)** — the underlying `chat` API surface
- **[Generate](./generate)** — `generateWithSchema` and the `format` option
- **[Agents & Tool Calling](./agents)** — combining tools with structured responses
- **[Contract-First Architecture](./contract-first)** — how Zod schemas are generated from the canonical IR
- **[API Reference: Errors](../api/errors)** — `OllamaToolValidationError`, `OllamaRequestValidationError`, `OllamaResponseValidationError`
