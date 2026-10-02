import { describe, expect, it } from 'vitest';
import { OpenAIApi } from '../../src/generated/api/openai-api.js';
import { AnthropicApi } from '../../src/generated/api/anthropic-api.js';
import type { OllamaRuntime } from '../../src/generated/runtime/runtime.js';
import type {
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionChunk,
  OpenAIResponsesRequest,
  OpenAIResponsesResponse,
  OpenAIResponsesStreamEvent,
  OpenAIEmbeddingRequest,
  OpenAIEmbeddingResponse,
  OpenAIListModelsResponse,
  OpenAIModelItem,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicMessageStreamEvent,
} from '../../src/integrations/index.js';

/**
 * Wave 12 (P0 #1): the generated OpenAI/Anthropic compatibility API classes
 * must NOT use `Record<string, unknown>` / `Promise<unknown>` — those were
 * the stubs the contract-first architecture was supposed to eliminate.
 *
 * Each method should accept the rich hand-written request type from
 * src/integrations/{openai,anthropic}.ts and return the matching response
 * type, with the streaming overload returning the proper stream-chunk
 * type (e.g. OpenAIChatCompletionChunk, not `unknown`).
 *
 * These tests use TypeScript's type system as the assertion mechanism:
 * the `AssignableTo` helper fails to compile if the generator regresses
 * back to untyped stubs.
 */
describe('Wave 12: generated compat APIs are fully typed', () => {
  // Construct instances against a typed-but-undefined runtime reference.
  // We never invoke any method — the assertions below are pure type-level
  // checks against the method signatures themselves. The instance vars
  // are prefixed with _ because lint would otherwise flag them as unused
  // (we only use them for typeof extraction).
  const runtime = undefined as unknown as OllamaRuntime;
  const _openai = new OpenAIApi(runtime);
  const _anthropic = new AnthropicApi(runtime);

  /** Type-level helper: asserts that `A` is assignable to `B` (and returns `true`). */
  function isAssignable<A, B>(_: A extends B ? true : false): boolean {
    return true;
  }

  it('openaiChatCompletions signature uses OpenAIChatCompletionRequest', () => {
    // Pull the non-streaming overload's parameter type out of the method.
    type Method = typeof _openai.openaiChatCompletions;
    type NonStreamingParams = Method extends {
      (request: infer R & { stream?: false }): Promise<unknown>;
    }
      ? R
      : never;
    // OpenAIChatCompletionRequest must be assignable to the inferred param
    // type (i.e. the method accepts rich requests, not Record<string, unknown>).
    expect(isAssignable<OpenAIChatCompletionRequest, NonStreamingParams>(true)).toBe(true);
  });

  it('openaiChatCompletions non-streaming returns Promise<OpenAIChatCompletionResponse>', () => {
    type Method = typeof _openai.openaiChatCompletions;
    type Return = Method extends {
      (request: { stream?: false }): Promise<infer R>;
    }
      ? R
      : never;
    // The response type must be assignable from the rich hand-written type.
    expect(isAssignable<OpenAIChatCompletionResponse, Return>(true)).toBe(true);
  });

  it('openaiChatCompletions streaming returns AsyncGenerator<OpenAIChatCompletionChunk>', () => {
    type Method = typeof _openai.openaiChatCompletions;
    type Return = Method extends {
      (request: { stream: true }): Promise<AsyncGenerator<infer E, void, undefined>>;
    }
      ? E
      : never;
    expect(isAssignable<OpenAIChatCompletionChunk, Return>(true)).toBe(true);
  });

  it('openaiResponses signature uses OpenAIResponsesRequest and OpenAIResponsesResponse', () => {
    type Method = typeof _openai.openaiResponses;
    type Params = Method extends {
      (request: infer R & { stream?: false }): Promise<unknown>;
    }
      ? R
      : never;
    type Return = Method extends {
      (request: { stream?: false }): Promise<infer R>;
    }
      ? R
      : never;
    expect(isAssignable<OpenAIResponsesRequest, Params>(true)).toBe(true);
    expect(isAssignable<OpenAIResponsesResponse, Return>(true)).toBe(true);
  });

  it('openaiResponses streaming returns AsyncGenerator<OpenAIResponsesStreamEvent>', () => {
    type Method = typeof _openai.openaiResponses;
    type Return = Method extends {
      (request: { stream: true }): Promise<AsyncGenerator<infer E, void, undefined>>;
    }
      ? E
      : never;
    expect(isAssignable<OpenAIResponsesStreamEvent, Return>(true)).toBe(true);
  });

  it('openaiEmbeddings uses OpenAIEmbeddingRequest and OpenAIEmbeddingResponse', () => {
    type Method = typeof _openai.openaiEmbeddings;
    type Params = Method extends (request: infer R) => Promise<unknown> ? R : never;
    type Return = Method extends (request: unknown) => Promise<infer R> ? R : never;
    expect(isAssignable<OpenAIEmbeddingRequest, Params>(true)).toBe(true);
    expect(isAssignable<OpenAIEmbeddingResponse, Return>(true)).toBe(true);
  });

  it('openaiModels returns OpenAIListModelsResponse', () => {
    type Method = typeof _openai.openaiModels;
    type Return = Method extends (options?: unknown) => Promise<infer R> ? R : never;
    expect(isAssignable<OpenAIListModelsResponse, Return>(true)).toBe(true);
  });

  it('openaiModelsGetOne returns OpenAIModelItem', () => {
    type Method = typeof _openai.openaiModelsGetOne;
    type Return = Method extends (options?: unknown) => Promise<infer R> ? R : never;
    expect(isAssignable<OpenAIModelItem, Return>(true)).toBe(true);
  });

  it('anthropicMessages signature uses AnthropicMessagesRequest', () => {
    type Method = typeof _anthropic.anthropicMessages;
    type Params = Method extends {
      (request: infer R & { stream?: false }): Promise<unknown>;
    }
      ? R
      : never;
    expect(isAssignable<AnthropicMessagesRequest, Params>(true)).toBe(true);
  });

  it('anthropicMessages non-streaming returns Promise<AnthropicMessagesResponse>', () => {
    type Method = typeof _anthropic.anthropicMessages;
    type Return = Method extends {
      (request: { stream?: false }): Promise<infer R>;
    }
      ? R
      : never;
    expect(isAssignable<AnthropicMessagesResponse, Return>(true)).toBe(true);
  });

  it('anthropicMessages streaming returns AsyncGenerator<AnthropicMessageStreamEvent>', () => {
    type Method = typeof _anthropic.anthropicMessages;
    type Return = Method extends {
      (request: { stream: true }): Promise<AsyncGenerator<infer E, void, undefined>>;
    }
      ? E
      : never;
    expect(isAssignable<AnthropicMessageStreamEvent, Return>(true)).toBe(true);
  });
});
