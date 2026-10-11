/**
 * Compile-time guarantees for the strict `Ollama*` compatibility request types.
 * `npm run typecheck` (tsconfig.typecheck.json) type-checks this file, so every
 * `@ts-expect-error` below fails the build if a field documented as unsupported at
 * https://docs.ollama.com/api/openai-compatibility becomes assignable again.
 */
import { describe, expect, it } from 'vitest';
import type {
  OllamaAnthropicMessagesRequest,
  OllamaOpenAIChatCompletionRequest,
  OllamaOpenAICompletionRequest,
  OllamaOpenAIEmbeddingRequest,
  OllamaOpenAIResponsesRequest,
  OpenAIChatCompletionRequest,
} from '../src/index.js';

describe('strict Ollama compatibility request types', () => {
  it('accept every documented-supported field', () => {
    const chat: OllamaOpenAIChatCompletionRequest = {
      model: 'gpt-oss:20b',
      messages: [{ role: 'user', content: 'hi' }],
      frequency_penalty: 0,
      presence_penalty: 0,
      response_format: { type: 'json_object' },
      seed: 1,
      stop: ['\n'],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      top_p: 1,
      max_tokens: 10,
      tools: [],
      reasoning_effort: 'low',
    };
    const completion: OllamaOpenAICompletionRequest = {
      model: 'm',
      prompt: 'p',
      suffix: 's',
      max_tokens: 1,
    };
    const embedding: OllamaOpenAIEmbeddingRequest = {
      model: 'm',
      input: ['a', 'b'],
      encoding_format: 'float',
      dimensions: 256,
    };
    const responses: OllamaOpenAIResponsesRequest = {
      model: 'm',
      input: 'hi',
      instructions: 'be brief',
      max_output_tokens: 10,
      reasoning: { effort: 'low' },
      think: 'low',
    };
    const anthropic: OllamaAnthropicMessagesRequest = {
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 100 },
    };
    expect([chat, completion, embedding, responses, anthropic]).toHaveLength(5);
  });

  it('reject fields Ollama documents as unsupported', () => {
    const base = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };
    // @ts-expect-error tool_choice is unsupported on /v1/chat/completions
    const a: OllamaOpenAIChatCompletionRequest = { ...base, tool_choice: 'auto' };
    // @ts-expect-error n is unsupported on /v1/chat/completions
    const b: OllamaOpenAIChatCompletionRequest = { ...base, n: 2 };
    // @ts-expect-error logprobs is unsupported on /v1/chat/completions
    const c: OllamaOpenAIChatCompletionRequest = { ...base, logprobs: true };
    // @ts-expect-error user is unsupported on /v1/chat/completions
    const d: OllamaOpenAIChatCompletionRequest = { ...base, user: 'u' };
    // @ts-expect-error logit_bias is unsupported on /v1/chat/completions
    const e: OllamaOpenAIChatCompletionRequest = { ...base, logit_bias: {} };
    // @ts-expect-error echo is unsupported on /v1/completions
    const f: OllamaOpenAICompletionRequest = { model: 'm', prompt: 'p', echo: true };
    // @ts-expect-error best_of is unsupported on /v1/completions
    const g: OllamaOpenAICompletionRequest = { model: 'm', prompt: 'p', best_of: 2 };
    // @ts-expect-error token-array input is unsupported on /v1/embeddings
    const h: OllamaOpenAIEmbeddingRequest = { model: 'm', input: [1, 2, 3] };
    // @ts-expect-error user is unsupported on /v1/embeddings
    const i: OllamaOpenAIEmbeddingRequest = { model: 'm', input: 'a', user: 'u' };
    // @ts-expect-error truncation is unsupported on /v1/responses
    const j: OllamaOpenAIResponsesRequest = { model: 'm', input: 'a', truncation: 'auto' };
    // @ts-expect-error previous_response_id is unsupported (stateless /v1/responses)
    const k: OllamaOpenAIResponsesRequest = { model: 'm', input: 'a', previous_response_id: 'r' };
    // @ts-expect-error tool_choice is unsupported on /v1/messages
    const l: OllamaAnthropicMessagesRequest = {
      model: 'm',
      max_tokens: 1,
      messages: [],
      tool_choice: { type: 'auto' },
    };
    expect([a, b, c, d, e, f, g, h, i, j, k, l]).toHaveLength(12);
  });

  it('keep the broad interop types permissive for drop-in OpenAI payloads', () => {
    const broad: OpenAIChatCompletionRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'auto',
      n: 1,
      user: 'u',
      logprobs: false,
    };
    expect(broad.tool_choice).toBe('auto');
  });
});
