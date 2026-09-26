import { describe, expect, it, vi } from 'vitest';
import { McpBridge } from '../src/mcp/bridge.js';
import { loadMcpTools } from '../src/mcp/mcp-tools.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { OllamaToolValidationError } from '../src/errors.js';
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

    expect(listTools).toHaveBeenNthCalledWith(1, undefined, undefined);
    expect(listTools).toHaveBeenNthCalledWith(2, { cursor: 'page-2' }, undefined);
    expect(definitions).toHaveLength(2);
    expect(definitions[0]?.function.name).toBe('search');
    expect(definitions[0]?.function.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      additionalProperties: false,
    });
  });

  it('keeps MCP isError results model-readable instead of treating them as transport failures', async () => {
    const client: McpClientLike = {
      listTools: async () => ({
        tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: {} } }],
      }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'No matching record' }],
        structuredContent: { matches: 0 },
        isError: true,
      }),
    };

    const tools = await loadMcpTools(client);
    const result = await tools[0]!.execute({}, {});

    expect(result).toContain('[MCP tool error]');
    expect(result).toContain('No matching record');
    expect(result).toContain('{"matches":0}');
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

  it('validates model tool arguments against the MCP input schema before calling the server', async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });
    const client: McpClientLike = {
      listTools: async () => ({
        tools: [{
          name: 'search',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', minLength: 3 },
              limit: { type: 'integer', minimum: 1 },
            },
            required: ['query'],
            additionalProperties: false,
          },
        }],
      }),
      callTool,
    };

    const tools = await loadMcpTools(client);

    await expect(
      tools[0]!.execute({ limit: 0 }, {}),
    ).rejects.toBeInstanceOf(OllamaToolValidationError);

    expect(callTool).not.toHaveBeenCalled();

    await expect(
      tools[0]!.execute({ query: 'ollama', limit: 5 }, {}),
    ).resolves.toBe('ok');
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('returns the raw MCP CallToolResult when structured result mode is enabled', async () => {
    const rawResult = {
      content: [
        { type: 'text', text: 'primary result' },
        { type: 'resource_link', uri: 'file:///tmp/a.txt' },
      ],
      structuredContent: { ok: true, count: 2 },
      isError: false,
      _meta: { source: 'test' },
    };
    const client: McpClientLike = {
      listTools: async () => ({
        tools: [{
          name: 'inspect',
          inputSchema: { type: 'object', properties: {} },
        }],
      }),
      callTool: vi.fn().mockResolvedValue(rawResult),
    };

    const tools = await loadMcpTools(client, { resultMode: 'structured' });
    const result = await tools[0]!.execute({}, {});

    expect(result).toEqual(rawResult);
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


describe('MCP bridge safety and cancellation', () => {
  it('forwards AbortSignal to listTools and callTool', async () => {
    const controller = new AbortController();
    const listTools = vi.fn(async (_params?: unknown, options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBe(controller.signal);
      return {
        tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
      };
    });
    const callTool = vi.fn(async (
      _params: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      expect(options?.signal).toBe(controller.signal);
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const client: McpClientLike = { listTools, callTool };
    const tools = await loadMcpTools(client, {}, controller.signal);
    await tools[0]!.execute({}, { signal: controller.signal });

    expect(listTools).toHaveBeenCalledWith(undefined, { signal: controller.signal });
    expect(callTool).toHaveBeenCalledWith(
      { name: 'echo', arguments: {} },
      { signal: controller.signal },
    );
  });

  it('rejects paginated cursor loops instead of spinning forever', async () => {
    const listTools = vi.fn().mockResolvedValue({
      tools: [{ name: 'one' }],
      nextCursor: 'same',
    });
    const client: McpClientLike = { listTools, callTool: vi.fn() };

    await expect(loadMcpTools(client)).rejects.toMatchObject({
      code: 'mcp_error',
      mcpMethod: 'listTools',
    });
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it('enforces a configurable maximum page count', async () => {
    const listTools = vi.fn().mockResolvedValue({
      tools: [{ name: 'one' }],
      nextCursor: 'next',
    });
    const client: McpClientLike = { listTools, callTool: vi.fn() };

    await expect(
      loadMcpTools(client, { maxPages: 2 }),
    ).rejects.toMatchObject({
      code: 'mcp_error',
      mcpMethod: 'listTools',
    });
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it('preserves structuredContent values that are falsy but valid JSON', async () => {
    for (const structuredContent of [null, false, 0, '']) {
      const client: McpClientLike = {
        listTools: async () => ({
          tools: [{ name: 'inspect', inputSchema: { type: 'object', properties: {} } }],
        }),
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'content' }],
          structuredContent,
        }),
      };

      const tools = await loadMcpTools(client);
      const result = await tools[0]!.execute({}, {});
      expect(result).toContain(JSON.stringify(structuredContent));
    }
  });
});
