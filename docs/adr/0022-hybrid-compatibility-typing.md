# ADR 0022: Contract-First Hybrid Compatibility Typing

## Status

Accepted (Wave 16)

## Context

The generated OpenAI and Anthropic compatibility API classes (`OpenAIApi`,
`AnthropicApi`) use rich hand-written types from `src/integrations/openai.ts`
and `src/integrations/anthropic.ts` rather than types derived from the
canonical IR's schema registry.

This is a **deliberate hybrid architecture**, not a contract-first failure.
The reason: the upstream Ollama OpenAPI snapshot does not yet define
request/response schemas for the compatibility endpoints (`/v1/chat/completions`,
`/v1/responses`, `/v1/messages`, etc.). It declares the paths and methods,
but not the request body or response body schemas.

Without IR schema refs, the generator's `schemaTypeFromRef()` fallback
produces `Record<string, unknown>` / `Promise<unknown>` — which was the
original Wave 12 problem.

## Decision

We use an explicit `COMPAT_TYPE_MAP` in `generator/emitters/typescript/api.ts`
that maps each compatibility operation id to `{ request, response, streamChunk }`
type names exported from `src/integrations/{openai,anthropic}.ts`.

This is **not generated from the IR** — it is a hand-maintained mapping.
The mapping is:

- **Explicit** — every entry is visible in the emitter source
- **Documented** — each entry carries a comment explaining why
- **Testable** — `test/contract/generated-compat-types.test.ts` pins every
  type assignment via compile-time `isAssignable<A, B>` checks
- **Migratable** — when the upstream OpenAPI eventually defines schemas for
  these operations, the `COMPAT_TYPE_MAP` can shrink and the generator can
  fall back to `schemaTypeFromRef()` for those operations

## Why not pure contract-first now?

The upstream Ollama OpenAPI does not contain the compatibility schemas.
We cannot generate types from schemas that don't exist. The hand-written
types in `src/integrations/` are the authoritative source for these
operations until upstream catches up.

## When to revisit

When the upstream Ollama OpenAPI adds request/response schemas for:
- `/v1/chat/completions`
- `/v1/completions`
- `/v1/embeddings`
- `/v1/models`
- `/v1/models/{model}`
- `/v1/responses`
- `/v1/messages`

At that point, remove the corresponding entries from `COMPAT_TYPE_MAP`
and let the generator use `schemaTypeFromRef()` instead. The test suite
will verify the generated types still pass the same `isAssignable` checks.

## Alternatives considered

1. **Inline the types in the overlay** — would require duplicating the
   rich OpenAI/Anthropic types as JSON Schema in `contracts/overlays/`,
   which is more work than the current approach and creates a second
   source of truth.

2. **Generate from a separate OpenAI/Anthropic OpenAPI snapshot** —
   would add a second OpenAPI source to the contract pipeline, increasing
   complexity. The current hybrid approach is simpler and the types are
   already correct.

3. **Leave as `Record<string, unknown>`** — rejected in Wave 12 (P0 #1).
   The whole point of the contract-first architecture is typed APIs.
