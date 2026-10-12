/**
 * Public testing utilities — `@nemesis-oss/ollama-sdk/testing`.
 *
 * Deterministic, zero-network test doubles for code that talks to Ollama:
 * an in-memory HTTP mock server with scriptable routes, streaming control,
 * error injection, and correctly-shaped NDJSON chunk builders. See
 * {@link ./mock-server.js} for the full guide and ADR 0029 for why the
 * SDK's own internal fixture was promoted here instead of shipping a
 * second, weaker engine.
 *
 * Node.js-only (server-side `node:http`); never imported from the main
 * Edge-safe entry point. In test runners that resolve the package's
 * `exports` map (Vitest, Jest with `--experimental-vm-modules`-style ESM),
 * import directly:
 *
 * ```ts
 * import { createMockOllamaServer, mockToolCallChunks } from '@nemesis-oss/ollama-sdk/testing';
 * ```
 */

export {
  OllamaMockServer,
  createMockOllamaServer,
  mockChatChunk,
  mockTextChunks,
  mockToolCallChunks,
} from './mock-server.js';
export type {
  MockEndpointOptions,
  MockRequestRecord,
  MockServerOptions,
  MockTextChunksOptions,
  MockToolCallChunksOptions,
  MockToolCallSpec,
} from './mock-server.js';
