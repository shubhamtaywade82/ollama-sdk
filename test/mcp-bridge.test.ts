import { describe, expect, it, vi } from 'vitest';
import { McpBridge } from '../src/mcp/bridge.js';
import type { McpClientLike } from '../src/mcp/types.js';
import { ToolRegistry } from '../src/tools/registry.js';

describe('McpBridge', () => {
  it('converts MCP tool manifests to native Ollama function definitions', () => {
    const definitions = McpBridge.toOllamaTools([
      {
        name: 'get_weather',
        description: 'Get weather',
        inputSchema: {
          type: 'object',
          properties: {
            city: { type: 'string' },
          },
          required: ['city'],
        },
      },
    ]);

    expect(definitions).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string' },
            },
            required: ['city'],
          },
        },
      },
    ]);
  });

  it('loads and registers MCP-backed tools without losing the original MCP name', async () => {
    const client: McpClientLike = {
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            inputSchema: { type: 'object' },
          },
        ],
      }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'hello' }],
      }),
    };
    const registry = new ToolRegistry();
    const bridge = new McpBridge(client, { namePrefix: 'mcp_' });

    await bridge.register(registry);

    const result = await registry.executeToolCall({
      function: { name: 'mcp_read_file', arguments: {} },
    });

    expect(result.success).toBe(true);
    expect(result.outputString).toBe('hello');
    expect(client.callTool).toHaveBeenCalledWith({
      name: 'read_file',
      arguments: {},
    });
  });
});
