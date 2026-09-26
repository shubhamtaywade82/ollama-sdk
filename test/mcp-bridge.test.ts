import { describe, expect, it, vi } from 'vitest';
import { McpBridge } from '../src/mcp/bridge.js';
import { loadMcpTools } from '../src/mcp/mcp-tools.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { McpClientLike } from '../src/mcp/types.js';

describe('MCP bridge parity', () => {
  it('discovers all paginated tools and preserves MCP JSON Schema', async () => {
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({
        tools: [
          {
            name: 'search',
            title: 'Search',
            description: 'Search documents',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
              additionalProperties: false,
            },
            outputSchema: {
              type: 'object',
              properties: { count: { type: 'integer' } },
            },
          },
        ],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        tools: [
          {
            name: 'read',
            description: 'Read a document',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
          },
        ],
      });

    const client: McpClientLike = { listTools, callTool: vi.fn() };
    const bridge = new McpBridge(client);
    const definitions = await bridge.definitions();

    expect(listTools).toHaveBeenNthCalledWith(1);
    expect(listTools).toHaveBeenNthCalledWith(2, { cursor: 'page-2' });
    expect(definitions).toHaveLength(2);
    expect(definitions[0]?.function.name).toBe('search');
    expect(definitions[0]?.function.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      additionalProperties: false,
    });
  });

  it('preserves structured and non-text MCP result blocks for the model', async () => {
    const client: McpClientLike = {
      listTools: async () => ({
        tools: [{ name: 'inspect', inputSchema: { type: 'object', properties: {} } }],
      }),
      callTool: vi.fn().mockResolvedValue({
        content: [
          { type: 'text', text: 'primary result' },
          { type: 'resource_link', uri: 'file:///tmp/a.txt', name: 'a.txt' },
          { type: 'image', data: 'base64', mimeType: 'image/png' },
        ],
        structuredContent: { ok: true, count: 2 },
      }),
    };

    const tools = await loadMcpTools(client);
    const result = await tools[0]!.execute({}, {});

    expect(result).toContain('primary result');
    expect(result).toContain('"type":"resource_link"');
    expect(result).toContain('"mimeType":"image/png"');
    expect(result).toContain('"ok":true');
  });

  it('registers every page of MCP tools into the registry', async () => {
    const client: McpClientLike = {
      listTools: vi
        .fn()
        .mockResolvedValueOnce({
          tools: [{ name: 'one', inputSchema: { type: 'object', properties: {} } }],
          nextCursor: 'next',
        })
        .mockResolvedValueOnce({
          tools: [{ name: 'two', inputSchema: { type: 'object', properties: {} } }],
        }),
      callTool: vi.fn(),
    };
    const registry = new ToolRegistry();
    await new McpBridge(client).register(registry);
    expect(registry.get('one')).toBeDefined();
    expect(registry.get('two')).toBeDefined();
  });
});
