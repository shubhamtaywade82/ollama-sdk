import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { encodeImage } from '../src/utils.js';
import { normalizeChatStream, normalizeGenerateStream } from '../src/streaming/normalize.js';
import type { ChatResponse, GenerateResponse } from '../src/types.js';

function jsonFetchMock(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

describe('Ollama v0.13.3 compatibility: model creation', () => {
  it('createModel forwards template, system, parameters, and messages to the HTTP client', async () => {
    const fetchMock = jsonFetchMock({ status: 'success' });
    const client = new OllamaClient({ fetch: fetchMock as never });

    await client.createModel({
      model: 'my-custom-model',
      from: 'llama3.2',
      template: '{{ .Prompt }}',
      system: 'You are a helpful assistant.',
      parameters: { temperature: 0.7, stop: ['\n'] },
      messages: [{ role: 'user', content: 'hello' }],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.template).toBe('{{ .Prompt }}');
    expect(body.system).toBe('You are a helpful assistant.');
    expect(body.parameters).toEqual({ temperature: 0.7, stop: ['\n'] });
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.from).toBe('llama3.2');
  });

  it('still accepts the deprecated modelfile field without breaking the request', async () => {
    const fetchMock = jsonFetchMock({ status: 'success' });
    const client = new OllamaClient({ fetch: fetchMock as never });

    await client.createModel({ model: 'legacy-model', modelfile: 'FROM llama3.2' });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.modelfile).toBe('FROM llama3.2');
  });
});

describe('Ollama v0.13.3 compatibility: OpenAI /v1/responses bridge', () => {
  it('client.openai.responses() posts to /v1/responses with the correct payload', async () => {
    const fetchMock = jsonFetchMock({
      id: 'resp_1',
      object: 'response',
      created: 0,
      model: 'llama3.2',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi there' }] }],
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    const res = await client.openai.responses({
      model: 'llama3.2',
      input: 'Hello via Responses',
      instructions: 'Be concise.',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/v1/responses');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('llama3.2');
    expect(body.input).toBe('Hello via Responses');
    expect(body.instructions).toBe('Be concise.');
    expect(res.output[0]?.content[0]?.text).toBe('hi there');
  });
});

describe('Ollama v0.13.3 compatibility: image encoding', () => {
  it('encodeImage returns strings unchanged and base64-encodes Uint8Array', async () => {
    await expect(encodeImage('already-base64')).resolves.toBe('already-base64');
    const bytes = new TextEncoder().encode('hello');
    await expect(encodeImage(bytes)).resolves.toBe(Buffer.from(bytes).toString('base64'));
  });

  it('chat() base64-encodes Uint8Array images in message content before sending', async () => {
    const fetchMock = jsonFetchMock({
      model: 'llava',
      created_at: '2026-08-16T00:00:00Z',
      message: { role: 'assistant', content: 'a cat' },
      done: true,
    });
    const client = new OllamaClient({ fetch: fetchMock as never });
    const bytes = new TextEncoder().encode('fake-image-bytes');

    await client.chat({
      model: 'llava',
      messages: [{ role: 'user', content: 'What is this?', images: [bytes] }],
      stream: false,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.messages[0].images[0]).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('generate() base64-encodes Uint8Array images before sending', async () => {
    const fetchMock = jsonFetchMock({
      model: 'llava',
      created_at: '2026-08-16T00:00:00Z',
      response: 'a cat',
      done: true,
    });
    const client = new OllamaClient({ fetch: fetchMock as never });
    const bytes = new TextEncoder().encode('fake-image-bytes');

    await client.generate({
      model: 'llava',
      prompt: 'What is this?',
      images: [bytes],
      stream: false,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.images[0]).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('Ollama v0.13.3 compatibility: reasoning_effort / reasoning bridge fields', () => {
  it('forwards reasoning_effort and reasoning.effort in the OpenAI chat completions body', async () => {
    const fetchMock = jsonFetchMock({
      id: 'x',
      object: 'chat.completion',
      created: 0,
      model: 'deepseek-r1:8b',
      choices: [],
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    await client.openai.chatCompletions({
      model: 'deepseek-r1:8b',
      messages: [{ role: 'user', content: 'Solve: 17 * 23' }],
      reasoning_effort: 'high',
      reasoning: { effort: 'high' },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.reasoning_effort).toBe('high');
    expect(body.reasoning).toEqual({ effort: 'high' });
  });
});

describe('Ollama v0.13.3 compatibility: done_reason in stream aggregation', () => {
  it('surfaces done_reason on the final ChatStreamResult', async () => {
    async function* chunks(): AsyncGenerator<ChatResponse, void, undefined> {
      yield {
        model: 'llama3.2',
        created_at: '2026-08-16T00:00:00Z',
        message: { role: 'assistant', content: 'hi' },
        done: false,
      };
      yield {
        model: 'llama3.2',
        created_at: '2026-08-16T00:00:01Z',
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
      };
    }
    const stream = normalizeChatStream(chunks());
    for await (const _ of stream) {
      // drain
    }
    const final = await stream.finalResult;
    expect(final.doneReason).toBe('stop');
  });

  it('surfaces done_reason on the final GenerateStreamResult', async () => {
    async function* chunks(): AsyncGenerator<GenerateResponse, void, undefined> {
      yield {
        model: 'llama3.2',
        created_at: '2026-08-16T00:00:00Z',
        response: 'hi',
        done: false,
      };
      yield {
        model: 'llama3.2',
        created_at: '2026-08-16T00:00:01Z',
        response: '',
        done: true,
        done_reason: 'stop',
      };
    }
    const stream = normalizeGenerateStream(chunks());
    for await (const _ of stream) {
      // drain
    }
    const final = await stream.finalResult;
    expect(final.doneReason).toBe('stop');
  });
});
