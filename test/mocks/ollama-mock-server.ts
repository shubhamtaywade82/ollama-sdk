/**
 * Back-compatibility shim — the mock server engine was promoted to the
 * public `@nemesis-oss/ollama-sdk/testing` entry point (see
 * `src/testing/mock-server.ts` and ADR 0029) so consumers get the same
 * deterministic, zero-network test double the SDK's own suite uses.
 *
 * Existing test files keep importing `'./mocks/ollama-mock-server.js'`;
 * this module re-exports the public engine unchanged, which means the
 * SDK's tests exercise exactly what consumers import from the package.
 */

export {
  OllamaMockServer,
  createMockOllamaServer,
  mockChatChunk,
  mockTextChunks,
  mockToolCallChunks,
} from '../../src/testing/mock-server.js';
export type {
  MockEndpointOptions,
  MockRequestRecord,
  MockServerOptions,
  MockTextChunksOptions,
  MockToolCallChunksOptions,
  MockToolCallSpec,
} from '../../src/testing/mock-server.js';
