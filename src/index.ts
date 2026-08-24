/**
 * @nemesis-oss/ollama-sdk: A production-grade TypeScript SDK for Ollama.
 */

// Core client and config
export { OllamaClient } from './client.js';
export { ModelsClient, type RequestRunner } from './models-client.js';
export {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_FAILOVER_CODES,
  OLLAMA_CLOUD_BASE_URL,
  type OllamaClientConfig,
} from './config.js';

// Protocol and message types
export type {
  Role,
  ToolCallFunction,
  ToolCall,
  Message,
  ToolProperty,
  ToolFunctionDefinition,
  ToolDefinition,
  FormatOption,
  ModelOptions,
  LogprobToken,
  Logprob,
  RequestCancellationOptions,
  ChatRequestOptions,
  ChatResponse,
  GenerateRequestOptions,
  GenerateResponse,
  EmbedRequestOptions,
  EmbedResponse,
  EmbeddingsRequestOptions,
  EmbeddingsResponse,
  ModelDetails,
  ModelResponse,
  ListResponse,
  ShowRequestOptions,
  ShowResponse,
  ProgressResponse,
  PullRequestOptions,
  PushRequestOptions,
  CreateRequestOptions,
  DeleteRequestOptions,
  CopyRequestOptions,
  StatusResponse,
  VersionResponse,
  PsResponse,
  WebSearchRequestOptions,
  WebSearchResult,
  WebSearchResponse,
  WebFetchRequestOptions,
  WebFetchResponse,
} from './types.js';

// Errors
export {
  OllamaClientError,
  OllamaNetworkError,
  OllamaTimeoutError,
  OllamaAuthError,
  OllamaNotFoundError,
  OllamaRateLimitError,
  OllamaServerError,
  OllamaAbortError,
  OllamaToolValidationError,
  OllamaToolTimeoutError,
  OllamaUnsupportedCapabilityError,
  OllamaAgentMaxIterationsError,
  OllamaMcpError,
  OllamaSkillNotFoundError,
  OllamaSkillInvalidError,
  OllamaGenericClientError,
  mapError,
  type OllamaErrorRequestContext,
  type OllamaErrorResponseContext,
  type OllamaClientErrorOptions,
} from './errors.js';

// Transport and retry
export {
  HttpClient,
  type HttpClientOptions,
  type HttpRequestOptions,
  type FetchLike,
  type HttpBody,
} from './transport/http.js';
export { calculateBackoff, DEFAULT_BACKOFF, type BackoffOptions } from './transport/backoff.js';
export { withRetry, DEFAULT_RETRY_CONFIG, type RetryConfig } from './transport/retry.js';
export { createTimeoutSignal, type TimeoutSignal } from './transport/timeout.js';

// Middleware
export {
  composeMiddleware,
  type Middleware,
  type MiddlewareContext,
  type NextFunction,
  type RequestContext,
  type ResponseContext,
} from './middleware.js';

// Streaming & Web Standard Adapters
export {
  OllamaStream,
  normalizeChatStream,
  normalizeGenerateStream,
  normalizeProgressStream,
  parseNdjsonStream,
  toTextStream,
  toDataStream,
  toResponse,
} from './streaming/index.js';
export type {
  OllamaStreamEvent,
  OllamaStreamEventType,
  TokenEvent,
  ThinkingEvent,
  ToolCallEvent,
  MessageEvent,
  DoneEvent,
  ErrorEvent,
  ChatStreamResult,
  GenerateStreamResult,
  ProgressStreamResult,
  AbortableAsyncIterable,
} from './streaming/index.js';

// Usage
export {
  extractUsage,
  NANOS_PER_MS,
  NANOS_PER_SECOND,
  type TokenUsage,
  type RawUsageSource,
} from './usage.js';

// Schema and Structured Outputs
export { zodToJsonSchema, parseStructuredOutput, type SupportedSchema } from './schema/zod.js';

// Tools
export {
  defineTool,
  ToolRegistry,
  type Tool,
  type AnyTool,
  type ToolHandler,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolExecutionSuccess,
  type ToolExecutionFailure,
  type DefineToolOptions,
  type ToolRegistryOptions,
} from './tools/index.js';

// MCP
export {
  loadMcpTools,
  registerMcpTools,
  type LoadMcpToolsOptions,
  type McpClientLike,
  type McpToolDescriptor,
  type McpListToolsResult,
  type McpContentBlock,
  type McpCallToolResult,
} from './mcp/index.js';

// Integrations (OpenAI & Anthropic compatibility)
export {
  OpenAICompatClient,
  AnthropicCompatClient,
  type OpenAIMessage,
  type OpenAIToolCall,
  type OpenAIStreamOptions,
  type OpenAIFunctionDefinition,
  type OpenAITool,
  type OpenAIChatCompletionRequest,
  type OpenAIChatCompletionChoice,
  type OpenAIChatCompletionResponse,
  type OpenAIModelItem,
  type OpenAIListModelsResponse,
  type OpenAIResponsesRequest,
  type OpenAIResponsesResponse,
  type OpenAIResponsesOutputMessage,
  type OpenAIResponsesOutputTextContent,
  type AnthropicCacheControl,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicMessagesRequest,
  type AnthropicMessagesResponse,
} from './integrations/index.js';

// Skills (core prompt functions)
export {
  parseFrontmatter,
  applySkill,
  type Skill,
  type SkillSummary,
  type SkillFrontmatter,
  type ParsedFrontmatter,
  type ApplySkillOptions,
  type AppliedSkillResult,
} from './skills/index.js';

// Agent
export {
  Agent,
  type AgentConfig,
  type AgentHooks,
  type AgentResult,
  type AgentRunInput,
  type AgentTurn,
  type AgentChatClient,
} from './agent/index.js';

// Providers and capabilities
export {
  EndpointRegistry,
  type OllamaEndpoint,
  type EndpointHealth,
  type EndpointRegistryOptions,
} from './providers/endpoint-registry.js';
export { checkEndpointHealth, type EndpointHealthCheckResult } from './providers/health-check.js';
export {
  detectModelCapabilities,
  inferRuntimeMode,
  listAvailableModels,
  type ModelCapabilities,
  type RuntimeMode,
} from './capabilities/capabilities.js';

// Telemetry (optional OpenTelemetry tracing — see ADR 0005)
export {
  withSpan,
  addSpanEvent,
  setSpanError,
  type SpanAttributes,
  type SpanAttributeValue,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_URL_FULL,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_OLLAMA_ENDPOINT_NAME,
  ATTR_OLLAMA_ENDPOINT_ATTEMPT,
  ATTR_OLLAMA_AGENT_MAX_ITERATIONS,
  ATTR_OLLAMA_AGENT_ITERATION,
  GEN_AI_SYSTEM_OLLAMA,
} from './telemetry/index.js';

// Utilities
export { encodeImage } from './utils.js';

// Logger
export {
  createConsoleLogger,
  NOOP_LOGGER,
  type Logger,
  type LogFn,
  type RequestLifecycleEvent,
  type RequestLifecycleHook,
  type LifecycleStartEvent,
  type LifecycleSuccessEvent,
  type LifecycleRetryEvent,
  type LifecycleErrorEvent,
} from './logger.js';
