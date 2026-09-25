import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { extractUsage } from '../src/usage.js';
import { normalizeChatStream } from '../src/streaming/normalize.js';
import type { ChatResponse } from '../src/types.js';
import type {
  AnthropicMessagesRequest,
  OllamaAnthropicMessagesRequest,
  OllamaOpenAIChatCompletionRequest,
  OllamaOpenAICompletionRequest,
  OllamaOpenAIEmbeddingRequest,
  OllamaOpenAIResponsesRequest,
} from '../src/index.js';

type ExpectFalse<T extends false> = T;
type _ChatToolChoiceExcluded = ExpectFalse<
  'tool_choice' extends keyof OllamaOpenAIChatCompletionRequest ? true : false
>;
type _ChatParallelToolsExcluded = ExpectFalse<
  'parallel_tool_calls' extends keyof OllamaOpenAIChatCompletionRequest ? true : false
>;
type _CompletionBestOfExcluded = ExpectFalse<
  'best_of' extends keyof OllamaOpenAICompletionRequest ? true : false
>;
type _EmbeddingUserExcluded = ExpectFalse<
  'user' extends keyof OllamaOpenAIEmbeddingRequest ? true : false
>;
type _ResponsesStateExcluded = ExpectFalse<
  'previous_response_id' extends keyof OllamaOpenAIResponsesRequest ? true : false
>;
type _AnthropicToolChoiceExcluded = ExpectFalse<
  'tool_choice' extends keyof OllamaAnthropicMessagesRequest ? true : false
>;
type _AnthropicMetadataExcluded = ExpectFalse<
  'metadata' extends keyof OllamaAnthropicMessagesRequest ? true : false
>;
void (undefined as unknown as _ChatToolChoiceExcluded);
void (undefined as unknown as _ChatParallelToolsExcluded);
void (undefined as unknown as _CompletionBestOfExcluded);
void (undefined as unknown as _EmbeddingUserExcluded);
void (undefined as unknown as _ResponsesStateExcluded);
void (undefined as unknown as _AnthropicToolChoiceExcluded);
void (undefined as unknown as _AnthropicMetadataExcluded);

