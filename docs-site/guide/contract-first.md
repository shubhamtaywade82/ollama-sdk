---
outline: [2, 3]
---

# Contract-First Architecture

Starting with v1.4.0, the SDK ships a **contract-first hybrid architecture**: a single canonical Intermediate Representation (IR) at `contracts/ir/ollama.ir.json` drives seven consumers — TypeScript interfaces, generated API classes, MCP tool descriptors, operation metadata, field-level parity blocks, Zod schemas, and bidirectional endpoint discovery. New Ollama endpoints (like `/v1/systemone`) are caught automatically.

This page walks through the pipeline, why it exists, and how to use the generated surface alongside the hand-written `OllamaClient`.

## Why contract-first

Before v1.4.0, the SDK had a hand-written `OllamaClient` with hand-written types in `src/types.ts`. Three problems kept recurring:

1. **Drift between types and reality** — a field added to `src/types.ts` wasn't necessarily in the OpenAPI spec, and vice versa. Documentation parity was enforced manually.
2. **No machine-readable source of truth** — the OpenAPI spec was a snapshot, not a build input. Adding System One required hand-writing every type, schema, and API method.
3. **No way to generate MCP tools** — MCP tool descriptors had to be written by hand and kept in sync with the API surface.

The contract-first architecture solves all three by making the IR the single source of truth. Every consumer — TypeScript types, API classes, MCP tools, Zod schemas, parity blocks — is generated from the IR by `npm run contract:generate`. The IR itself is compiled from the upstream OpenAPI spec + hand-maintained behavioral overlays.

## The pipeline

```
contracts/sources/           Upstream OpenAPI snapshot (fetched by `npm run contract:fetch`)
       │
       ▼
contracts/overlays/          Hand-maintained behavioral overlays:
       │                       - native.yaml      (Ollama-native behavior)
       │                       - openai.yaml      (OpenAI compat behavior)
       │                       - anthropic.yaml   (Anthropic compat behavior)
       │                       - systemone.yaml   (System One decision layer)
       │                       - web.yaml         (hosted web tools)
       ▼
contracts/ir/ollama.ir.json  Canonical IR — the single source of truth
       │
       ├─► src/generated/models/<name>.ts         TypeScript interfaces (36 schemas)
       ├─► src/generated/models/<name>.schema.ts  Paired Zod schemas
       ├─► src/generated/api/<domain>-api.ts      Generated API classes (NativeApi, OpenAIApi, AnthropicApi)
       ├─► src/generated/mcp/tools.json           MCP tool descriptors (21 tools)
       ├─► src/generated/metadata/operations.json Operation metadata
       └─► overlay `parity:` blocks               Field-level parity verification
```

### Maintenance commands

| Command                          | What it does                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `npm run contract:fetch`         | Re-pull the upstream OpenAPI spec into `contracts/sources/`.                                                                        |
| `npm run contract:normalize`     | Compile sources + overlays → `contracts/ir/ollama.ir.json`.                                                                         |
| `npm run contract:validate`      | Run schema + compatibility + bidirectional endpoint discovery validators.                                                          |
| `npm run contract:diff`          | Fail if the committed IR is stale (CI gate).                                                                                        |
| `npm run contract:generate`      | Regenerate every TypeScript / Zod / MCP artifact from the IR (idempotent).                                                          |
| `npm run contract:drift`         | Print drift report between generated types and `src/types.ts` (pass `--strict` to fail CI on unexpected drift).                     |
| `npm run verify:contract-parity` | Verify parity blocks against `src/types.ts` (structural) and `docs.ollama.com` (live-docs); pass `--skip-live-docs` for offline CI. |

## Using the generated `NativeApi` (recommended for new code)

The generated surface is opt-in — existing `OllamaClient` callers don't need to change anything. For new code, the generated API inherits every contract-layer guarantee (environment guards, version guards, streaming defaults) automatically:

```typescript
import { HttpClient } from '@nemesis-oss/ollama-sdk';
import { OllamaRuntime } from '@nemesis-oss/ollama-sdk/generated/runtime';
import { NativeApi } from '@nemesis-oss/ollama-sdk/generated/api';

const http = new HttpClient({ baseUrl: 'http://localhost:11434' });
const runtime = new OllamaRuntime({ http });
const api = new NativeApi(runtime);

// Non-streaming chat — note `stream: false` is explicit (streaming defaults to true
// on operations whose IR declares streaming as the default).
const res = await api.chat({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: false,
});

// Streaming chat — explicitly request a stream:
const stream = await api.chat({
  model: 'qwen3:8b',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
});
for await (const chunk of stream) {
  console.log(chunk.message?.content);
}
```

`NativeApi` exposes every documented Ollama operation: `chat`, `generate`, `embed`, `tags` (list models), `show`, `create`, `copy`, `delete`, `pull`, `push`, `ps`, `version`, `blobs`, and `systemOne`.

