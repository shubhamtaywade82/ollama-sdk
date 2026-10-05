import { afterEach, describe, expect, it } from 'vitest';
import { OllamaClient } from '../src/client.js';

describe('OLLAMA_HOST / OLLAMA_API_KEY environment fallback', () => {
  const originalHost = process.env['OLLAMA_HOST'];
  const originalApiKey = process.env['OLLAMA_API_KEY'];

  afterEach(() => {
    if (originalHost === undefined) delete process.env['OLLAMA_HOST'];
    else process.env['OLLAMA_HOST'] = originalHost;
    if (originalApiKey === undefined) delete process.env['OLLAMA_API_KEY'];
    else process.env['OLLAMA_API_KEY'] = originalApiKey;
  });

  it('falls back to OLLAMA_HOST when config.baseUrl is not provided', () => {
    process.env['OLLAMA_HOST'] = 'http://env-host:9999';
    delete process.env['OLLAMA_API_KEY'];

    const client = new OllamaClient();

    expect(client.registry.list()[0]?.baseUrl).toBe('http://env-host:9999');
  });

  it('falls back to OLLAMA_API_KEY when config.apiKey is not provided', () => {
    delete process.env['OLLAMA_HOST'];
    process.env['OLLAMA_API_KEY'] = 'env-secret';

    const client = new OllamaClient();

    expect(client.registry.list()[0]?.apiKey).toBe('env-secret');
  });

  it('prefers explicit config over environment variables', () => {
    process.env['OLLAMA_HOST'] = 'http://env-host:9999';
    process.env['OLLAMA_API_KEY'] = 'env-secret';

    const client = new OllamaClient({ baseUrl: 'http://explicit:1111', apiKey: 'explicit-key' });
    const endpoint = client.registry.list()[0];

    expect(endpoint?.baseUrl).toBe('http://explicit:1111');
    expect(endpoint?.apiKey).toBe('explicit-key');
  });

  it('defaults to localhost with no apiKey when nothing is configured', () => {
    delete process.env['OLLAMA_HOST'];
    delete process.env['OLLAMA_API_KEY'];

    const client = new OllamaClient();
    const endpoint = client.registry.list()[0];

    expect(endpoint?.baseUrl).toBe('http://localhost:11434');
    expect(endpoint?.apiKey).toBeUndefined();
  });

  it('does not apply env var fallback when explicit endpoints are provided', () => {
    process.env['OLLAMA_HOST'] = 'http://env-host:9999';

    const client = new OllamaClient({
      endpoints: [{ name: 'explicit', baseUrl: 'http://explicit-endpoint:1111' }],
    });

    expect(client.registry.list()[0]?.baseUrl).toBe('http://explicit-endpoint:1111');
  });

  it('normalizes a bare host:port OLLAMA_HOST into a full base URL', () => {
    process.env['OLLAMA_HOST'] = '127.0.0.1:11434';
    delete process.env['OLLAMA_API_KEY'];

    expect(new OllamaClient().registry.list()[0]?.baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('sends requests to the normalized URL for a bare host:port baseUrl', async () => {
    delete process.env['OLLAMA_HOST'];
    delete process.env['OLLAMA_API_KEY'];
    const urls: string[] = [];
    const client = new OllamaClient({
      baseUrl: 'myhost:8080',
      retries: 0,
      fetch: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }) as typeof fetch,
    });

    await client.modelsClient.list().catch(() => undefined);

    expect(urls[0]).toMatch(/^http:\/\/myhost:8080\/api\//);
  });

  it('applies OLLAMA_API_KEY to loopback and Ollama Cloud hosts', () => {
    process.env['OLLAMA_API_KEY'] = 'env-secret';

    for (const baseUrl of ['localhost:11434', 'https://ollama.com']) {
      expect(new OllamaClient({ baseUrl }).registry.list()[0]?.apiKey).toBe('env-secret');
    }
  });

  it('does not forward OLLAMA_API_KEY to an arbitrary third-party host', () => {
    process.env['OLLAMA_API_KEY'] = 'env-secret';

    for (const baseUrl of ['https://api.third-party.example', 'http://192.168.1.10:11434']) {
      expect(new OllamaClient({ baseUrl }).registry.list()[0]?.apiKey).toBeUndefined();
    }
  });

  it('still forwards an explicit apiKey to any host', () => {
    process.env['OLLAMA_API_KEY'] = 'env-secret';

    const client = new OllamaClient({ baseUrl: 'https://api.third-party.example', apiKey: 'mine' });

    expect(client.registry.list()[0]?.apiKey).toBe('mine');
  });
});
