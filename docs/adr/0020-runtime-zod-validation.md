# ADR 0020: Runtime Zod Validation Wiring

## Status

Accepted

## Context

ADR 0019 (Wave 9) added Zod schema generation — every TypeScript interface in
`src/generated/models/<name>.ts` has a paired Zod schema at
`src/generated/models/<name>.schema.ts`. The schemas ship in the published
package, but the runtime doesn't actually call them. Callers who want
validation have to do it themselves:

```ts
import { ChatRequestSchema } from '@nemesis-oss/ollama-sdk/generated/models/schemas';

const result = ChatRequestSchema.safeParse(userInput);
if (!result.success) {
  // handle error
}
await api.chat(result.data);
```

This is the right behavior for callers who want fine-grained control, but
it leaves the most common case (validate everything before sending) as
manual boilerplate. The contract-first architecture's promise was that
the IR drives both the types AND the runtime behavior — but runtime
validation was still opt-in via per-call `safeParse` calls.

## Decision

Wire Zod validation into `OllamaRuntime.invoke` as an opt-in feature.

### Opt-in flag

`OllamaRuntimeOptions.validateRequests?: boolean` — defaults to `false` to
preserve existing behavior (no perf cost for callers who don't want
validation). When `true`:

1. **Schema lookup**: the runtime consults a hand-written registry
   (`src/generated/runtime/schema-registry.ts`) that maps operationId →
   request schema. The registry imports the 9 native operations that
   have OpenAPI request schemas (`chat`, `generate`, `embed`, `create`,
   `copy`, `delete`, `pull`, `push`, `show`).

2. **Validation**: if a schema is registered for the operation,
   `safeParse(body)` runs BEFORE any HTTP request is made.

3. **On success**: the validated (and Zod-stripped) body replaces the
   original. This means unknown fields can't accidentally leak onto the
   wire — Zod's default behavior strips them.

4. **On failure**: throws `OllamaRequestValidationError` (a new
   `OllamaClientError` subclass with `code: 'request_validation_error'`,
   `retryable: false`). The error carries:
   - `operationId` — which operation failed validation
   - `issues` — the Zod issues array (path + message per issue)
   - `request` — the method + URL that would have been called

5. **Schema-missing operations**: if no schema is registered (e.g. GET
   endpoints, `/v1/systemone`, OpenAI/Anthropic compat surfaces),
   validation is silently skipped. The runtime doesn't fail — it just
   sends the body as-is.

### Why response validation is NOT enabled

Response validation would parse every response body against the operation's
response schema. This sounds good but is intentionally NOT done, for two
reasons:

1. **Forward compatibility**: Ollama may add new response fields between
   releases. A strict response schema would reject these as "unknown
   fields" (Zod's default behavior), breaking callers the moment Ollama
   ships an update. Request validation doesn't have this problem because
   the caller controls what they send.

2. **Wire-format extensions**: the IR's response schemas come from the
   OpenAPI spec, which doesn't capture every documented field (see
   the 19 `sdkOnlyFields` declared in the overlays). Strict response
   validation would reject responses containing these fields.

If a caller wants response validation, they can opt in per-call:

```ts
import { ChatResponseSchema } from '@nemesis-oss/ollama-sdk/generated/models/schemas';

const res = await api.chat({ ... });
const validated = ChatResponseSchema.parse(res);
```

### Why the schema registry is hand-written (not generated)

The IR has 36 schemas but only 9 are request bodies (the rest are
response types, stream events, or shared components). Generating the
registry would require the emitter to know which schemas are request
bodies — that information lives in the operation's `request.$ref`,
which the emitter currently doesn't propagate to a separate registry
file. The hand-written registry is small (9 entries) and changes only
when overlays add new operations, at which point the contract validator
should remind the maintainer to update it. A future wave may generate
this file directly from the IR.

## What changed

### Added

- `src/generated/runtime/schema-registry.ts` — hand-written map of
  operationId → request Zod schema. Covers 9 native operations.
- `src/errors.ts` — `OllamaRequestValidationError` class with
  `operationId`, `issues`, `code: 'request_validation_error'`,
  `retryable: false`.
- `src/generated/runtime/runtime.ts` — `validateRequests?: boolean`
  option on `OllamaRuntimeOptions`. When `true`, the `invoke` method
  validates the body via the registry before sending.
- `test/contract/runtime-validation.test.ts` — 6 tests covering:
  - Default behavior (no validation, no perf cost)
  - Validation strips unknown fields
  - Validation throws on missing required fields
  - Error carries operationId + Zod issues
  - No HTTP request made when validation fails
  - Schema-missing operations skip validation silently
- ADR 0020 (this file).

### Updated

- `src/generated/runtime/index.ts` — re-exports `getRequestSchema` and
  `requestSchemas` from the schema registry.
- `src/errors.ts` — added `import type { z } from 'zod'` for the
  `ZodIssue[]` type on the new error class.

## Consequences

- Callers can now opt into end-to-end contract enforcement with one flag:

  ```ts
  const runtime = new OllamaRuntime({ http, validateRequests: true });
  const api = new NativeApi(runtime);
  // Every chat/generate/embed/create/copy/delete/pull/push/show
  // request is now validated before hitting the wire.
  ```

- The validation is fail-fast: malformed requests throw before any
  network call, so no quota is consumed, no logs are written server-side,
  and no retry is attempted.

- Unknown fields are stripped by Zod's default behavior. This means
  callers can't accidentally send extra fields the contract doesn't
  allow — but it also means intentionally sending extra fields (e.g.
  for testing server-side leniency) requires disabling validation.

- The 9 native operations are covered; OpenAI/Anthropic compat surfaces
  are NOT (their request types are richer than what the IR currently
  models). A future wave may extend the registry when the IR gains
  compat-surface request schemas.

- Performance impact: when `validateRequests: false` (default), zero
  overhead — the validation block is gated by a runtime check. When
  `true`, one `safeParse` call per request — typically <1ms for the
  request sizes Ollama handles.

## Reference

- ADR 0019 — Zod schema generation (Wave 9)
- ADR 0014 — Generated surface and runtime seam (Waves 2+3)