### NativeApi methods

```typescript
class NativeApi {
  blobs(digest: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  chat(request: ChatRequest & { stream?: false }): Promise<ChatResponse>;
  chat(request: ChatRequest & { stream: true }): Promise<AsyncGenerator<ChatResponse, void, undefined>>;
  copy(request: CopyRequest): Promise<unknown>;
  create(request: CreateRequest & { stream?: false }): Promise<StatusResponse>;
  create(request: CreateRequest & { stream: true }): Promise<AsyncGenerator<StatusResponse, void, undefined>>;
  delete(request: DeleteRequest): Promise<unknown>;
  embed(request: EmbedRequest): Promise<EmbedResponse>;
  generate(request: GenerateRequest & { stream?: false }): Promise<GenerateResponse>;
  generate(request: GenerateRequest & { stream: true }): Promise<AsyncGenerator<GenerateResponse, void, undefined>>;
  ps(): Promise<PsResponse>;
  pull(request: PullRequest & { stream?: false }): Promise<StatusResponse>;
  pull(request: PullRequest & { stream: true }): Promise<AsyncGenerator<StatusResponse, void, undefined>>;
  push(request: PushRequest & { stream?: false }): Promise<StatusResponse>;
  push(request: PushRequest & { stream: true }): Promise<AsyncGenerator<StatusResponse, void, undefined>>;
  show(request: ShowRequest): Promise<ShowResponse>;
  systemOne(request: SystemOneRequest): Promise<SystemOneResponse>;
  tags(): Promise<ListResponse>;
  version(): Promise<VersionResponse>;
}
```

Every method delegates to `OllamaRuntime.invoke`, which handles method/path resolution, streaming defaults, environment guards (rejecting cloud calls for local-only operations), version constraints, and Zod validation (when opted in).

## Mixing the legacy client with the generated surface

`OllamaClient.runtime` returns a cached `OllamaRuntime` that shares the client's transport (HttpClient + middleware + retry + telemetry + failover), so you can mix both surfaces in the same process without configuring two HttpClient instances:

```typescript
import { OllamaClient } from '@nemesis-oss/ollama-sdk';
import { NativeApi } from '@nemesis-oss/ollama-sdk/generated/api';

const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });

// Existing API — still works, no breaking changes:
const res = await client.chat({ model: 'qwen3:8b', messages });

// Generated API — shares transport, failover, retry, telemetry:
const api = new NativeApi(client.runtime);
const res2 = await api.chat({ model: 'qwen3:8b', messages, stream: false });
```

`OllamaClient` carries a deprecation notice pointing to `NativeApi` for new code, but **no method signatures have changed** — existing callers continue to work indefinitely. New operations will land on the generated surface first; `OllamaClient` will receive them only as a follow-up.

## Runtime validation with generated Zod schemas

Every TypeScript interface in `src/generated/models/<name>.ts` has a paired Zod schema in `src/generated/models/<name>.schema.ts`. Two ways to use them:

### Per-call validation

```typescript
import { ChatRequestSchema } from '@nemesis-oss/ollama-sdk/generated/models/schemas';

const result = ChatRequestSchema.safeParse(userInput);
if (!result.success) {
  console.error(result.error.issues);
} else {
  // result.data is typed as ChatRequest — safe to send.
  await api.chat(result.data);
}
```

### Runtime-wide validation

Opt in once on the runtime constructor and every request body is validated automatically before the HTTP call:

```typescript
import { OllamaRuntime } from '@nemesis-oss/ollama-sdk/generated/runtime';

const runtime = new OllamaRuntime({ http, validateRequests: true });
// Every chat/generate/embed/create/copy/delete/pull/push/show request
// is now validated against the IR-derived Zod schema. Malformed requests
// throw OllamaRequestValidationError BEFORE any network call is made.
// Unknown fields are stripped (Zod default), so callers can't accidentally
// send extra fields the contract doesn't allow.
```

Response validation is opt-in separately (`validateResponses: true`) — see [ADR 0020](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0020-runtime-zod-validation.md) for why it's not on by default (forward-compat with wire-format extensions).

When validation fails, the runtime throws `OllamaRequestValidationError` (or `OllamaResponseValidationError`) — an `OllamaClientError` subclass with `code: 'request_validation_error'`, `retryable: false`, and the Zod issues array attached.

## Generated MCP tools

The IR also produces 21 MCP tool descriptors (one per documented Ollama operation) at `src/generated/mcp/tools.json`. The runtime adapter at `@nemesis-oss/ollama-sdk/mcp/generated` exposes them as a callable tool registry — letting any MCP-compatible host drive an Ollama server without writing tool glue:

