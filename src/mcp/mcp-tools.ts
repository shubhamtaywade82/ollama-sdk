/**
 * Converts MCP tools into Ollama-compatible tools.
 */

import { z } from 'zod';
import { OllamaMcpError } from '../errors.js';
import type { AnyTool } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { McpCallToolResult, McpClientLike, McpListToolsParams, McpRequestOptions, McpToolDescriptor } from './types.js';
import type { ToolDefinition, ToolProperty } from '../types.js';

export interface LoadMcpToolsOptions {
  readonly namePrefix?: string | undefined;
  /** Maximum number of paginated tools/list responses to traverse. */
  readonly maxPages?: number | undefined;
}

function resolveMaxPages(options: LoadMcpToolsOptions): number {
  const maxPages = options.maxPages ?? 64;
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new RangeError('MCP maxPages must be a positive integer');
  }
  return maxPages;
}

export async function listAllMcpTools(
  mcpClient: McpClientLike,
  options: LoadMcpToolsOptions = {},
  signal?: AbortSignal,
): Promise<McpToolDescriptor[]> {
  const maxPages = resolveMaxPages(options);
  const tools: McpToolDescriptor[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const params: McpListToolsParams | undefined =
      cursor !== undefined ? { cursor } : undefined;
    const requestOptions: McpRequestOptions | undefined =
      signal !== undefined ? { signal } : undefined;
    const page = await mcpClient.listTools(params, requestOptions);
    tools.push(...page.tools);

    if (page.nextCursor === undefined) {
      return tools;
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('MCP tools/list returned a repeated nextCursor');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  throw new Error('MCP tools/list exceeded maxPages (' + maxPages + ')');
}

function formatMcpToolResult(result: McpCallToolResult): string {
  const parts = result.content.map((block) => {
    if (block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
    try {
      return JSON.stringify(block);
    } catch {
      return `[${block.type}]`;
    }
  });

  if (result.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(result.structuredContent));
    } catch {
      // Preserve the regular content if structuredContent cannot be serialized.
    }
  }

  if (result.isError) {
    parts.unshift('[MCP tool error]');
  }

  return parts.join('\\n');
}

function convertMcpDescriptorToTool(
  descriptor: McpToolDescriptor,
  mcpClient: McpClientLike,
  namePrefix = '',
): AnyTool {
  const toolName = `${namePrefix}${descriptor.name}`;
  const inputSchema = descriptor.inputSchema ?? { type: 'object', properties: {} };
  const properties = (inputSchema['properties'] ?? {}) as Record<string, ToolProperty>;
  const required = (inputSchema['required'] ?? []) as string[];
  const parameters = {
    ...inputSchema,
    type: 'object' as const,
    properties,
    ...(required.length > 0 ? { required } : {}),
  } as ToolDefinition['function']['parameters'];

  return {
    name: toolName,
    description: descriptor.description ?? '',
    schema: z.record(z.string(), z.unknown()),
    execute: async (args: Record<string, unknown>, context: { readonly signal?: AbortSignal | undefined }) => {
      try {
        const result = await mcpClient.callTool(
          {
            name: descriptor.name,
            arguments: args,
          },
          context.signal !== undefined ? { signal: context.signal } : undefined,
        );

        // MCP tool failures are ordinary CallToolResult values, not transport failures.
        // Keep the result model-readable so the agent can observe the error and recover.
        return formatMcpToolResult(result);
      } catch (err) {
        if (err instanceof OllamaMcpError) throw err;
        throw new OllamaMcpError(`Failed calling MCP tool "${descriptor.name}"`, {
          mcpMethod: 'callTool',
          toolName: descriptor.name,
          cause: err,
        });
      }
    },
    definition: {
      type: 'function',
      function: {
        name: toolName,
        description: descriptor.description ?? '',
        parameters,
      },
    },
  };
}

export async function loadMcpTools(
  mcpClient: McpClientLike,
  options: LoadMcpToolsOptions = {},
  signal?: AbortSignal,
): Promise<AnyTool[]> {
  try {
    const tools = await listAllMcpTools(mcpClient, options, signal);
    return tools.map((t) => convertMcpDescriptorToTool(t, mcpClient, options.namePrefix));
  } catch (err) {
    throw new OllamaMcpError('Failed listing MCP tools from client', {
      mcpMethod: 'listTools',
      cause: err,
    });
  }
}

export async function registerMcpTools(
  registry: ToolRegistry,
  mcpClient: McpClientLike,
  options: LoadMcpToolsOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  const tools = await loadMcpTools(mcpClient, options, signal);
  registry.registerMany(tools);
}
