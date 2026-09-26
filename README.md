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