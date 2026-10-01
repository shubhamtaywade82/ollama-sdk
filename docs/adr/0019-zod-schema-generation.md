# ADR 0019: Zod Schema Generation

## Status

Accepted

## Context

ADR 0014 (Wave 2) added TypeScript interface generation from the canonical
IR. Until Wave 9, runtime validation was a separate concern — callers
wanting to validate request bodies or response shapes had to either:

1. Trust the server (no validation).
2. Hand-write Zod schemas mirroring the OpenAPI spec (drift-prone, same
   class of problem Waves 1-7 fixed elsewhere).
3. Use `parseStructuredOutput` for chat responses (limited to the
   `format` field, doesn't cover request validation).

The same IR that drives TypeScript type generation can drive Zod schema
generation. Doing both from one source means callers get compile-time
types AND runtime validation with no drift between them.

## Decision

Add a Zod schema emitter that consumes the IR's `schemas` list and produces
one Zod schema per schema, written to
`src/generated/models/<name>.schema.ts`. Each file exports `<name>Schema`
— a `z.ZodType` that parses the same shape as the generated TypeScript
interface.

### Emitter

`generator/emitters/typescript/zod.ts` walks each schema's JSON Schema
definition and emits Zod expressions:

- `type: string` → `z.string()`
- `type: integer|number` → `z.number()`
- `type: boolean` → `z.boolean()`
- `type: null` → `z.null()`
- `type: array` → `z.array(<items>)`
- `type: object` (or properties-only) → `z.object({ ... })`
- `$ref` → references the sibling schema's exported constant
  (e.g. `${PascalName}Schema`)
- `oneOf` / `anyOf` → `z.union([...])`
- `allOf` → `z.intersection(...)` (rare in Ollama spec)
- `enum` (string-only) → `z.enum([...])`
- `enum` (mixed types) → `z.union([z.literal(...), ...])`
- `additionalProperties: true` → `.catchall(z.unknown())`
- `additionalProperties: <schema>` → `.catchall(<schema>)`
- Optional fields (not in `required`) → `.optional()`

The emitter also collects every `$ref` reachable from a schema and emits
a corresponding `import { XSchema } from './X.schema.js'` block, so
cross-schema references resolve at runtime.

### Output

For each schema `Foo`, two paired files:

- `src/generated/models/Foo.ts` — TypeScript interface (Wave 2 output)
- `src/generated/models/Foo.schema.ts` — Zod schema (Wave 9 output)

Plus an index file `src/generated/models/schemas.ts` re-exporting every
schema, so callers can import them all from one entry point:

```ts
import {
  ChatRequestSchema,
  ChatResponseSchema,
} from '@nemesis-oss/ollama-sdk/generated/models/schemas';
```

### Wave 9 scope: emit only

The emitter produces Zod schemas but does not wire them into the runtime.
Callers who want validation do it themselves:

```ts
import { ChatRequestSchema } from '@nemesis-oss/ollama-sdk/generated/models/schemas';

const result = ChatRequestSchema.safeParse(userInput);
if (!result.success) {
  // result.error.issues
}
```

Wiring Zod validation into `OllamaRuntime.invoke` (so every request body
is validated before the HTTP call) is a future iteration. The schemas
ship now so callers can opt in immediately.

## What changed

### Added

- `generator/emitters/typescript/zod.ts` — `emitZodSchemas` + helpers
  (`emitZod`, `emitObjectSchema`, `collectRefs`).
- `src/generated/models/<name>.schema.ts` — 36 Zod schema files.
- `src/generated/models/schemas.ts` — barrel re-export.
- `test/contract/zod-schemas.test.ts` — 12 tests covering happy-path
  parsing, rejection of malformed input, schema metadata, and Zod's
  default unknown-field stripping behavior.
- ADR 0019 (this file).

### Updated

- `generator/cli.ts` — `cmdGenerate` now invokes `emitZodSchemas`
  alongside the existing emitters. Generated file count grew from 45 to
  82 (added 36 schema files + 1 index).
- `npm run contract:generate` now produces the Zod schemas in addition
  to TypeScript interfaces, API classes, MCP tools, and metadata.

## Consequences

- The IR is now the single source of truth for **types**, **API
  surface**, **MCP tools**, **metadata**, **field-level parity**, and
  **runtime validation schemas**. Six consumers, one input.
- The generated Zod schemas faithfully reflect the OpenAPI spec, including
  its looseness. Notably, properties not listed in a schema's `required`
  array (e.g. `VersionResponse.version`) are emitted as `.optional()`.
  This is intentional — the OpenAPI spec is the source of truth, and
  callers who want stricter validation can wrap the schema with
  `.refine(data => data.version !== undefined)`.
- Schema cross-references resolve via `import` statements — the emitter
  writes a `import { XSchema } from './X.schema.js'` block at the top of
  each file. This means the generated `src/generated/models/` directory
  is self-contained: a caller can import any one schema and Zod will
  transitively resolve its dependencies.
- Per-call validation has a cost (each `.parse()` walks the input). The
  generated schemas use Zod's standard `z.object({...})` constructor —
  for high-throughput paths, callers may want to skip validation after
  confirming correctness in a staging environment.

## Reference

- ADR 0013 — Wave 1 contract foundation
- ADR 0014 — Wave 2 TypeScript interface generation
- ADR 0016 — Wave 6 MCP tool generation
