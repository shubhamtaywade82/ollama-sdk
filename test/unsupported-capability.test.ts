import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OllamaClient } from '../src/client.js';
import { OllamaUnsupportedCapabilityError } from '../src/errors.js';

const chatResponseBody = {
  model: 'llama3.2',
  created_at: '2026-08-17T00:00:00Z',
  message: { role: 'assistant', content: '{"ok":true}' },
  done: true,
};

describe('Fail-fast structured output capability check', () => {
  it('throws OllamaUnsupportedCapabilityError before any network call against an Ollama Cloud endpoint', async () => {
    const fetchMock = vi.fn();
    const client = new OllamaClient({ baseUrl: 'https://ollama.com', fetch: fetchMock as never });

    await expect(
      client.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        format: { type: 'object' },
        stream: false,
      }),
    ).rejects.toBeInstanceOf(OllamaUnsupportedCapabilityError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects chatWithSchema against a cloud endpoint without ever calling fetch', async () => {
    const fetchMock = vi.fn();
    const client = new OllamaClient({ baseUrl: 'https://ollama.com', fetch: fetchMock as never });

    await expect(
      client.chatWithSchema(
        { model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] },
        z.object({ ok: z.boolean() }),
      ),
    ).rejects.toBeInstanceOf(OllamaUnsupportedCapabilityError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not throw for a local endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => chatResponseBody,
    });
    const client = new OllamaClient({
      baseUrl: 'http://localhost:11434',
      fetch: fetchMock as never,
    });

    const res = await client.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
      format: { type: 'object' },
      stream: false,
    });

    expect(res.message.content).toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['http://ollama:11434', 'https://llm.mycompany.com'])(
    'sends format requests to a self-hosted endpoint (%s) instead of refusing it as cloud',
    async (baseUrl) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => chatResponseBody,
      });
      const client = new OllamaClient({ baseUrl, fetch: fetchMock as never });

      const res = await client.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        format: { type: 'object' },
        stream: false,
      });

      expect(res.message.content).toBe('{"ok":true}');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('does not apply to requests without a format field, even against a cloud endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => chatResponseBody,
    });
    const client = new OllamaClient({ baseUrl: 'https://ollama.com', fetch: fetchMock as never });

    await expect(
      client.chat({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    ).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails over from an unsupported cloud endpoint to a supporting local candidate', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith('http://localhost')) {
        return { ok: true, status: 200, json: async () => chatResponseBody };
      }
      throw new Error(`Unexpected call to ${url}`);
    });
    const client = new OllamaClient({
      endpoints: [
        { name: 'cloud', baseUrl: 'https://ollama.com', priority: 10 },
        { name: 'local', baseUrl: 'http://localhost:11435', priority: 5 },
      ],
      fetch: fetchMock as never,
    });

    const res = await client.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
      format: { type: 'object' },
      stream: false,
    });

    expect(res.message.content).toBe('{"ok":true}');
    // Only the local fallback's URL should ever have been fetched — the cloud
    // candidate must have been rejected pre-flight, not attempted over the network.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('localhost');
  });

  it('applies the same guard to generate() with format set', async () => {
    const fetchMock = vi.fn();
    const client = new OllamaClient({ baseUrl: 'https://ollama.com', fetch: fetchMock as never });

    await expect(
      client.generate({
        model: 'llama3.2',
        prompt: 'hi',
        format: { type: 'object' },
        stream: false,
      }),
    ).rejects.toBeInstanceOf(OllamaUnsupportedCapabilityError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
