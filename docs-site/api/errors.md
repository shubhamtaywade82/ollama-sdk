---
outline: [2, 3]
---

# Errors

Every failure thrown by the client is an `OllamaClientError` subclass, so you can catch the base class or narrow to a specific `code`. All subclasses carry `status`, `retryable`, and optional `request`/`response` context, and preserve the original error via the standard `cause` property.

## The base class

```typescript
class OllamaClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly request?: OllamaErrorRequestContext;
  readonly response?: OllamaErrorResponseContext;
  constructor(message: string, options: OllamaClientErrorOptions);
}
```

| Field       | Type                           | Description                                                   |
| ----------- | ------------------------------ | ------------------------------------------------------------- |
| `code`      | `string`                       | Stable error code (e.g. `'network_error'`, `'rate_limited'`). |
| `status`    | `number \| undefined`          | HTTP status code, when the error came from a response.        |
| `retryable` | `boolean`                      | Whether retrying the same request might succeed.              |
| `request`   | `{ method?, url?, model? }`    | The request that triggered the error (best-effort).           |
| `response`  | `{ status?, headers?, body? }` | The response that triggered the error (when applicable).      |
| `cause`     | `unknown`                      | The underlying error (via `Error.cause`).                     |

## Error hierarchy

### Network and transport

#### `OllamaNetworkError`

```typescript
class OllamaNetworkError extends OllamaClientError {
  // code: 'network_error', retryable: true
}
```

The request failed before a response was received (DNS, connection refused, TLS, etc.). Always `retryable: true` — failover applies.

#### `OllamaTimeoutError`

```typescript
class OllamaTimeoutError extends OllamaClientError {
  readonly timeoutMs?: number;
  // code: 'timeout', retryable: true
}
```

The request exceeded `timeoutMs`. Carries the configured timeout value. `retryable: true` — failover applies.

#### `OllamaAbortError`

```typescript
class OllamaAbortError extends OllamaClientError {
  // code: 'aborted', retryable: false
}
```

The request was cancelled via `AbortSignal` (or `stream.abort()`). `retryable: false` — the caller cancelled it; failover doesn't apply.

### HTTP status errors

#### `OllamaAuthError`

```typescript
class OllamaAuthError extends OllamaClientError {
  // code: 'auth_error', retryable: false
}
```

The endpoint returned `401` or `403`. `retryable: false` for the same credential, but `auth_error` is in `DEFAULT_FAILOVER_CODES`, so a multi-endpoint setup tries the next candidate.

#### `OllamaNotFoundError`

```typescript
class OllamaNotFoundError extends OllamaClientError {
  // code: 'not_found', retryable: false
}
```

The endpoint returned `404` — typically an unknown model. Verify the model name with `client.listModels()`.

#### `OllamaRateLimitError`

```typescript
class OllamaRateLimitError extends OllamaClientError {
  readonly retryAfterMs?: number;
  // code: 'rate_limited', retryable: true
}
```

The endpoint returned `429`. Carries `retryAfterMs` parsed from the `Retry-After` header when present. `retryable: true` — failover applies.

#### `OllamaServerError`

```typescript
class OllamaServerError extends OllamaClientError {
  // code: 'server_error', retryable: true
}
```

The endpoint returned `5xx`. `retryable: true` — failover applies.

#### `OllamaGenericClientError`

```typescript
class OllamaGenericClientError extends OllamaClientError {
  // code: 'client_error', retryable: false
}
```

Any other non-2xx response not covered by a more specific subclass (e.g. `400 Bad Request`, `422 Unprocessable Entity`).

### Client-side pre-flight errors

#### `OllamaUnsupportedCapabilityError`

```typescript
class OllamaUnsupportedCapabilityError extends OllamaClientError {
  readonly capability: string;
  // code: 'unsupported_capability', retryable: false
}
```

Thrown client-side, before any network call, when a request asks for a capability an endpoint is known not to support (e.g. structured output `format` against an Ollama Cloud endpoint). `unsupported_capability` is in `DEFAULT_FAILOVER_CODES`, so a multi-endpoint setup tries the next candidate — it only surfaces to the caller if every candidate is rejected.

#### `OllamaModelRoutingError`

```typescript
class OllamaModelRoutingError extends OllamaClientError {
  readonly model: string;
  readonly availableModels: readonly string[];
  // code: 'model_routing_error', retryable: false
}
```

Thrown client-side, before any network call, when `config.endpoints` uses `OllamaEndpoint.models` to scope endpoints to specific models and the requested `model` isn't in any configured endpoint's allow-list. This is a routing misconfiguration, not a connectivity problem — the SDK deliberately does not "probe" unauthorized endpoints.

#### `OllamaQuotaExceededError`

