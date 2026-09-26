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

  it('preserves arbitrary MCP JSON Schema keywords in the Ollama tool definition', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          type: 'string',
          enum: ['a', 'b'],
          anyOf: [{ type: 'string' }, { type: 'null' }],
        },
      },
      required: ['value'],
      additionalProperties: false,
      $defs: {
        value: { type: 'string' },
      },
    };

    const definitions = McpBridge.toOllamaTools([
      {
        name: 'structured_tool',
        inputSchema: schema,
      },
    ]);

    expect(definitions[0]?.function.parameters).toEqual(schema);
  });

  it('loads and registers MCP-backed tools without losing the original MCP name', async () => {
    const client: McpClientLike = {
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            inputSchema: {
              type: 'object',
              properties: {
                path: { type: 'string' },
              },
              required: ['path'],
              additionalProperties: false,
              $defs: {
                path: { type: 'string' },
              },
            },
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
    expect(registry.get('mcp_read_file')?.definition.function.parameters).toMatchObject({
      additionalProperties: false,
      $defs: {
        path: { type: 'string' },
      },
    });
  });
});
