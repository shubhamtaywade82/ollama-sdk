/**
 * Converts MCP tools into Ollama-compatible tools.
 */

import { z } from 'zod';
import { validateJsonSchema } from './json-schema.js';
import { OllamaMcpError } from '../errors.js';
import type { AnyTool } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type {
  McpClientLike,
  McpListToolsParams,
  McpRequestOptions,
  McpToolCallResult,
  McpToolDescriptor,
} from './types.js';
import type { ToolDefinition, ToolProperty } from '../types.js';

export type McpToolResultMode = 'text' | 'structured';

export interface LoadMcpToolsOptions {
  readonly namePrefix?: string | undefined;
  /** Maximum number of paginated tools/list responses to traverse. */
  readonly maxPages?: number | undefined;
  /**
   * Return MCP's raw CallToolResult to programmatic callers instead of the legacy
   * model-oriented text representation. The default preserves existing behavior.
   */
  readonly resultMode?: McpToolResultMode | undefined;
  /** Validate structuredContent against a tool's MCP outputSchema. Defaults to true. */
  readonly validateOutputSchema?: boolean | undefined;
  /** Invoke optional task-capable tools as legacy MCP tasks when supported. */
  readonly taskMode?: 'required-only' | 'all-supported' | undefined;
  /** Requested lifetime for legacy task-augmented tool calls, in milliseconds. */
  readonly taskTtlMs?: number | undefined;
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
    const pageNames = new Set<string>();
    for (const tool of page.tools) {
      if (pageNames.has(tool.name)) {
        throw new OllamaMcpError(
          `MCP tools/list returned duplicate tool name "${tool.name}"`,
          { mcpMethod: 'listTools', toolName: tool.name },
        );
      }
      pageNames.add(tool.name);
      if (tools.some((existing) => existing.name === tool.name)) {
        throw new OllamaMcpError(
          `MCP tools/list returned duplicate tool name "${tool.name}" across pages`,
          { mcpMethod: 'listTools', toolName: tool.name },
        );
      }
    }
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

function formatMcpToolResult(result: McpToolCallResult): string {
  if ('resultType' in result || 'task' in result) {
    return JSON.stringify(result) ?? String(result);
  }

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

  return parts.join('\n');
}

function supportsTaskCalls(mcpClient: McpClientLike): boolean {
  return mcpClient.getServerCapabilities?.()?.tasks?.requests?.tools?.call !== undefined;
}

function shouldCallAsTask(
  descriptor: McpToolDescriptor,
  options: LoadMcpToolsOptions,
  serverSupportsTasks: boolean,
): boolean {
  const support = descriptor.execution?.taskSupport;
  if (support === 'required' && !serverSupportsTasks) {
    throw new OllamaMcpError(
      `MCP tool "${descriptor.name}" requires task execution, but the server does not advertise tasks.requests.tools.call`,
      { mcpMethod: 'callTool', toolName: descriptor.name },
    );
  }
  if (!serverSupportsTasks || support === undefined || support === 'forbidden') return false;
  return support === 'required' || options.taskMode === 'all-supported';
}

function createInputValidator(inputSchema: Record<string, unknown>): z.ZodType<Record<string, unknown>> {
  return z.custom<Record<string, unknown>>().superRefine((value, ctx) => {
    const issues = validateJsonSchema(value, inputSchema);
    for (const issue of issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...issue.path],
        message: issue.message,
      });
    }
  });
}

function convertMcpDescriptorToTool(
  descriptor: McpToolDescriptor,
  mcpClient: McpClientLike,
  namePrefix = '',
  resultMode: McpToolResultMode = 'text',
  validateOutputSchema = true,
  executeAsTask = false,
  taskTtlMs?: number,
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
    schema: createInputValidator(inputSchema),
    execute: async (args: Record<string, unknown>, context: { readonly signal?: AbortSignal | undefined }) => {
      try {
        const result = await mcpClient.callTool(
          {
            name: descriptor.name,
            arguments: args,
            ...(executeAsTask
              ? { task: taskTtlMs !== undefined ? { ttl: taskTtlMs } : {} }
              : {}),
          },
          {
            ...(context.signal !== undefined ? { signal: context.signal } : {}),
            allowInputRequired: true,
          },
        );

        if (
          !('resultType' in result) &&
          !('task' in result) &&
          validateOutputSchema &&
          descriptor.outputSchema !== undefined &&
          result.structuredContent !== undefined
        ) {
          const issues = validateJsonSchema(result.structuredContent, descriptor.outputSchema);
          if (issues.length > 0) {
            throw new OllamaMcpError(
              `MCP tool "${descriptor.name}" returned structuredContent that violates outputSchema`,
              {
                mcpMethod: 'tools/call',
                toolName: descriptor.name,
                issues,
              },
            );
          }
        }

        // MCP tool failures are ordinary CallToolResult values, not transport failures.
        // Keep the result model-readable so the agent can observe the error and recover.
        return resultMode === 'structured' ? result : formatMcpToolResult(result);
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
    if (
      options.taskTtlMs !== undefined &&
      (!Number.isFinite(options.taskTtlMs) || options.taskTtlMs <= 0)
    ) {
      throw new RangeError('MCP taskTtlMs must be a positive finite number');
    }
    const tools = await listAllMcpTools(mcpClient, options, signal);
    const serverSupportsTasks = supportsTaskCalls(mcpClient);
    return tools.map((tool) => {
      const taskCall = shouldCallAsTask(
        tool,
        options,
        serverSupportsTasks,
      );
      return convertMcpDescriptorToTool(
        tool,
        mcpClient,
        options.namePrefix,
        options.resultMode,
        options.validateOutputSchema ?? true,
        taskCall,
        options.taskTtlMs,
      );
    });
  } catch (err) {
    if (err instanceof OllamaMcpError) throw err;
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
