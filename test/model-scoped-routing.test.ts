import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { EndpointRegistry } from '../src/providers/endpoint-registry.js';
import { OllamaModelRoutingError } from '../src/errors.js';

function jsonFetchMock(handler: (url: string, init: { headers?: Record<string, string> }) => unknown) {
  return vi.fn().mockImplementation(async (url: string, init: { headers?: Record<string, string> }) => ({
    ok: true,
    status: 200,
    json: async () => handler(url, init),
  }));
}

describe('EndpointRegistry: model-scoped candidates', () => {
  it('returns every endpoint when no model is given', () => {
    const registry = new EndpointRegistry([
      { name: 'a', baseUrl: 'http://a', models: ['gpt-oss:120b'] },
      { name: 'b', baseUrl: 'http://b', models: ['minimax-m3'] },
    ]);
    expect(registry.candidates().map((e) => e.name).sort()).toEqual(['a', 'b']);
  });

  it('filters to only the endpoint(s) authorized for the requested model', () => {
    const registry = new EndpointRegistry([
      { name: 'a', baseUrl: 'http://a', models: ['gpt-oss:120b'] },
      { name: 'b', baseUrl: 'http://b', models: ['minimax-m3'] },
      { name: 'c', baseUrl: 'http://c' }, // unscoped: eligible for every model
    ]);
    expect(registry.candidates('minimax-m3').map((e) => e.name).sort()).toEqual(['b', 'c']);
    expect(registry.candidates('gpt-oss:120b').map((e) => e.name).sort()).toEqual(['a', 'c']);
    expect(registry.candidates('unrelated-model').map((e) => e.name)).toEqual(['c']);
  });

  it('hasModelScopedEndpoints reflects whether any endpoint declares `models`', () => {
    expect(new EndpointRegistry([{ name: 'a', baseUrl: 'http://a' }]).hasModelScopedEndpoints()).toBe(
      false,
    );
    expect(
      new EndpointRegistry([{ name: 'a', baseUrl: 'http://a', models: ['x'] }]).hasModelScopedEndpoints(),
    ).toBe(true);
  });
});

describe('OllamaClient: credential-scoped multi-key routing', () => {
  it('routes each model to the endpoint/credential authorized for it', async () => {
    const seenAuthByModel: Record<string, string | undefined> = {};
    const fetchMock = jsonFetchMock((url, init) => {
      const model = url.includes('supervisor')
        ? 'gpt-oss:120b'
        : url.includes('coder')
          ? 'minimax-m3'
          : 'unknown';
      seenAuthByModel[model] = init.headers?.['Authorization'];
      return {
        model,
        created_at: '2026-08-25T00:00:00Z',
        message: { role: 'assistant', content: `hello from ${model}` },
        done: true,
      };
    });

    const client = new OllamaClient({
      endpoints: [
        {
          name: 'supervisor-key',
          baseUrl: 'http://supervisor.local',
          apiKey: 'KEY_1',
          models: ['gpt-oss:120b'],
        },
        {
          name: 'coder-key',
          baseUrl: 'http://coder.local',
          apiKey: 'KEY_2',
          models: ['minimax-m3'],
        },
      ],
      fetch: fetchMock as never,
    });

    const gptRes = await client.chat({
      model: 'gpt-oss:120b',
      messages: [{ role: 'user', content: 'plan this' }],
    });
    const minimaxRes = await client.chat({
      model: 'minimax-m3',
      messages: [{ role: 'user', content: 'implement this' }],
    });

    expect(gptRes.message.content).toBe('hello from gpt-oss:120b');
    expect(minimaxRes.message.content).toBe('hello from minimax-m3');
    expect(seenAuthByModel['gpt-oss:120b']).toBe('Bearer KEY_1');
    expect(seenAuthByModel['minimax-m3']).toBe('Bearer KEY_2');
  });

  it('never sends a request to a credential unauthorized for the requested model', async () => {
    const fetchMock = vi.fn();

    const client = new OllamaClient({
      endpoints: [
        { name: 'gpt-oss-key', baseUrl: 'http://a.local', apiKey: 'KEY_1', models: ['gpt-oss:120b'] },
        { name: 'minimax-key', baseUrl: 'http://b.local', apiKey: 'KEY_2', models: ['minimax-m3'] },
      ],
      fetch: fetchMock as never,
    });

    await expect(
      client.chat({ model: 'nemotron-3-super', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeInstanceOf(OllamaModelRoutingError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('OllamaModelRoutingError reports the model and the endpoints\' configured models', async () => {
    const client = new OllamaClient({
      endpoints: [
        { name: 'gpt-oss-key', baseUrl: 'http://a.local', models: ['gpt-oss:120b'] },
        { name: 'minimax-key', baseUrl: 'http://b.local', models: ['minimax-m3'] },
      ],
      fetch: vi.fn() as never,
    });

    try {
      await client.chat({ model: 'nemotron-3-super', messages: [{ role: 'user', content: 'hi' }] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaModelRoutingError);
      const error = err as OllamaModelRoutingError;
      expect(error.code).toBe('model_routing_error');
      expect(error.retryable).toBe(false);
      expect(error.model).toBe('nemotron-3-super');
      expect(error.availableModels.sort()).toEqual(['gpt-oss:120b', 'minimax-m3']);
    }
  });

  it('an unscoped endpoint (no `models`) remains eligible for every model', async () => {
    const fetchMock = jsonFetchMock(() => ({
      model: 'anything:1b',
      created_at: '2026-08-25T00:00:00Z',
      message: { role: 'assistant', content: 'ok' },
      done: true,
    }));

    const client = new OllamaClient({
      endpoints: [{ name: 'default', baseUrl: 'http://default.local' }],
      fetch: fetchMock as never,
    });

    const res = await client.chat({
      model: 'anything:1b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.message.content).toBe('ok');
  });

  it('still fails over between two credentials both authorized for the same model', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith('http://primary')) {
        return { ok: false, status: 503, json: async () => ({ error: 'overloaded' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'minimax-m3',
          created_at: '2026-08-25T00:00:00Z',
          message: { role: 'assistant', content: 'from backup key' },
          done: true,
        }),
      };
    });

    const client = new OllamaClient({
      endpoints: [
        { name: 'primary', baseUrl: 'http://primary.local', models: ['minimax-m3'] },
        { name: 'backup', baseUrl: 'http://backup.local', models: ['minimax-m3'] },
      ],
      retries: 0,
      fetch: fetchMock as never,
    });

    const res = await client.chat({
      model: 'minimax-m3',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.message.content).toBe('from backup key');
  });
});
