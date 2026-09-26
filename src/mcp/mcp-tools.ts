/**
 * Converts MCP tools into Ollama-compatible tools.
 */

import { z } from 'zod';
import { OllamaMcpError } from '../errors.js';
import type { AnyTool } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { McpCallToolResult, McpClientLike, McpToolDescriptor } from './types.js';
import type { ToolDefinition, ToolProperty } from '../types.js';

export interface LoadMcpToolsOptions {
  readonly namePrefix?: string;
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

  return parts.join('\n');
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
    execute: async (args: Record<string, unknown>) => {
      try {
        const result = await mcpClient.callTool({
          name: descriptor.name,
          arguments: args,
        });

        if (result.isError) {
          throw new OllamaMcpError(`MCP tool "${descriptor.name}" returned error`, {
            mcpMethod: 'callTool',
            toolName: descriptor.name,
          });
        }

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
): Promise<AnyTool[]> {
  try {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;

    do {
      const page = await mcpClient.listTools(cursor !== undefined ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);

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
): Promise<void> {
  const tools = await loadMcpTools(mcpClient, options);
  registry.registerMany(tools);
}