```typescript
import { OllamaRuntime } from '@nemesis-oss/ollama-sdk/generated/runtime';
import { HttpClient } from '@nemesis-oss/ollama-sdk';
import {
  listGeneratedOllamaTools,
  callGeneratedOllamaTool,
} from '@nemesis-oss/ollama-sdk/mcp/generated';

const http = new HttpClient({ baseUrl: 'http://localhost:11434' });
const runtime = new OllamaRuntime({ http });

const tools = listGeneratedOllamaTools();
// tools: [{ name: 'ollama_chat', inputSchema: {...}, annotations: {...} }, ...]

const result = await callGeneratedOllamaTool(runtime, 'ollama_version', {});
console.log(result.structuredContent); // { version: '0.5.0' }
```

Each tool's `inputSchema` is generated from the IR's request schema, and `callGeneratedOllamaTool` validates arguments before invoking the runtime. See [ADR 0016](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0016-mcp-tool-generation.md) for the design.

## Contract parity verification

`npm run verify:contract-parity` checks the canonical IR against the official Ollama documentation in two halves:

1. **Structural** — every `parity.request.fields` / `parity.response.fields` entry exists on the hand-written TypeScript interfaces in `src/types.ts` and `src/integrations/*`.
2. **Live-docs** (when run without `--skip-live-docs`) — fetches the rendered docs at `docs.ollama.com` and asserts each supported field is documented as supported, each unsupported field is explicitly marked as such, and each streaming event type is present.

The gate covers every documented native REST endpoint (`chat`, `generate`, `embed`, `tags`, `ps`, `show`, `create`, `copy`, `pull`, `push`, `delete`, and `version`) plus the OpenAI and Anthropic compatibility request surfaces. SDK-only fields that exist in `src/types.ts` but are absent from the OpenAPI snapshot are declared as `sdkOnlyFields` in the overlay parity blocks and treated as expected drift, not findings.

### Strict request types

For callers who want compile-time enforcement of the documented Ollama subset, the package also exports strict request types:

- `OllamaOpenAIChatCompletionRequest` — `OpenAIChatCompletionRequest` minus fields Ollama ignores.
- `OllamaOpenAIResponsesRequest`
- `OllamaOpenAIEmbeddingRequest`
- `OllamaAnthropicMessagesRequest`

The broader compatibility request types remain available for pass-through interoperability and vendor-specific fields.

## Bidirectional endpoint discovery

The IR catches new Ollama endpoints that the OpenAPI spec doesn't yet cover. When Ollama shipped `/v1/systemone` (the System One decision layer) without an OpenAPI entry, the SDK's `contract:validate` step flagged the gap via **bidirectional endpoint discovery**:

1. **Forward** — every operation in the IR must exist in the OpenAPI spec (or be declared as `sdkOnly` in the overlay).
2. **Backward** — every documented endpoint on `docs.ollama.com` must exist in the IR.

The systemone overlay declares `/v1/systemone` as an `sdkOnly` operation with its full request/response schemas, and `contract:normalize` merges it into the IR alongside the OpenAPI-derived operations.

## Drift detection

`npm run contract:drift` prints a report showing differences between the generated types and the hand-written `src/types.ts`. Pass `--strict` to fail CI on unexpected drift:

```bash
$ npm run contract:drift -- --strict
✓ ChatRequest: 12 fields, 0 drift
✓ GenerateRequest: 8 fields, 0 drift
⚠ EmbedRequest: 2 sdkOnly fields (truncate, dimensions) — declared in overlay
✗ EmbeddingsRequest: 1 missing field (prompt) — re-run contract:generate
```

The `sdkOnlyFields` mechanism is the escape hatch for SDK-local conveniences (like `signal` and `timeoutMs` on every request) that aren't in the OpenAPI spec but are part of the SDK's typed surface.

## The ADR series

The contract-first architecture is documented across nine ADRs — see the [ADR index](../adr/) for the full list. The most important ones:

- **[ADR 0013: Contract-First Hybrid Architecture](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0013-contract-first-architecture.md)** — why a single canonical IR.
- **[ADR 0014: Generated Surface and Runtime Seam](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0014-generated-surface-and-runtime-seam.md)** — the `OllamaRuntime` design.
- **[ADR 0016: MCP Tool Generation from the IR](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0016-mcp-tool-generation.md)** — how 21 MCP tools are generated.
- **[ADR 0018: Runtime Unification](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0018-runtime-unification.md)** — the `OllamaClient.runtime` bridge.
- **[ADR 0019: Zod Schema Generation](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0019-zod-schema-generation.md)** — paired Zod schemas.
- **[ADR 0020: Runtime Zod Validation](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0020-runtime-zod-validation.md)** — opt-in request/response validation.
- **[ADR 0021: Conformance Testing](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0021-conformance-testing.md)** — testing against a real Ollama server.

## Next steps

- **[API Reference: NativeApi](../api/native-api)** — full method list.
- **[System One Decisions](./system-one)** — the decision layer that motivated the IR overlay system.
- **[MCP Integration](./mcp)** — generated MCP tools and the `McpBridge`.
- **[ADR Index](../adr/)** — every architecture decision record.
