# ADR 0014: Generated Surface and Runtime Seam

## Status

Accepted

## Context

ADR 0013 introduced the contract-first hybrid architecture: a canonical IR
(`contracts/ir/ollama.ir.json`) compiled from upstream OpenAPI + behavioral
overlays, with bidirectional endpoint discovery enforced in CI. Wave 1 left
the runtime (`OllamaClient`, `HttpClient`, streaming, retry, telemetry,
agent, MCP) completely untouched.

Wave 2 and Wave 3 now ask two further questions:

1. **Wave 2** — Can the canonical IR drive TypeScript type generation, so
   the SDK no longer maintains a parallel hand-written type surface in
   `src/types.ts` that drifts silently from the OpenAPI spec?

2. **Wave 3** — Can the IR drive generated API classes (`NativeApi`,
   `OpenAIApi`, `AnthropicApi`) that delegate to a runtime seam, so the
   generated code owns "what Ollama exposes" and the runtime owns "how the
   SDK behaves around it"?

Both questions exist because the existing hand-written surface has a
structural problem the parity verifier cannot solve: every property added
to `src/types.ts` is a manual decision, and every property removed from
the OpenAPI spec is invisible until someone notices. The contract system
makes both directions visible — but only if the IR feeds back into actual
generated code.

## Decision

### Wave 2 — Generated TypeScript types

Add a TypeScript emitter that consumes the IR's `schemas` list (which now
carries full JSON Schema definitions, not just names) and produces one
file per schema in `src/generated/models/<Name>.ts`. The emitter handles:

- `$ref` resolution via cross-file `import type { ... } from './index.js'`
- `oneOf` / `anyOf` → TypeScript union
- `allOf` → TypeScript intersection
- `enum` → string-literal union
- `additionalProperties: true` → `Record<string, unknown>`
- Optional fields → `T | undefined` (matching `exactOptionalPropertyTypes`)
- All properties emitted as `readonly` (mirrors the existing `src/types.ts`
  convention)

The generated models are NOT yet wired into the runtime — they live in
`src/generated/models/` as a parallel surface. A drift detector
(`generator/emitters/typescript/drift-detector.ts`) compares the generated
property sets against `src/types.ts` and reports `added` / `removed` /
`matched` per schema. The detector is informational in Wave 2 (it surfaces
drift but does not fail CI); a future wave will make it a hard gate once
the migration is complete.

### Wave 3 — Generated API classes + runtime seam

Add three more emitters:

1. **Operation definitions** (`src/generated/api/operations.ts`) — one
   `OperationDefinition` constant per IR operation, typed `as const
satisfies OperationDefinition`. Each constant captures the full contract:
   method, path, transport mode, streaming default, environment support,
   capability support, version constraints, status. The constant names use
   an `Op` suffix (e.g. `deleteOp`) to avoid collisions with reserved words.

2. **API classes** (`src/generated/api/<domain>-api.ts`) — one class per
   contract domain: `NativeApi`, `OpenAIApi`, `AnthropicApi`. Each method
   delegates to `OllamaRuntime.invoke({ operation: <opConst>, body: request })`.
   Streaming operations get two overloads (explicit `stream: true` returns
   `AsyncGenerator<T>`, everything else returns `Promise<T>`). GET/HEAD
   operations take an optional `{ signal?: AbortSignal }` instead of a
   request body.

3. **Metadata** (`src/generated/metadata/operations.json`) — a single JSON
   file containing every operation's full contract. Consumed by the runtime
   (for environment guards), the MCP bridge (for tool description
   generation), and the capability registry (for `contract.supports(...)`
   queries).

The runtime seam is a single hand-written file: `src/generated/runtime/runtime.ts`.
It exposes `OllamaRuntime.invoke(req)`, which:

- Asserts environment + version guards before any network call (rejecting
  local-only operations in cloud mode, rejecting operations whose
  `minOllamaVersion` exceeds the server's reported version).
- Applies the streaming default when the request body doesn't set `stream`
  explicitly.
- Delegates non-streaming calls to the existing `HttpClient.request()`
  (preserving retry, telemetry, middleware, error-mapping).
- Delegates streaming calls to a direct `fetch` + `parseNdjsonStream`
  (Wave 3 simplification — a follow-up will plumb a `raw: true` option
  through `HttpClient` so the runtime doesn't need its own fetch call).

`src/generated/runtime/operation-definition.ts` is the only other
hand-written file in `src/generated/`. It defines the
`OperationDefinition` type and `InvokeRequest` interface — the contract
the generated code expects the runtime to honor. The types are inlined
(not imported from `generator/types.ts`) so the shipped package doesn't
depend on the build-time `generator/` directory at runtime.

## What changed

New directories:

```
src/generated/
  models/                 # Wave 2: TypeScript interfaces from IR schemas
    ChatRequest.ts
    ChatResponse.ts
    GenerateRequest.ts
    ... (36 schemas total)
    index.ts              # barrel export
  api/                    # Wave 3: generated API classes
    operations.ts        # OperationDefinition constants
    native-api.ts        # NativeApi class (chat, generate, embed, ...)
    openai-api.ts        # OpenAIApi class (chatCompletions, ...)
    anthropic-api.ts     # AnthropicApi class (messages)
    index.ts
  runtime/                # Wave 3: hand-written seam (NOT generated)
    operation-definition.ts  # OperationDefinition, InvokeRequest types
    runtime.ts           # OllamaRuntime.invoke()
    index.ts
  metadata/               # Wave 3: contract metadata for non-TS consumers
    operations.json
```

New generator files:

```
generator/emitters/
  typescript/
    models.ts             # emitModels: IR schemas → TS interfaces
    operations.ts         # emitOperations: IR operations → const OperationDefinition
    api.ts                # emitApi: IR operations → NativeApi / OpenAIApi / AnthropicApi
    drift-detector.ts     # detectTypeDrift: generated vs src/types.ts
  metadata/
    metadata.ts           # emitMetadata: IR operations → operations.json
```

New npm scripts:

- `npm run contract:generate` — regenerate all of `src/generated/` from
  the IR (models + operations + api classes + metadata).
- `npm run contract:drift` — print the drift report. Pass `--strict` to
  exit non-zero on drift.

New tests:

- `test/contract/generated.test.ts` — 14 tests covering emitters,
  OperationDefinition shape, drift detector behavior.
- `test/contract/runtime-e2e.test.ts` — 5 tests exercising the generated
  `NativeApi` against a mock fetch (chat, embed, version, systemOne
  environment+version guards).

## What is explicitly NOT changed

- `src/types.ts`, `src/client.ts`, `src/transport/`, `src/streaming/`,
  `src/agent/`, `src/mcp/`, `src/tools/`, `src/capabilities/`,
  `src/integrations/`, `src/skills/`, `src/telemetry/`, `src/quota.ts` —
  all preserved verbatim. The generated surface is purely additive.
- `docs/api-parity.json` and `scripts/verify-api-parity.ts` — preserved.
  The legacy parity verifier and the new contract system continue to run
  side-by-side. `parityBridge` entries in the IR keep the two in sync.
- `tsconfig.json` `rootDir: "./src"` is preserved — `src/generated/` is
  inside `src/`, so it ships with the package. The `generator/` directory
  remains build-time-only and is excluded from the shipped bundle.

## Consequences

- The 19 drift findings the detector surfaced on first run are real: the
  hand-written `src/types.ts` carries fields the OpenAPI spec no longer
  documents (`GenerateResponse.context`, `GenerateResponse.image`,
  `CreateRequest.modelfile`, `ShowResponse.messages`,
  `ShowResponse.modelfile`, `ShowResponse.system`, etc.). These are
  candidates for either adding to the OpenAPI overlay (if Ollama still
  documents them elsewhere) or removing from `src/types.ts` (if they're
  vestigial). Each finding is a deliberate decision item.
- The generated `NativeApi` is a real, working alternative to the existing
  `OllamaClient`. Both can coexist; users opt into the generated surface
  by constructing `new NativeApi(new OllamaRuntime({ http }))`. The
  existing `OllamaClient` continues to be the documented entry point
  until Wave 4+ decides whether to deprecate it.
- The streaming runtime path currently uses a direct `fetch` rather than
  routing through `HttpClient`. This is acceptable for Wave 3 because the
  generated surface is opt-in, but it means generated streaming calls
  currently bypass the middleware/retry chain. A follow-up will plumb
  `raw: true` through `HttpClient` so the generated runtime inherits the
  full transport layer.
- The drift detector is informational, not a gate. Promoting it to a
  hard CI gate is deferred to a later wave once the migration of
  `src/types.ts` is complete.

## Reference

- ADR 0013 — Wave 1 contract foundation
- ADR 0010 — Legacy compatibility contract (preserved)
