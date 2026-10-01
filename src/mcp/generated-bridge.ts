/**
 * Generated Ollama MCP tools — runtime adapter.
 *
 * Reads the descriptor list from `src/generated/mcp/tools.json` (the Wave 6
 * MCP emitter output) and exposes them as a `McpToolDescriptor[]` that
 * `McpBridge` can register. The actual call execution delegates to the
 * generated `OllamaRuntime` via the user-provided runtime instance.
 *
 * Usage:
 * ```ts
 * import { NativeApi, OllamaRuntime } from '@nemesis-oss/ollama-sdk/runtime';
 * import { createGeneratedOllamaTools } from '@nemesis-oss/ollama-sdk/mcp/generated';
 *
 * const runtime = new OllamaRuntime({ http });
 * const tools = createGeneratedOllamaTools(runtime);
 * bridge.registerTools(tools);
 * ```
 *
 * This is a Wave 6 opt-in feature — the existing McpBridge continues to work
 * unchanged. Users who want generated MCP tools import this adapter
 * explicitly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { McpToolDescriptor } from './types.js';
import { OllamaRuntime } from '../generated/runtime/runtime.js';
import type { OperationDefinition } from '../generated/runtime/operation-definition.js';

interface GeneratedToolEntry extends McpToolDescriptor {
  readonly _operationId: string;
}

interface GeneratedToolsFile {
  readonly _comment?: string;
  readonly tools: readonly GeneratedToolEntry[];
}

// Path to the generated tools.json emitted by `npm run contract:generate`.
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_JSON_PATH = resolve(HERE, '../generated/mcp/tools.json');

let cachedTools: readonly GeneratedToolEntry[] | undefined;

/** Load and cache the generated tool descriptors from tools.json. */
export function loadGeneratedOllamaTools(): readonly GeneratedToolEntry[] {
  if (cachedTools) return cachedTools;
  const raw = readFileSync(TOOLS_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw) as GeneratedToolsFile;
  cachedTools = parsed.tools;
  return cachedTools;
}

/** Drop the `_operationId` field before exposing the descriptor externally. */
function publicDescriptor(entry: GeneratedToolEntry): McpToolDescriptor {
  const { _operationId, ...rest } = entry;
  void _operationId;
  return rest;
}

/**
 * Build a list of MCP tool descriptors for the generated Ollama operations.
 * Each tool can be invoked by name via {@link callGeneratedOllamaTool}.
 *
 * The descriptors are read once and cached for the lifetime of the process.
 */
export function listGeneratedOllamaTools(): readonly McpToolDescriptor[] {
  return loadGeneratedOllamaTools().map(publicDescriptor);
}

/**
 * Invoke a generated tool by name. The `name` must match a tool from
 * {@link listGeneratedOllamaTools}.
 *
 * Returns a `McpCallToolResult` containing the structured response. The
 * caller (typically `McpBridge`) is responsible for serializing the result
 * back over the MCP transport.
 */
export async function callGeneratedOllamaTool(
  runtime: OllamaRuntime,
  name: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<{ content: readonly { type: 'text'; text: string }[]; structuredContent: unknown }> {
  const tools = loadGeneratedOllamaTools();
  const entry = tools.find((t) => t.name === name);
  if (!entry) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      structuredContent: { error: 'unknown_tool', name },
    };
  }

  // Look up the operation in the IR by id. We re-import the operations
  // module to avoid a circular dependency at module-load time.
  const operations = await import('../generated/api/operations.js');
  const opKey = `${entry._operationId}Op` as keyof typeof operations;
  const operation = operations[opKey] as OperationDefinition | undefined;
  if (!operation || typeof operation !== 'object' || !('operationId' in operation)) {
    return {
      content: [{ type: 'text', text: `Operation not found for ${name}` }],
      structuredContent: { error: 'operation_not_found', name },
    };
  }

  try {
    const result = await runtime.invoke<unknown>({
      operation,
      body: args,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Ollama tool ${name} failed: ${message}` }],
      structuredContent: { error: 'tool_failed', name, message },
    };
  }
}
