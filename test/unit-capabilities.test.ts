import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/transport/http.js';
import { detectModelCapabilities, inferRuntimeMode } from '../src/capabilities/capabilities.js';
import { OllamaClient } from '../src/client.js';

function showResponseFetch(capabilities: readonly string[]): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ capabilities }),
  });
}

describe('detectModelCapabilities', () => {
  it('reports supportsThinking when the model reports the "thinking" capability', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch(['completion', 'thinking']) as never,
    });

    const caps = await detectModelCapabilities(http, 'deepseek-r1');

    expect(caps.supportsThinking).toBe(true);
  });

  it('does not report supportsThinking for models that omit it', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch(['completion']) as never,
    });

    const caps = await detectModelCapabilities(http, 'llama3.2');

    expect(caps.supportsThinking).toBe(false);
  });

  it('infers supportsStructuredOutputRequest as false for a cloud endpoint', async () => {
    const http = new HttpClient({
      baseUrl: 'https://ollama.com',
      fetch: showResponseFetch(['completion']) as never,
    });

    const caps = await detectModelCapabilities(http, 'llama3.2');

    expect(inferRuntimeMode(http.baseUrl)).toBe('cloud');
    expect(caps.supportsStructuredOutputRequest).toBe(false);
  });

  it('infers supportsStructuredOutputRequest as true for a local endpoint', async () => {
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: showResponseFetch(['completion']) as never,
    });

    const caps = await detectModelCapabilities(http, 'llama3.2');

    expect(inferRuntimeMode(http.baseUrl)).toBe('local');
    expect(caps.supportsStructuredOutputRequest).toBe(true);
  });
});

describe('inferRuntimeMode', () => {
  it.each([
    'http://localhost:11434',
    'http://127.0.0.1:11434',
    'http://[::1]:11434',
    'http://[::1]',
    'http://192.168.1.20:11434',
    'http://10.0.0.5:11434',
    'http://172.17.0.1:11434',
    'http://172.31.255.1:11434',
    'http://[fd00::1]:11434',
    'http://box.local:11434',
    'http://ollama.internal:11434',
    'http://host.docker.internal:11434',
    // Single-label Docker / Kubernetes service name, as in docker-compose
    'http://ollama:11434',
  ])('classifies %s as local', (url) => {
    expect(inferRuntimeMode(url)).toBe('local');
  });

  it.each(['https://ollama.com', 'https://api.ollama.com'])('classifies %s as cloud', (url) => {
    expect(inferRuntimeMode(url)).toBe('cloud');
  });

  it.each([
    // Self-hosted servers on public domains are not refused as cloud
    'http://gpu-box.example.net:11434',
    'https://llm.mycompany.com',
    // Public IPv6 must not be mistaken for loopback by the bracket handling
    'http://[2001:db8::1]:11434',
    // Just outside 172.16.0.0/12
    'http://172.32.0.1:11434',
    // A hostname that starts like an address is not an address
    'http://10.example.com:11434',
    // Suffix lookalikes of ollama.com are not Ollama Cloud
    'http://ollama.com.evil.net:11434',
    'http://evilollama.com:11434',
  ])('classifies %s as unknown', (url) => {
    expect(inferRuntimeMode(url)).toBe('unknown');
  });

  it('classifies an unparseable base URL as unknown', () => {
    expect(inferRuntimeMode('not a url')).toBe('unknown');
  });

  it('lets structured output through to an IPv6 loopback endpoint instead of refusing it as cloud', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ model: 'm', created_at: '', response: '{"a":1}', done: true }),
      text: async () =>
        JSON.stringify({ model: 'm', created_at: '', response: '{"a":1}', done: true }),
    });
    const client = new OllamaClient({
      baseUrl: 'http://[::1]:11434',
      fetch: fetchMock as never,
      retries: 0,
    });
    await expect(client.generateText({ model: 'm', prompt: 'p', format: 'json' })).resolves.toBe(
      '{"a":1}',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('embed() dimensions passthrough', () => {
  it('forwards the dimensions option in the /api/embed request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ model: 'nomic-embed-text', embeddings: [[0.1, 0.2]] }),
    });
    const client = new OllamaClient({ fetch: fetchMock as never });

    await client.embed({ model: 'nomic-embed-text', input: 'hello', dimensions: 256 });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body).dimensions).toBe(256);
  });
});