```typescript
class OllamaQuotaExceededError extends OllamaClientError {
  readonly windowId: string;
  readonly resetAt: number;
  // code: 'quota_exceeded', retryable: false
}
```

Thrown client-side, before a network request is made, by `QuotaManager.assertCanProceed` when issuing the request would exceed a configured usage budget for one of its rolling windows. Distinct from `OllamaRateLimitError` (the server's actual `429`) — see [Failover & Routing](../guide/failover) for the full `QuotaManager` pattern.

### Tool and structured-output errors

#### `OllamaToolValidationError`

```typescript
class OllamaToolValidationError extends OllamaClientError {
  readonly toolName: string;
  readonly issues?: unknown;
  // code: 'tool_validation_error', retryable: false
}
```

A tool call's arguments, or a `chatWithSchema`/`generateWithSchema` result, failed Zod validation. Carries the original Zod issues on `issues` for inspection.

#### `OllamaToolTimeoutError`

```typescript
class OllamaToolTimeoutError extends OllamaClientError {
  readonly toolName: string;
  readonly timeoutMs: number;
  // code: 'tool_timeout', retryable: false
}
```

A tool call exceeded its `timeoutMs` (set on the registry or per-tool via `defineTool({ timeoutMs })`). Enforcement is cooperative — it stops the agent from waiting indefinitely, but cannot forcibly halt non-abort-aware async work. See [ADR 0004](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0004-tool-execution-sandboxing.md).

### Agent errors

#### `OllamaIncompatibleModelError`

```typescript
class OllamaIncompatibleModelError extends OllamaClientError {
  readonly model: string;
  readonly capability: string;
  readonly reportedCapabilities: readonly string[];
  // code: 'incompatible_model', retryable: false
}
```

Thrown before an agent tool loop starts when the selected model's `/api/show` metadata does not advertise a required capability (e.g. `tools`).

#### `OllamaAgentMaxIterationsError`

```typescript
class OllamaAgentMaxIterationsError extends OllamaClientError {
  readonly maxIterations: number;
  // code: 'agent_max_iterations_exceeded', retryable: false
}
```

An `Agent` run exceeded `maxIterations` without producing a final answer.

#### `OllamaAgentMaxToolCallsError`

```typescript
class OllamaAgentMaxToolCallsError extends OllamaClientError {
  readonly maxToolCalls: number;
  readonly toolCallsExecuted: number;
  // code: 'agent_max_tool_calls_exceeded', retryable: false
}
```

An `Agent` run exceeded `maxToolCalls` (the total tool-call budget across the whole run).

#### `OllamaAgentToolLoopError`

```typescript
class OllamaAgentToolLoopError extends OllamaClientError {
  readonly toolName: string;
  readonly repeatedExecutions: number;
  readonly maxRepeatedToolCalls: number;
  readonly signature: string;
  // code: 'agent_tool_loop_detected', retryable: false
}
```

An `Agent` run with cycle detection enabled (`maxRepeatedToolCalls`) would execute the same tool call — identical name and identical arguments — more times than the budget allows: the model is stuck re-emitting one call instead of reacting to its results. `signature` carries the canonical `name(args)` form (argument keys recursively sorted, truncated at 200 chars). Thrown before the offending batch executes.

### Contract / runtime validation errors

#### `OllamaRequestValidationError`

```typescript
class OllamaRequestValidationError extends OllamaClientError {
  readonly operationId: string;
  readonly issues: readonly z.ZodIssue[];
  // code: 'request_validation_error', retryable: false
}
```

Thrown by `OllamaRuntime.invoke` when `validateRequests: true` is set and the request body fails Zod validation against the operation's registered schema. No HTTP request is made when this error is thrown. See [ADR 0020](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0020-runtime-zod-validation.md).

#### `OllamaResponseValidationError`

```typescript
class OllamaResponseValidationError extends OllamaClientError {
  readonly operationId: string;
  readonly issues: readonly z.ZodIssue[];
  // code: 'response_validation_error', retryable: false
}
```

Thrown by `OllamaRuntime.invoke` when `validateResponses: true` is set and the response body fails Zod validation. The response was received but didn't match the expected schema.

#### `OllamaRequestTooLargeError`

```typescript
class OllamaRequestTooLargeError extends OllamaClientError {
  readonly operationId: string;
  readonly actualBytes: number;
  readonly maxBytes: number;
  // code: 'request_too_large', retryable: false, status: 413
}
```

Thrown by `OllamaRuntime.invoke` **before** any HTTP request is made when the serialized request body exceeds the operation's declared `constraints.maxRequestBytes`. System One declares 64 KiB (without images) / 32 MiB (with images).

#### `OllamaServerVersionUnknownError`

```typescript
class OllamaServerVersionUnknownError extends OllamaClientError {
  readonly operationId: string;
  readonly minRequiredVersion: string;
  // code: 'server_version_unknown', retryable: false
}
```

Thrown when `enforceVersion: 'strict'` is set and the runtime couldn't obtain a server version to compare against (e.g. `/api/version` was unreachable). Distinct from `OllamaGenericClientError` so callers can branch on the failure mode.

### MCP errors

#### `OllamaMcpError`

```typescript
class OllamaMcpError extends OllamaClientError {
  readonly mcpMethod:
    'listTools' | 'callTool' | 'tools/call' | 'tasks/get' | 'tasks/result' | 'tasks/cancel';
  readonly toolName?: string;
  readonly issues?: unknown;
  // code: 'mcp_error', retryable: varies
}
```

An MCP `listTools`/`callTool` call failed. The `mcpMethod` field identifies which MCP operation failed; `toolName` and `issues` are set when the failure was a specific tool call.

### Skill errors

#### `OllamaSkillNotFoundError`, `OllamaSkillInvalidError`

```typescript
class OllamaSkillNotFoundError extends OllamaClientError {
  readonly skillName: string;
  // code: 'skill_not_found', retryable: false
}

class OllamaSkillInvalidError extends OllamaClientError {
  readonly skillName: string;
  readonly path?: string;
  // code: 'skill_invalid', retryable: false
}
```

Thrown by `applySkill` (in the `@nemesis-oss/ollama-sdk/skills` subpath) when a referenced skill isn't registered or its frontmatter/contents fail to parse.

## Error handling patterns

### Catch by base class

```typescript
import { OllamaClientError } from '@nemesis-oss/ollama-sdk';

try {
  await client.chat({ model: 'qwen3:8b', messages });
} catch (err) {
  if (err instanceof OllamaClientError) {
    console.error(`[${err.code}] ${err.message}`, {
      retryable: err.retryable,
      status: err.status,
      cause: err.cause,
    });
  } else {
    throw err; // Re-throw programming errors.
  }
}
```

### Narrow to a specific subclass

```typescript
import {
  OllamaClientError,
  OllamaRateLimitError,
  OllamaNotFoundError,
  OllamaAuthError,
  OllamaNetworkError,
} from '@nemesis-oss/ollama-sdk';

try {
  await client.chat({ model: 'qwen3:8b', messages });
} catch (err) {
  if (err instanceof OllamaNotFoundError) {
    console.error('Model not found. Run `ollama pull qwen3:8b`.');
  } else if (err instanceof OllamaRateLimitError) {
    console.warn(`Rate limited; retry after ${err.retryAfterMs}ms`);
  } else if (err instanceof OllamaAuthError) {
    console.error('Authentication failed. Check your API key.');
  } else if (err instanceof OllamaNetworkError) {
    console.error('All endpoints unreachable.');
  } else if (err instanceof OllamaClientError) {
    console.error(`[${err.code}] ${err.message}`);
  } else {
    throw err;
  }
}
```

### Branch on `code` instead of `instanceof`

Each subclass has a stable `code` string, so you can branch without importing the class:

```typescript
try {
  await client.chat({ model: 'qwen3:8b', messages });
} catch (err) {
  if (err instanceof OllamaClientError) {
    switch (err.code) {
      case 'not_found':
        return handleNotFound(err);
      case 'rate_limited':
        return handleRateLimited(err);
      case 'auth_error':
        return handleAuth(err);
      case 'network_error':
        return handleNetwork(err);
      case 'timeout':
        return handleTimeout(err);
      case 'aborted':
        return; // expected
      default:
        return handleOther(err);
    }
  }
  throw err;
}
```

### Inspecting Zod issues

```typescript
import { OllamaToolValidationError, OllamaRequestValidationError } from '@nemesis-oss/ollama-sdk';

try {
  await client.chatWithSchema(req, MySchema);
} catch (err) {
  if (err instanceof OllamaToolValidationError) {
    console.error('Schema validation failed:');
    for (const issue of err.issues as never[]) {
      console.error(`  - ${issue.path?.join('.')}: ${issue.message}`);
    }
  }
}
```

## `mapError(error, context?)`

Maps arbitrary thrown exceptions into structured `OllamaClientError` instances:

```typescript
import {
  mapError,
  OllamaClientError,
  OllamaAbortError,
  OllamaNetworkError,
} from '@nemesis-oss/ollama-sdk';

try {
  await fetch('https://ollama.example.com/api/chat', {/* ... */});
} catch (err) {
  const mapped = mapError(err, { request: { method: 'POST', url: '...' } });
  // mapped is always an OllamaClientError:
  // - DOMException AbortError → OllamaAbortError
  // - TypeError (fetch failed) → OllamaNetworkError
  // - With response.status: statusToError(...)
  // - Anything else: OllamaGenericClientError
}
```

You usually don't need to call `mapError` directly — the transport layer calls it for you. It's exposed for callers who wrap Ollama calls in their own error-handling middleware.

## Default failover codes

The codes that trigger failover to the next candidate endpoint (configurable via `OllamaClientConfig.failoverOn`):

```typescript
const DEFAULT_FAILOVER_CODES = [
  'network_error',
  'timeout',
  'server_error',
  'rate_limited',
  'auth_error',
  'unsupported_capability',
];
```

## Quick reference table

| Class                              | `code`                          | `retryable` | Thrown when                                                                                                                        |
| ---------------------------------- | ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `OllamaNetworkError`               | `network_error`                 | `true`      | Request failed before a response was received.                                                                                     |
| `OllamaTimeoutError`               | `timeout`                       | `true`      | Request exceeded `timeoutMs`.                                                                                                      |
| `OllamaAuthError`                  | `auth_error`                    | `false`     | Endpoint returned `401`/`403`.                                                                                                     |
| `OllamaNotFoundError`              | `not_found`                     | `false`     | Endpoint returned `404` (e.g. unknown model).                                                                                      |
| `OllamaRateLimitError`             | `rate_limited`                  | `true`      | Endpoint returned `429`.                                                                                                           |
| `OllamaQuotaExceededError`         | `quota_exceeded`                | `false`     | `QuotaManager.assertCanProceed` would exceed a configured budget (client-side).                                                    |
| `OllamaModelRoutingError`          | `model_routing_error`           | `false`     | No configured endpoint is authorized for the requested model (client-side).                                                        |
| `OllamaServerError`                | `server_error`                  | `true`      | Endpoint returned `5xx`.                                                                                                           |
| `OllamaAbortError`                 | `aborted`                       | `false`     | Request cancelled via `AbortSignal`.                                                                                               |
| `OllamaToolValidationError`        | `tool_validation_error`         | `false`     | Tool arguments or `chatWithSchema`/`generateWithSchema` result failed Zod validation.                                              |
| `OllamaToolTimeoutError`           | `tool_timeout`                  | `false`     | Tool call exceeded `timeoutMs`.                                                                                                    |
| `OllamaUnsupportedCapabilityError` | `unsupported_capability`        | `false`     | Request asked for an unsupported capability (e.g. `format` against Ollama Cloud). In `DEFAULT_FAILOVER_CODES`.                     |
| `OllamaIncompatibleModelError`     | `incompatible_model`            | `false`     | Tool-enabled `Agent` run blocked by capability preflight (`/api/show` doesn't advertise `tools`).                                  |
| `OllamaAgentMaxIterationsError`    | `agent_max_iterations_exceeded` | `false`     | `Agent` run exceeded `maxIterations`.                                                                                              |
| `OllamaAgentMaxToolCallsError`     | `agent_max_tool_calls_exceeded` | `false`     | `Agent` run exceeded `maxToolCalls`.                                                                                               |
| `OllamaAgentToolLoopError`         | `agent_tool_loop_detected`      | `false`     | Cycle detection (`maxRepeatedToolCalls`): the model would repeat one identical tool call beyond the budget — stuck in a tool loop. |
| `OllamaRequestValidationError`     | `request_validation_error`      | `false`     | `validateRequests: true` and request failed Zod validation (no HTTP call made).                                                    |
| `OllamaResponseValidationError`    | `response_validation_error`     | `false`     | `validateResponses: true` and response failed Zod validation.                                                                      |
| `OllamaRequestTooLargeError`       | `request_too_large`             | `false`     | Request body exceeds `constraints.maxRequestBytes` (no HTTP call made).                                                            |
| `OllamaServerVersionUnknownError`  | `server_version_unknown`        | `false`     | `enforceVersion: 'strict'` and `/api/version` was unreachable.                                                                     |
| `OllamaMcpError`                   | `mcp_error`                     | varies      | MCP `listTools`/`callTool`/task call failed.                                                                                       |
| `OllamaSkillNotFoundError`         | `skill_not_found`               | `false`     | `applySkill` referenced an unregistered skill.                                                                                     |
| `OllamaSkillInvalidError`          | `skill_invalid`                 | `false`     | Skill frontmatter/contents failed to parse.                                                                                        |
| `OllamaGenericClientError`         | `client_error`                  | `false`     | Any other non-2xx response not covered above.                                                                                      |

## Next steps

- **[OllamaClient](./client)** — where most of these errors originate.
- **[Failover & Routing](../guide/failover)** — which errors fail over vs. fail-fast.
- **[ADR 0001: Circuit Breaker Failure Model](https://github.com/shubhamtaywade82/ollama-sdk/blob/main/docs/adr/0001-circuit-breaker-failure-model.md)** — the design rationale for the error hierarchy.
