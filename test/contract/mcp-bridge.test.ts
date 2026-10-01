import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../src/transport/http.js';
import { OllamaRuntime } from '../../src/generated/runtime/runtime.js';
import {
  listGeneratedOllamaTools,
  callGeneratedOllamaTool,
} from '../../src/mcp/generated-bridge.js';

function mockFetch(response: unknown, status = 200): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

describe('Wave 6: generated MCP bridge end-to-end', () => {
  it('listGeneratedOllamaTools returns every documented operation', () => {
    const tools = listGeneratedOllamaTools();
    // The IR has 21 operations total; all are documented, so all 21 should
    // appear as MCP tools. (If systemOne's documented flag changes, this
    // count will need to update.)
    expect(tools.length).toBeGreaterThanOrEqual(20);
    expect(tools.some((t) => t.name === 'ollama_chat')).toBe(true);
    expect(tools.some((t) => t.name === 'ollama_version')).toBe(true);
  });

  it('callGeneratedOllamaTool delegates to OllamaRuntime.invoke', async () => {
    const fetchImpl = mockFetch({ version: '0.5.0' });
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http });

    const result = await callGeneratedOllamaTool(runtime, 'ollama_version', {});

    expect(result.content[0]?.type).toBe('text');
    expect(result.content[0]?.text).toContain('version');
    expect(result.structuredContent).toMatchObject({ version: '0.5.0' });
  });

  it('returns a structured error for unknown tool names', async () => {
    const fetchImpl = mockFetch({});
    const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });
    const runtime = new OllamaRuntime({ http });

    const result = await callGeneratedOllamaTool(runtime, 'ollama_nonexistent', {});
    expect(result.structuredContent).toMatchObject({ error: 'unknown_tool' });
  });
});
