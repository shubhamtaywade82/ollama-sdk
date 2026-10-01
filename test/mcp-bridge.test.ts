import { describe, expect, it, vi } from 'vitest';
import { McpBridge } from '../src/mcp/bridge.js';
import { loadMcpTools } from '../src/mcp/mcp-tools.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { OllamaToolValidationError } from '../src/errors.js';
import { z } from 'zod';
import type { McpClientLike, McpRequestOptions, McpTaskRequest } from '../src/mcp/types.js';

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
    const registry = new ToolRegistry(tools);

    const invalid = await registry.executeToolCall({
      id: 'call-invalid',
      function: { name: 'search', arguments: { limit: 0 } },
    });

    expect(invalid.success).toBe(false);
    if (invalid.success) throw new Error('expected invalid MCP arguments to fail validation');
    expect(invalid.error).toBeInstanceOf(OllamaToolValidationError);
    expect(callTool).not.toHaveBeenCalled();

    const valid = await registry.executeToolCall({
      id: 'call-valid',
      function: { name: 'search', arguments: { query: 'ollama', limit: 5 } },
    });

    expect(valid.success).toBe(true);
    if (!valid.success) throw new Error('expected valid MCP arguments to execute');
    expect(valid.outputString).toBe('ok');
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

  it('validates MCP structuredContent against the declared outputSchema', async () => {
    const client: McpClientLike = {
      listTools: async () => ({
        tools: [{
          name: 'lookup',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: {
            type: 'object',
            properties: { count: { type: 'integer', minimum: 0 } },
            required: ['count'],
            additionalProperties: false,
          },
        }],
      }),
      callTool: vi.fn()
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { count: 2 },
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'bad' }],
          structuredContent: { count: -1 },
        }),
    };

    const tools = await loadMcpTools(client);
    await expect(tools[0]!.execute({}, {})).resolves.toEqual('ok\n{"count":2}');

    await expect(tools[0]!.execute({}, {})).rejects.toMatchObject({
      code: 'mcp_error',
      mcpMethod: 'tools/call',
      toolName: 'lookup',
    });
  });

  it('allows disabling MCP outputSchema validation for legacy servers', async () => {
    const client: McpClientLike = {
      listTools: async () => ({
        tools: [{
          name: 'lookup',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: { type: 'object', required: ['count'] },
        }],
      }),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'legacy' }],
        structuredContent: { wrong: true },
      }),
    };

    const tools = await loadMcpTools(client, { validateOutputSchema: false });
    await expect(tools[0]!.execute({}, {})).resolves.toContain('legacy');
  });

  it('returns manual input_required responses without treating them as tool output', async () => {
    const response = {
      resultType: 'input_required' as const,
      inputRequests: {
        details: {
          method: 'elicitation/create',
          params: { mode: 'form', message: 'Provide a label', requestedSchema: { type: 'object' } },
        },
      },
      requestState: 'opaque-state',
    };
    const callTool = vi.fn().mockResolvedValue(response);
    const client: McpClientLike = {
      listTools: async () => ({
        tools: [{
          name: 'lookup',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: { type: 'object', required: ['result'] },
        }],
      }),
      callTool,
    };

    const tools = await loadMcpTools(client, { resultMode: 'structured' });
    await expect(tools[0]!.execute({}, {})).resolves.toEqual(response);
    expect(callTool).toHaveBeenCalledWith(
      { name: 'lookup', arguments: {} },
      { allowInputRequired: true },
    );
  });

  it('invokes required task-capable tools as tasks and returns task status', async () => {
    const taskResponse = {
      task: {
        taskId: 'task-1',
        status: 'input_required' as const,
        createdAt: '2026-10-01T00:00:00Z',
        lastUpdatedAt: '2026-10-01T00:00:00Z',
      },
    };
    const callTool = vi.fn().mockResolvedValue(taskResponse);
    const client: McpClientLike = {
      getServerCapabilities: () => ({ tasks: { requests: { tools: { call: {} } } } }),
      listTools: async () => ({
        tools: [{
          name: 'long_operation',
          inputSchema: { type: 'object', properties: {} },
          execution: { taskSupport: 'required' },
        }],
      }),
      callTool,
    };

    const tools = await loadMcpTools(client, { resultMode: 'structured', taskTtlMs: 30_000 });
    await expect(tools[0]!.execute({}, {})).resolves.toEqual(taskResponse);
    expect(callTool).toHaveBeenCalledWith(
      { name: 'long_operation', arguments: {}, task: { ttl: 30_000 } },
      { allowInputRequired: true },
    );
  });

  it('rejects required task tools when the server has not advertised task calls', async () => {
    const client: McpClientLike = {
      getServerCapabilities: () => ({}),
      listTools: async () => ({
        tools: [{
          name: 'long_operation',
          execution: { taskSupport: 'required' },
        }],
      }),
      callTool: vi.fn(),
    };

    await expect(loadMcpTools(client)).rejects.toMatchObject({
      code: 'mcp_error',
      mcpMethod: 'callTool',
      toolName: 'long_operation',
    });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('uses task execution for optional task-capable tools only when opted in', async () => {
    const callTool = vi.fn().mockResolvedValue({
      task: {
        taskId: 'task-optional',
        status: 'working',
        createdAt: '2026-10-01T00:00:00Z',
        lastUpdatedAt: '2026-10-01T00:00:00Z',
      },
    });
    const client: McpClientLike = {
      getServerCapabilities: () => ({ tasks: { requests: { tools: { call: {} } } } }),
      listTools: async () => ({
        tools: [{
          name: 'long_operation',
          execution: { taskSupport: 'optional' },
        }],
      }),
      callTool,
    };

    const tools = await loadMcpTools(client, { taskMode: 'all-supported' });
    await tools[0]!.execute({}, {});
    expect(callTool).toHaveBeenCalledWith(
      { name: 'long_operation', arguments: {}, task: {} },
      { allowInputRequired: true },
    );
  });

  it('exposes explicit task status, result, and cancellation operations', async () => {
    const request = vi.fn(async <T>(
      taskRequest: McpTaskRequest,
      resultSchema: z.ZodType<T>,
      _options?: McpRequestOptions,
    ) => {
      const response = taskRequest.method === 'tasks/result'
        ? { content: [{ type: 'text', text: 'done' }] }
        : {
            taskId: taskRequest.params.taskId,
            status: taskRequest.method === 'tasks/cancel' ? 'cancelled' : 'completed',
            createdAt: '2026-10-01T00:00:00Z',
            lastUpdatedAt: '2026-10-01T00:01:00Z',
          };
      return resultSchema.parse(response);
    });
    const bridge = new McpBridge({
      listTools: async () => ({ tools: [] }),
      callTool: vi.fn(),
      request,
    });

    await expect(bridge.getTaskStatus('task-1')).resolves.toMatchObject({
      taskId: 'task-1',
      status: 'completed',
    });
    await expect(bridge.getTaskResult('task-1')).resolves.toMatchObject({
      content: [{ text: 'done' }],
    });
    await expect(bridge.cancelTask('task-1')).resolves.toMatchObject({
      taskId: 'task-1',
      status: 'cancelled',
    });
    expect(request.mock.calls.map(([taskRequest]) => taskRequest.method)).toEqual([
      'tasks/get',
      'tasks/result',
      'tasks/cancel',
    ]);
  });

  it('refreshes MCP tools into an existing registry', async () => {
    const client: McpClientLike = {
      listTools: vi.fn()
        .mockResolvedValueOnce({
          tools: [{ name: 'one', inputSchema: { type: 'object', properties: {} } }],
        })
        .mockResolvedValueOnce({
          tools: [{ name: 'two', inputSchema: { type: 'object', properties: {} } }],
        }),
      callTool: vi.fn(),
    };
    const registry = new ToolRegistry();
    const bridge = new McpBridge(client);

    await bridge.register(registry);
    expect(registry.get('one')).toBeDefined();

    await bridge.refresh(registry);
    expect(registry.get('two')).toBeDefined();
    expect(registry.get('one')).toBeDefined();
  });

  it('rejects duplicate MCP tool names instead of silently overwriting them', async () => {
    const client: McpClientLike = {
      listTools: async () => ({
        tools: [
          { name: 'duplicate', inputSchema: { type: 'object', properties: {} } },
          { name: 'duplicate', inputSchema: { type: 'object', properties: {} } },
        ],
      }),
      callTool: vi.fn(),
    };

    await expect(new McpBridge(client).definitions()).rejects.toMatchObject({
      code: 'mcp_error',
      mcpMethod: 'listTools',
    });
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
      { signal: controller.signal, allowInputRequired: true },
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