function jsonFetchMock(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

describe('current native Ollama API parity', () => {
  it('exposes model-defined thinking metadata from api/show', async () => {
    const fetchMock = jsonFetchMock({
      details: {
        format: 'gguf',
        family: 'gptoss',
        parameter_size: '20B',
        quantization_level: 'Q4_K_M',
      },
      capabilities: ['completion', 'thinking', 'tools'],
      thinking: {
        values: ['low', 'medium', 'high'],
        default: 'medium',
      },
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    const capabilities = await client.capabilities('gpt-oss:20b');

    expect(capabilities.supportsThinking).toBe(true);
    expect(capabilities.thinking).toEqual({
      values: ['low', 'medium', 'high'],
      default: 'medium',
    });
  });

  it('accepts boolean, null, and model-defined thinking values', async () => {
    const fetchMock = jsonFetchMock({
      model: 'gemma4:31b',
      created_at: '2026-09-24T00:00:00Z',
      message: { role: 'assistant', content: 'ok' },
      done: true,
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    for (const think of [true, false, null, 'ultra'] as const) {
      await client.chat({
        model: 'gemma4:31b',
        messages: [{ role: 'user', content: 'hello' }],
        think,
        stream: false,
      });

      const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [
        string,
        { body: string },
      ];
      expect(JSON.parse(lastCall[1].body).think).toBe(think);
    }
  });

  it('accepts dynamic thinking values on /api/generate', async () => {
    const fetchMock = jsonFetchMock({
      model: 'gemma4',
      created_at: '2026-09-24T00:00:00Z',
      response: 'ok',
      done: true,
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    for (const think of [true, false, null, 'custom-level'] as const) {
      await client.generate({
        model: 'gemma4',
        prompt: 'hello',
        think,
        stream: false,
      });

      const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [
        string,
        { body: string },
      ];
      expect(JSON.parse(lastCall[1].body).think).toBe(think);
    }
  });

  it('extracts cached prompt tokens without changing total token accounting', () => {
    const usage = extractUsage({
      prompt_eval_count: 120,
      prompt_eval_cached_count: 80,
      eval_count: 12,
    });

    expect(usage.promptTokens).toBe(120);
    expect(usage.cachedPromptTokens).toBe(80);
    expect(usage.completionTokens).toBe(12);
    expect(usage.totalTokens).toBe(132);
  });

  it('preserves cached prompt tokens in stream usage', async () => {
    async function* chunks(): AsyncGenerator<ChatResponse, void, undefined> {
      yield {
        model: 'gpt-oss:20b',
        created_at: '2026-09-24T00:00:00Z',
        message: { role: 'assistant', content: 'ok' },
        done: true,
        prompt_eval_count: 120,
        prompt_eval_cached_count: 80,
        eval_count: 12,
      };
    }

    const stream = normalizeChatStream(chunks());
    for await (const _ of stream) {
      // drain
    }

    const final = await stream.finalResult;
    expect(final.usage?.cachedPromptTokens).toBe(80);
  });

  it('forwards current create-model fields', async () => {
    const fetchMock = jsonFetchMock({ status: 'success' });
    const client = new OllamaClient({ fetch: fetchMock as never });

    await client.createModel({
      model: 'custom',
      from: 'gemma4',
      files: { 'model.gguf': 'sha256:abc' },
      draft_files: { 'draft.gguf': 'sha256:def' },
      quantize: 'q4_K_M',
      draft_quantize: 'q8_0',
      requires: '0.13.5',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({
      draft_files: { 'draft.gguf': 'sha256:def' },
      draft_quantize: 'q8_0',
      requires: '0.13.5',
    });
  });
});

describe('strict documented Ollama compatibility request types', () => {
  it('accepts documented request fields while excluding explicitly unsupported ones', () => {
    const chat: OllamaOpenAIChatCompletionRequest = {
      model: 'qwen3',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning: { effort: 'low' },
    };
    const completions: OllamaOpenAICompletionRequest = {
      model: 'llama3.2',
      prompt: 'hello',
      suffix: '!',
    };
    const embeddings: OllamaOpenAIEmbeddingRequest = {
      model: 'nomic-embed-text',
      input: 'hello',
      dimensions: 2,
    };
    const responses: OllamaOpenAIResponsesRequest = {
      model: 'qwen3',
      input: 'hello',
      instructions: 'answer concisely',
    };
    const anthropic: OllamaAnthropicMessagesRequest = {
      model: 'qwen3',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    };

    expect(chat.model).toBe('qwen3');
    expect(completions.suffix).toBe('!');
    expect(embeddings.dimensions).toBe(2);
    expect(responses.instructions).toBe('answer concisely');
    expect(anthropic.messages[0]?.role).toBe('user');

    const broad: AnthropicMessagesRequest = {
      ...anthropic,
      tool_choice: { type: 'auto' },
      metadata: { request_id: 'compat' },
    };
    expect(broad.tool_choice).toEqual({ type: 'auto' });
    expect(broad.metadata).toEqual({ request_id: 'compat' });
  });
});

describe('current Anthropic compatibility parity', () => {
  it('sends the documented Anthropic version header and accepts budget_tokens', async () => {
    const fetchMock = jsonFetchMock({
      id: 'msg-1',
      type: 'message',
      role: 'assistant',
      model: 'qwen3',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    await client.anthropic.messages({
      model: 'qwen3',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'enabled', budget_tokens: 128 },
    });

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(init.body).thinking).toEqual({
      type: 'enabled',
      budget_tokens: 128,
    });
  });
});

describe('current OpenAI compatibility parity', () => {
  it('supports chat response format, seed, logit bias, n, vision, and model-defined reasoning', async () => {
    const fetchMock = jsonFetchMock({
      id: 'chat-1',
      object: 'chat.completion',
      created: 0,
      model: 'qwen3-vl:8b',
      choices: [],
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    await client.openai.chatCompletions({
      model: 'qwen3-vl:8b',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: 'data:image/png;base64,abc' },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      seed: 42,
      logit_bias: { '123': 1 },
      n: 2,
      reasoning_effort: 'ultra',
      reasoning: { effort: 'custom-level' },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);

    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.seed).toBe(42);
    expect(body.logit_bias).toEqual({ '123': 1 });
    expect(body.n).toBe(2);
    expect(body.messages[0].content[1].image_url).toBe('data:image/png;base64,abc');
    expect(body.reasoning_effort).toBe('ultra');
    expect(body.reasoning).toEqual({ effort: 'custom-level' });
  });

  it('supports non-streaming /v1/completions', async () => {
    const fetchMock = jsonFetchMock({
      id: 'cmpl-1',
      object: 'text_completion',
      created: 0,
      model: 'llama3.2',
      choices: [{ text: 'hello', index: 0, finish_reason: 'stop' }],
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    const result = await client.openai.completions({
      model: 'llama3.2',
      prompt: 'Say hello',
      seed: 7,
      max_tokens: 8,
      suffix: '!',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/v1/completions');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'llama3.2',
      prompt: 'Say hello',
      seed: 7,
      max_tokens: 8,
      suffix: '!',
    });
    expect(result.choices[0]?.text).toBe('hello');
  });

  it('supports non-streaming /v1/embeddings', async () => {
    const fetchMock = jsonFetchMock({
      object: 'list',
      data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
      model: 'nomic-embed-text',
      usage: { prompt_tokens: 4, total_tokens: 4 },
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    const result = await client.openai.embeddings({
      model: 'nomic-embed-text',
      input: ['hello', 'world'],
      encoding_format: 'float',
      dimensions: 2,
      user: 'test',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/v1/embeddings');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'nomic-embed-text',
      input: ['hello', 'world'],
      encoding_format: 'float',
      dimensions: 2,
      user: 'test',
    });
    expect(result.data[0]?.embedding).toEqual([0.1, 0.2]);
  });

  it('copies a model using the documented source and destination fields', async () => {
    const fetchMock = jsonFetchMock({ status: 'success' });
    const client = new OllamaClient({ fetch: fetchMock as never });

    await client.copyModel({
      source: 'gemma4',
      destination: 'gemma4-backup',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/api/copy');
    expect(JSON.parse(init.body)).toEqual({
      source: 'gemma4',
      destination: 'gemma4-backup',
    });
  });

  it('pushes a model with the documented model, insecure, and stream fields', async () => {
    const fetchMock = jsonFetchMock({ status: 'success' });
    const client = new OllamaClient({ fetch: fetchMock as never });

    await client.pushModel({
      model: 'my-username/my-model',
      insecure: true,
      stream: false,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/api/push');
    expect(JSON.parse(init.body)).toEqual({
      model: 'my-username/my-model',
      insecure: true,
      stream: false,
    });
  });

  it('retrieves one model through /v1/models/{model}', async () => {
    const fetchMock = jsonFetchMock({
      id: 'llama3.2',
      object: 'model',
      created: 0,
      owned_by: 'library',
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    const model = await client.openai.getModel('llama3.2');

    const [url] = fetchMock.mock.calls[0] as [string, { body?: string }];
    expect(url).toContain('/v1/models/llama3.2');
    expect(model.id).toBe('llama3.2');
  });
});
