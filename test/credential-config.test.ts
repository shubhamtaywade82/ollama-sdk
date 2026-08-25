import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { resolveCredentialEndpoints } from '../src/config.js';
import { OllamaModelRoutingError } from '../src/errors.js';

function jsonFetchMock(handler: (url: string, init: { headers?: Record<string, string> }) => unknown) {
  return vi
    .fn()
    .mockImplementation(async (url: string, init: { headers?: Record<string, string> }) => ({
      ok: true,
      status: 200,
      json: async () => handler(url, init),
    }));
}

describe('resolveCredentialEndpoints', () => {
  it('returns [] when `credentials` is unset', () => {
    expect(resolveCredentialEndpoints({})).toEqual([]);
  });

  it('scopes each credential to the models bound to it', () => {
    const endpoints = resolveCredentialEndpoints({
      baseUrl: 'https://ollama.com',
      credentials: {
        gptOss: { apiKey: 'KEY_1' },
        minimax: { apiKey: 'KEY_2' },
      },
      modelBindings: {
        'gpt-oss:120b': 'gptOss',
        'minimax-m3': 'minimax',
      },
    });

    expect(endpoints).toHaveLength(2);
    const gptOss = endpoints.find((e) => e.name === 'credential:gptOss');
    const minimax = endpoints.find((e) => e.name === 'credential:minimax');
    expect(gptOss?.models).toEqual(['gpt-oss:120b']);
    expect(gptOss?.apiKey).toBe('KEY_1');
    expect(minimax?.models).toEqual(['minimax-m3']);
  });

  it('binds a model to multiple credentials via an array', () => {
    const endpoints = resolveCredentialEndpoints({
      credentials: { a: { apiKey: 'A' }, b: { apiKey: 'B' } },
      modelBindings: { 'gpt-oss:120b': ['a', 'b'] },
    });
    expect(endpoints.find((e) => e.name === 'credential:a')?.models).toEqual(['gpt-oss:120b']);
    expect(endpoints.find((e) => e.name === 'credential:b')?.models).toEqual(['gpt-oss:120b']);
  });

  it('leaves an unbound, non-default credential unscoped (eligible for every model)', () => {
    const endpoints = resolveCredentialEndpoints({
      credentials: { main: { apiKey: 'MAIN' } },
    });
    expect(endpoints[0]?.models).toBeUndefined();
  });

  it('gives defaultCredential no scoping and a lower priority than explicit bindings', () => {
    const endpoints = resolveCredentialEndpoints({
      credentials: { gptOss: { apiKey: 'KEY_1' }, fallback: { apiKey: 'KEY_2' } },
      modelBindings: { 'gpt-oss:120b': 'gptOss' },
      defaultCredential: 'fallback',
    });
    const fallback = endpoints.find((e) => e.name === 'credential:fallback');
    const gptOss = endpoints.find((e) => e.name === 'credential:gptOss');
    expect(fallback?.models).toBeUndefined();
    expect((fallback?.priority ?? 0) < (gptOss?.priority ?? 0)).toBe(true);
  });

  it('throws when modelBindings references an unknown credential id', () => {
    expect(() =>
      resolveCredentialEndpoints({
        credentials: { gptOss: { apiKey: 'KEY_1' } },
        modelBindings: { 'minimax-m3': 'minimax' },
      }),
    ).toThrow(/unknown credential "minimax"/);
  });
});

describe('OllamaClient: credentials + modelBindings config', () => {
  it('routes the exact 3-key setup (gpt-oss/minimax/nemotron) to the right key', async () => {
    const seenAuth: Record<string, string | undefined> = {};
    const fetchMock = jsonFetchMock((_url, init) => {
      const auth = init.headers?.['Authorization'];
      const model =
        auth === 'Bearer KEY_1' ? 'gpt-oss:120b' : auth === 'Bearer KEY_2' ? 'minimax-m3' : 'nemotron-3-super';
      seenAuth[model] = auth;
      return {
        model,
        created_at: '2026-08-25T00:00:00Z',
        message: { role: 'assistant', content: `ok:${model}` },
        done: true,
      };
    });

    const client = new OllamaClient({
      baseUrl: 'https://ollama.com',
      credentials: {
        supervisor: { apiKey: 'KEY_1' },
        coder: { apiKey: 'KEY_2' },
        researcher: { apiKey: 'KEY_3' },
      },
      modelBindings: {
        'gpt-oss:120b': 'supervisor',
        'minimax-m3': 'coder',
        'nemotron-3-super': 'researcher',
      },
      fetch: fetchMock as never,
    });

    const gpt = await client.chat({ model: 'gpt-oss:120b', messages: [{ role: 'user', content: 'hi' }] });
    const minimax = await client.chat({ model: 'minimax-m3', messages: [{ role: 'user', content: 'hi' }] });

    expect(gpt.message.content).toBe('ok:gpt-oss:120b');
    expect(minimax.message.content).toBe('ok:minimax-m3');
    expect(seenAuth['gpt-oss:120b']).toBe('Bearer KEY_1');
    expect(seenAuth['minimax-m3']).toBe('Bearer KEY_2');
  });

  it('throws OllamaModelRoutingError for a model no credential is bound to, without calling fetch', async () => {
    const fetchMock = vi.fn();
    const client = new OllamaClient({
      credentials: { supervisor: { apiKey: 'KEY_1' } },
      modelBindings: { 'gpt-oss:120b': 'supervisor' },
      fetch: fetchMock as never,
    });

    await expect(
      client.chat({ model: 'unbound-model', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeInstanceOf(OllamaModelRoutingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to defaultCredential for a model with no explicit binding', async () => {
    const fetchMock = jsonFetchMock((_url, init) => ({
      model: 'whatever:1b',
      created_at: '2026-08-25T00:00:00Z',
      message: { role: 'assistant', content: init.headers?.['Authorization'] ?? 'none' },
      done: true,
    }));

    const client = new OllamaClient({
      credentials: { supervisor: { apiKey: 'KEY_1' }, fallback: { apiKey: 'KEY_FALLBACK' } },
      modelBindings: { 'gpt-oss:120b': 'supervisor' },
      defaultCredential: 'fallback',
      fetch: fetchMock as never,
    });

    const res = await client.chat({
      model: 'whatever:1b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.message.content).toBe('Bearer KEY_FALLBACK');
  });

  it('remains fully backward compatible when neither credentials nor endpoints are set', async () => {
    const fetchMock = jsonFetchMock((_url, init) => ({
      model: 'llama3.2',
      created_at: '2026-08-25T00:00:00Z',
      message: { role: 'assistant', content: init.headers?.['Authorization'] ?? 'none' },
      done: true,
    }));

    const client = new OllamaClient({ apiKey: 'SINGLE_KEY', fetch: fetchMock as never });
    const res = await client.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.message.content).toBe('Bearer SINGLE_KEY');
  });
});
