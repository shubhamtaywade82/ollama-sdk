describe('API parity manifest contract', () => {
  it('tracks current support classification and expanded native surfaces', async () => {
    const manifest = JSON.parse(
      await (await import('node:fs/promises')).readFile(
        new URL('../docs/api-parity.json', import.meta.url),
        'utf8',
      ),
    ) as {
      version: number;
      surfaces: Array<{
        id: string;
        unsupportedFields?: string[];
        sdkOnlyFields?: string[];
        response?: { fields: string[]; sdkOnlyFields?: string[] };
        stream?: { unionName: string; interfaceNames: string[] };
      }>;
    };

    const chat = manifest.surfaces.find((surface) => surface.id === 'openai-chat');
    const embeddings = manifest.surfaces.find((surface) => surface.id === 'openai-embeddings');
    const responses = manifest.surfaces.find((surface) => surface.id === 'openai-responses');
    const anthropic = manifest.surfaces.find((surface) => surface.id === 'anthropic-messages');

    expect(manifest.version).toBe(4);
    expect(chat?.unsupportedFields).toEqual([]);
    expect(chat?.sdkOnlyFields).toEqual(['parallel_tool_calls']);
    expect(embeddings?.unsupportedFields).toEqual([]);
    expect(responses?.unsupportedFields).toEqual(['previous_response_id', 'conversation']);
    expect(responses?.sdkOnlyFields).toEqual(['reasoning', 'think', 'parallel_tool_calls']);
    expect(responses?.stream?.interfaceNames).toHaveLength(22);
    expect(anthropic?.unsupportedFields).toEqual(['tool_choice', 'metadata']);
    expect(anthropic?.response?.fields).toEqual([
      'id',
      'type',
      'role',
      'model',
      'content',
      'stop_reason',
      'usage',
    ]);
    expect(anthropic?.response?.sdkOnlyFields).toEqual(['stop_sequence']);
    expect(anthropic?.stream?.unionName).toBe('AnthropicMessageStreamEvent');
    expect(anthropic?.stream?.interfaceNames).toHaveLength(8);
    expect(manifest.surfaces.find((surface) => surface.id === 'native-copy')).toBeDefined();
    expect(manifest.surfaces.find((surface) => surface.id === 'native-ps')).toBeDefined();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { extractUsage } from '../src/usage.js';
import { normalizeChatStream } from '../src/streaming/normalize.js';
import type { ChatResponse } from '../src/types.js';
import type {
  OllamaOpenAIChatCompletionRequest,
  OllamaOpenAIChatContentPart,
  OllamaOpenAIEmbeddingRequest,
  OllamaOpenAIResponsesRequest,
} from '../src/index.js';

type ExpectTrue<T extends true> = T;
type _ChatImageUrlAllowed = ExpectTrue<
  'image_url' extends OllamaOpenAIChatContentPart['type'] ? true : false
>;

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

describe('strict current OpenAI compatibility types', () => {
  it('retain all currently documented request fields in Ollama-scoped aliases', () => {
    const chat: OllamaOpenAIChatCompletionRequest = {
      model: 'qwen3',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image_url', image_url: 'data:image/png;base64,abc' },
        ],
      }],
      tool_choice: 'auto',
      logit_bias: { '123': 1 },
      user: 'test-user',
      n: 2,
    };
    const embeddings: OllamaOpenAIEmbeddingRequest = {
      model: 'nomic-embed-text',
      input: 'hello',
      encoding_format: 'float',
      dimensions: 2,
      user: 'test-user',
    };
    const responses: OllamaOpenAIResponsesRequest = {
      model: 'qwen3',
      input: 'hello',
      truncation: 'auto',
    };

    expect(chat.messages[0]?.content).toHaveLength(2);
    expect(embeddings.user).toBe('test-user');
    expect(responses.truncation).toBe('auto');
  });
});

describe('Anthropic unsupported-feature sanitization', () => {
  it('does not transmit features Ollama documents as unsupported', async () => {
    const fetchMock = jsonFetchMock({
      id: 'msg-unsupported',
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
      max_tokens: 16,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: 'hello',
          cache_control: { type: 'ephemeral' },
        }],
      }],
      tool_choice: { type: 'any' },
      metadata: { user_id: 'abc' },
      system: [{
        type: 'text',
        text: 'system',
        cache_control: { type: 'ephemeral' },
      }],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.tool_choice).toBeUndefined();
    expect(body.metadata).toBeUndefined();
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
    expect(body.system[0].cache_control).toBeUndefined();
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

describe('current model-management response parity', () => {
  it('exposes /api/ps context_length and supports /api/copy', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url.includes('/api/ps')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [{
              name: 'qwen3',
              model: 'qwen3',
              modified_at: '2026-09-25T00:00:00Z',
              size: 1,
              digest: 'sha256:test',
              details: {
                parent_model: '',
                format: 'gguf',
                family: 'qwen3',
                parameter_size: '8B',
                quantization_level: 'Q4_K_M',
              },
              context_length: 32768,
            }],
          }),
        };
      }
      if (url.includes('/api/copy')) {
        expect(init?.body ? JSON.parse(init.body) : undefined).toEqual({
          source: 'qwen3',
          destination: 'qwen3-copy',
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'success' }),
        };
      }
      throw new Error('unexpected request: ' + url);
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    const running = await client.ps();
    expect(running.models[0]?.context_length).toBe(32768);

    const copied = await client.copyModel({
      source: 'qwen3',
      destination: 'qwen3-copy',
    });
    expect(copied.status).toBe('success');
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
