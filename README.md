| `OllamaUnsupportedCapabilityError` | `unsupported_capability`        | `false`     | A `format` (structured output) request was made against an endpoint inferred as Ollama Cloud, which doesn't currently support it. Thrown before any network call; in `DEFAULT_FAILOVER_CODES`, so a multi-endpoint setup tries the next candidate first. |
| `OllamaAgentMaxIterationsError`    | `agent_max_iterations_exceeded` | `false`     | An `Agent` run exceeded `maxTurns` without producing a final answer.                                                                                                                                                                                     |
| `OllamaIncompatibleModelError`      | `incompatible_model`     | `false`     | A tool-enabled Agent run was blocked by the model capability preflight because `/api/show` did not advertise `tools`. | 
| `OllamaMcpError`                   | `mcp_error`                     | varies      | An MCP `listTools`/`callTool` call failed.                                                                                                                                                                                                               |
| `OllamaSkillNotFoundError`         | `skill_not_found`               | `false`     | `applySkill` referenced a skill that isn't registered.                                                                                                                                                                                                   |
| `OllamaSkillInvalidError`          | `skill_invalid`                 | `false`     | A skill's frontmatter or contents failed to parse.                                                                                                                                                                                                       |
| `OllamaGenericClientError`         | `client_error`                  | `false`     | Any other non-2xx response not covered above.                                                                                                                                                                                                            |

All subclasses carry `status`, `retryable`, and optional `request`/`response` context, and preserve
the original error via the standard `cause` property:

```typescript
import { OllamaClientError, OllamaRateLimitError } from '@nemesis-oss/ollama-sdk';

try {
  await client.chatText({ model: 'qwen3:8b', messages: [...] });
} catch (err) {
  if (err instanceof OllamaRateLimitError) {
    console.warn(`Rate limited, retry after ${err.retryAfterMs}ms`);
  } else if (err instanceof OllamaClientError) {
    console.error(`[${err.code}] ${err.message}`, { retryable: err.retryable, cause: err.cause });
  } else {
    throw err;
  }
}

## MCP bridge

The SDK exposes a transport-neutral `McpBridge` that converts MCP `tools/list` descriptors into native Ollama function tools and registers executable MCP-backed tools.

- Paginated `tools/list` discovery follows `nextCursor`, with repeated-cursor and page-limit protection.
- MCP JSON Schema is preserved in the generated Ollama tool definition.
- `structuredContent` and non-text MCP content blocks are retained in the model-visible tool result.
- MCP `isError: true` results remain model-readable; they are not treated as transport failures.
- `AbortSignal` propagates through discovery and tool execution.
- The optional Node-only `@nemesis-oss/ollama-sdk/mcp/stdio` subpath uses the official MCP v2 stdio transport without importing Node-only code from the root package.

The MCP TypeScript SDK v2 implements the 2026-07-28 protocol revision. Its `listTools()` client path aggregates pagination, and `CallToolResult` represents tool failures as ordinary results with `isError`, while `structuredContent` is available for machine-readable output. citeturn0search0turn1search4turn0search6

### MCP stdio example

```typescript
import { connectStdioMcpClient } from '@nemesis-oss/ollama-sdk/mcp/stdio';
import { McpBridge, OllamaClient, ToolRegistry } from '@nemesis-oss/ollama-sdk';

const connection = await connectStdioMcpClient({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
});

const bridge = new McpBridge(connection.client, { namePrefix: 'mcp_' });
const registry = new ToolRegistry();
await bridge.register(registry);

const client = new OllamaClient();
const agent = client.agent({ tools: registry });
const result = await agent.run({
  model: 'qwen3',
  messages: [{ role: 'user', content: 'List the available files.' }],
});

await connection.close();
console.log(result.finalMessage.content);
```