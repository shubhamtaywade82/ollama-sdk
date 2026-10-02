# ADR 0016: MCP Tool Generation from the IR

## Status

Accepted

## Context

ADR 0014 (Wave 3) added `src/generated/metadata/operations.json` — a single
JSON file containing every operation's full contract. ADR 0014 noted that
this metadata was "consumed by the MCP bridge (for tool description
generation)" but stopped short of actually generating the MCP tool
definitions. Wave 6 closes that loop.

Without Wave 6, anyone wanting to expose Ollama operations as MCP tools
must hand-write a tool definition per operation: name, description, input
schema (a JSON Schema derived from the OpenAPI request type), and MCP
annotations (read-only hint, destructive hint, etc.). Every time Ollama
adds or changes an operation, the MCP tool list drifts — the same class
of drift Waves 1-5 fixed for endpoints, types, runtime, and parity.

## Decision

Generate MCP tool descriptors directly from the canonical IR.

### Emitter

`generator/emitters/mcp/tools.ts` walks the IR's operations list and
produces one `McpToolDescriptor` per documented operation:

- **Name**: `ollama_<operationId>`. The `ollama_` prefix prevents collisions
  with other MCP servers the host may have registered.
- **Description**: Derived from the operation's path, method, domain, and
  notes. Each note becomes a `- `-prefixed bullet point.
- **Input schema**: When the operation has a `request` schema ref, the
  emitter resolves every `$ref` against the IR's `schemas` list and emits
  a self-contained JSON Schema. For operations without a request schema
  (GET/HEAD endpoints, `/api/blobs/{digest}`), the input schema is
  derived from the operation's structural parameters — path parameters
  become required string fields, parameterless operations get an empty
  object schema. The previous `{ prompt: string, additionalProperties:
  true }` fallback was removed in Wave 12 (P1 #5) because it fabricated
  a field the actual API doesn't accept. Wave 17 (P0) further excludes
  binary-body operations (e.g. `createBlob`) from MCP tool generation
  entirely — the JSON runtime cannot execute them, so advertising them
  as MCP tools would be misleading.
- **Annotations**: Inferred from the HTTP method — GET/HEAD = `readOnlyHint
  - idempotentHint`, DELETE = `destructiveHint`, all = `openWorldHint:
    false`. These hints let MCP hosts route tool calls more safely (e.g.
    auto-approving read-only tools, prompting before destructive ones).
- **`_operationId`**: A non-spec internal field that the runtime adapter
  uses to look up the `OperationDefinition` constant at call time.

### Output

`src/generated/mcp/tools.json` — a single JSON file containing the tool
list plus a `_comment` header. JSON (not TypeScript) so non-TypeScript
MCP hosts (Python, etc.) can consume the same descriptor file.

### Runtime adapter

`src/mcp/generated-bridge.ts` is the hand-written runtime glue that turns
the descriptor list into a callable tool registry:

- `listGeneratedOllamaTools()` returns `McpToolDescriptor[]` (without the
  internal `_operationId` field) for registration with `McpBridge`.
- `callGeneratedOllamaTool(runtime, name, args)` looks up the tool by
  name, finds its `OperationDefinition` constant in
  `src/generated/api/operations.ts`, and delegates to
  `OllamaRuntime.invoke({ operation, body: args })`. Errors are wrapped
  into an MCP-shaped `{ content: [{ type: 'text', text: ... }],
structuredContent: { error: ... } }` response so MCP clients always
  receive a well-formed result.

### Opt-in

The generated MCP tools are NOT auto-registered with `McpBridge`. Users
who want them import the adapter explicitly:

```ts
import { NativeApi, OllamaRuntime } from '@nemesis-oss/ollama-sdk';
import {
  listGeneratedOllamaTools,
  callGeneratedOllamaTool,
} from '@nemesis-oss/ollama-sdk/mcp/generated';

const runtime = new OllamaRuntime({ http });
const tools = listGeneratedOllamaTools();
// Register tools with your MCP server — the bridge's existing API
// still works for non-Ollama tools.
```

This is intentional: the existing `McpBridge` continues to work unchanged
for users who don't want generated tools.

## What changed

### Added

- `generator/emitters/mcp/tools.ts` — `emitMcpTools` + `buildToolDescriptors`
  - `McpToolDescriptor` interface + `$ref` resolver.
- `src/mcp/generated-bridge.ts` — `listGeneratedOllamaTools` +
  `callGeneratedOllamaTool` + `loadGeneratedOllamaTools`.
- `src/generated/mcp/tools.json` — committed generated artifact.
- `test/contract/mcp.test.ts` — 9 tests covering emitter output shape,
  naming convention, annotations, input schema, JSON Schema validity.
- `test/contract/mcp-bridge.test.ts` — 3 end-to-end tests covering tool
  listing, call delegation, unknown-tool error handling.
- ADR 0016 (this file).

### Updated

- `generator/cli.ts` — `cmdGenerate` now also invokes `emitMcpTools` and
  writes `src/generated/mcp/tools.json` alongside the other generated
  files. The `npm run contract:generate` script now produces 45 files
  (was 44).

## Consequences

- Adding a new Ollama operation to the overlays now automatically
  generates its MCP tool descriptor. There is no separate MCP tool
  registry to maintain — the IR is the single source of truth for
  endpoints, types, runtime wrappers, and MCP tools.
- The generated tools inherit every contract-layer guarantee:
  environment guards (local-only ops reject in cloud mode), version
  guards (ops requiring newer Ollama fail fast), streaming defaults
  (applied from the contract). The MCP caller doesn't need to know
  about these — they're enforced by `OllamaRuntime` before any HTTP
  call is made.
- Non-TypeScript MCP hosts (Python `mcp` SDK, etc.) can consume
  `tools.json` directly without depending on the TypeScript runtime —
  they just need to implement their own tool-call dispatcher that POSTs
  to the Ollama HTTP API using the descriptor's `inputSchema`. The
  `_operationId` field gives them a stable identifier to map to their
  own dispatcher.
- The generated tools cover every documented operation, including
  `ollama_systemOne`. The first run of `npm run contract:generate`
  produced 21 tools — every operation in the IR.
- `_operationId` is an intentionally non-spec field. It is NOT exposed
  via `listGeneratedOllamaTools()` (the public API strips it); it
  exists only in `tools.json` for hosts that need to map tool names
  back to operation ids.

## Reference

- ADR 0013 — Wave 1 contract foundation
- ADR 0014 — Waves 2+3 generated types + runtime seam
- ADR 0015 — Wave 5 field-level parity migration
