/**
 * @nemesis-oss/ollama-sdk: A production-grade TypeScript SDK for Ollama.
 */

// Core client and config
export { OllamaClient } from './client.js';
export { ModelsClient } from './models-client.js';
export {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_FAILOVER_CODES,
  OLLAMA_CLOUD_BASE_URL,
  resolveCredentialEndpoints,
  type OllamaClientConfig,
  type OllamaCredentialConfig,
} from './config.js';

// Protocol and message types
export type {
  Role,
  ThinkValue,
  ThinkingMetadata,
  ToolCallFunction,
  ToolCall,
  Message,
  ToolProperty,
  ToolFunctionDefinition,
  ToolDefinition,
  ToolParameters,
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
  UsageRange,
  UsageScope,
  UsageRequestOptions,
  BalanceRequestOptions,
  UsageResponse,
  UsageMetrics,
  UsageBucket,
  BalanceResponse,
  IncludedBalance,
  LegacyBalanceLimit,
  LegacyIncludedBalance,
} from './types.js';

// Errors
export {
  OllamaClientError,
  OllamaNetworkError,
  OllamaTimeoutError,
  OllamaAuthError,
  OllamaNotFoundError,
  OllamaRateLimitError,
  OllamaQuotaExceededError,
  OllamaModelRoutingError,
  OllamaServerError,
  OllamaOverloadedError,
  OllamaBadGatewayError,
  OllamaStreamError,
  OllamaAbortError,
  OllamaToolValidationError,
  OllamaRequestValidationError,
  OllamaRequestTooLargeError,
  OllamaResponseValidationError,
  OllamaServerVersionUnknownError,
  OllamaToolTimeoutError,
  OllamaUnsupportedCapabilityError,
  OllamaAgentMaxIterationsError,
  OllamaAgentMaxToolCallsError,
  OllamaMcpError,
  OllamaIncompatibleModelError,
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

export type { RequestRunner } from './transport/runner.js';

export { calculateBackoff, DEFAULT_BACKOFF, type BackoffOptions } from './transport/backoff.js';
export { withRetry, DEFAULT_RETRY_CONFIG, type RetryConfig } from './transport/retry.js';
export { createTimeoutSignal, type TimeoutSignal } from './transport/timeout.js';
export {
  fetchWithBackoff,
  RETRYABLE_STATUS_CODES,
  DEFAULT_FETCH_BACKOFF_CONFIG,
  type FetchWithBackoffConfig,
} from './transport/fetch-with-backoff.js';

// VRAM lifecycle primitives (keep_alive ergonomics)
export {
  normalizeKeepAlive,
  isKeepAliveSugar,
  KEEP_ALIVE_UNLOAD,
  KEEP_ALIVE_INDEFINITE,
  type KeepAlive,
} from './keep-alive.js';

// Response decoder helpers — `done_reason` type narrowing
export { isKnownDoneReason, KNOWN_DONE_REASONS, type KnownDoneReason } from './done-reason.js';

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
  parseSseStream,
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
  SseEvent,
} from './streaming/index.js';

// Usage
export {
  extractUsage,
  NANOS_PER_MS,
  NANOS_PER_SECOND,
  type TokenUsage,
  type RawUsageSource,
} from './usage.js';

// Quota (client-side usage budgeting — see src/quota.ts for why this is necessary)
export {
  QuotaManager,
  createOllamaCloudFreeTierQuota,
  type QuotaWindowConfig,
  type QuotaWindowStatus,
  type QuotaManagerOptions,
  type OllamaCloudFreeTierQuotaBudgets,
} from './quota.js';

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

// Tool-call streaming accumulator (defensive merge for multi-chunk tool_calls)
export {
  ToolCallAccumulator,
  mergeToolCallArrays,
  mergeToolCall,
  mergeToolCallArgumentsString,
  isSameToolCall,
} from './tools/tool-call-accumulator.js';

// MCP
export {
  loadMcpTools,
  listAllMcpTools,
  registerMcpTools,
  McpBridge,
  type LoadMcpToolsOptions,
  type McpBridgeOptions,
  type McpClientLike,
  type McpToolAnnotations,
  type McpToolExecution,
  type McpIcon,
  type McpRequestOptions,
  type McpToolDescriptor,
  type McpListToolsResult,
  type McpListToolsParams,
  type McpContentBlock,
  type McpCallToolResult,
  type McpInputRequiredResult,
  type McpTaskStatus,
  type McpTask,
  type McpTaskMethod,
  type McpTaskRequest,
  type McpCreateTaskResult,
  type McpToolCallResult,
  type McpServerCapabilities,
  type McpElicitationFormRequest,
  type McpElicitationUrlRequest,
  type McpElicitationRequest,
  type McpElicitationResult,
  type McpElicitationHandlers,
} from './mcp/index.js';

// Integrations (OpenAI & Anthropic compatibility)
export {
  OpenAICompatClient,
  AnthropicCompatClient,
  type AnthropicCacheControl,
  type AnthropicTextContentBlock,
  type AnthropicImageContentBlock,
  type AnthropicToolUseContentBlock,
  type AnthropicToolResultContentBlock,
  type AnthropicThinkingContentBlock,
  type AnthropicRedactedThinkingContentBlock,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicSystemTextBlock,
  type AnthropicSystem,
  type AnthropicTool,
  type AnthropicToolChoice,
  type AnthropicThinkingConfig,
  type AnthropicOutputConfig,
  type AnthropicMetadata,
  type OllamaAnthropicTextContentBlock,
  type OllamaAnthropicContentBlock,
  type OllamaAnthropicToolResultContentBlock,
  type OllamaAnthropicMessage,
  type OllamaAnthropicSystemTextBlock,
  type OllamaAnthropicSystem,
  type OllamaAnthropicMessagesRequest,
  type OllamaAnthropicTool,
  type OllamaAnthropicThinkingConfig,
  type AnthropicMessagesRequest,
  type AnthropicMessagesResponse,
  type AnthropicMessageStreamEvent,
  type AnthropicUnknownStreamEvent,
  type OpenAIMessage,
  type OpenAITextContentPart,
  type OpenAIImageUrlContentPart,
  type OpenAIContentPart,
  type OpenAIToolCall,
  type OpenAIToolCallDelta,
  type OpenAIChatCompletionDelta,
  type OpenAIChatCompletionChunkChoice,
  type OpenAIChatCompletionChunk,
  OpenAIChatCompletionStream,
  OpenAICompletionStream,
  type OpenAIResponsesStreamEvent,
  type OpenAIResponsesEventBase,
  type OpenAIResponsesStatus,
  type OpenAIResponsesError,
  type OpenAIResponsesIncompleteDetails,
  type OpenAIResponsesUsage,
  OpenAIResponsesStreamError,
  type OpenAIResponsesOutputTextDeltaEvent,
  type OpenAIResponsesOutputTextDoneEvent,
  type OpenAIResponsesFunctionCallArgumentsDeltaEvent,
  type OpenAIResponsesFunctionCallArgumentsDoneEvent,
  type OpenAIResponsesReasoningTextDeltaEvent,
  type OpenAIResponsesReasoningSummaryTextDeltaEvent,
  type OpenAIResponsesReasoningTextDoneEvent,
  type OpenAIResponsesReasoningSummaryPartAddedEvent,
  type OpenAIResponsesReasoningSummaryPartDoneEvent,
  type OpenAIResponsesReasoningSummaryTextDoneEvent,
  type OpenAIResponsesOutputItemAddedEvent,
  type OpenAIResponsesOutputItemDoneEvent,
  type OpenAIResponsesContentPartAddedEvent,
  type OpenAIResponsesContentPartDoneEvent,
  type OpenAIResponsesRefusalDeltaEvent,
  type OpenAIResponsesRefusalDoneEvent,
  type OpenAIResponsesCreatedEvent,
  type OpenAIResponsesInProgressEvent,
  type OpenAIResponsesQueuedEvent,
  type OpenAIResponsesCompletedEvent,
  type OpenAIResponsesFailedEvent,
  type OpenAIResponsesIncompleteEvent,
  OpenAIResponsesStream,
  type OpenAIStreamOptions,
  type OpenAIFunctionDefinition,
  type OpenAITool,
  type OpenAIReasoningEffort,
  type OllamaOpenAIReasoningEffort,
  type OpenAIResponseFormat,
  type OpenAIChatCompletionRequest,
  type OllamaOpenAIChatCompletionRequest,
  type OpenAIChatCompletionChoice,
  type OpenAIChatCompletionResponse,
  type OpenAIUsage,
  type OpenAIModelItem,
  type OpenAIListModelsResponse,
  type OpenAICompletionRequest,
  type OllamaOpenAICompletionRequest,
  type OpenAICompletionChoice,
  type OpenAICompletionChunk,
  type OpenAICompletionResponse,
  type OpenAIEmbeddingInput,
  type OpenAIEmbeddingRequest,
  type OllamaOpenAIEmbeddingRequest,
  type OpenAIEmbeddingItem,
  type OpenAIEmbeddingResponse,
  type OpenAIResponsesRequest,
  type OllamaOpenAIResponsesRequest,
  type OpenAIResponsesResponse,
  type OpenAIResponsesOutputMessage,
  type OpenAIResponsesOutputTextContent,
  type OpenAIResponsesOutputContent,
  type OpenAIResponsesOutputRefusal,
  type OpenAIResponsesOutputFunctionCall,
  type OpenAIResponsesOutputReasoning,
  type OpenAIResponsesOutputItem,
  AnthropicMessagesStream,
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
  type ParallelToolCallBehavior,
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

// Universal vision asset resolution — data URIs, URLs, file paths, raw bytes
export { resolveImageInput, imageStringNeedsResolution, type VisionInput } from './vision.js';

// OpenAI Responses API bridge (dual-mode: native /v1/responses + /api/chat fallback)
export {
  ResponsesModule,
  type ResponsesCreateRequest,
  type ResponsesCreateResponse,
  type ResponsesReasoningEffort,
  type ResponsesStreamEvent,
  type ResponsesToolDefinition,
  type ResponsesUsage,
} from './responses.js';

// KV-prefix-preserving conversation sessions with cache statistics
export {
  ConversationSession,
  type ConversationSendOptions,
  type ConversationSessionOptions,
  type CumulativeCacheStats,
  type SessionTurn,
  type TurnCacheStats,
} from './conversation.js';

// Context-window safety — token estimation + pre-flight overflow checks
export {
  DEFAULT_CONTEXT_WARNING_THRESHOLD,
  IMAGE_TOKEN_ESTIMATE,
  OLLAMA_FALLBACK_CONTEXT_LENGTH,
  checkChatContext,
  checkGenerateContext,
  contextWarningMessage,
  estimateChatRequestTokens,
  estimateGenerateRequestTokens,
  estimateTokens,
  type ContextCheck,
  type ContextCheckOptions,
  type ContextWindowSource,
} from './context-safety.js';

// Batch-constrained embedding pipeline for high-volume ingestion (RAG/vector indexing)
export {
  DEFAULT_EMBED_BATCH_SIZE,
  DEFAULT_EMBED_CONCURRENCY,
  batchEmbed,
  embedBatchOverflowMessage,
  findOversizedEmbedInputs,
  type EmbedBatchOptions,
  type EmbedBatchResult,
  type OversizedEmbedInput,
} from './embed-batch.js';

// Blob upload result (from ModelsClient's convenience blob helpers)
export type { BlobUploadResult } from './models-client.js';

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

// System One — ergonomic typed decision layer (Wave 13)
export {
  type SystemOneQuestions,
  type SystemOneAnswers,
  type AnswerFor,
  type SystemOneRequest,
  type SystemOneResponse,
  type SystemOneContent,
  type SystemOneQuestion,
  type SystemOneChoiceQuestion,
  type SystemOneNoulQuestion,
  type SystemOneScoreQuestion,
  type SystemOneAnswer,
  type SystemOneChoiceAnswer,
  type SystemOneNoulAnswer,
  type SystemOneScoreAnswer,
  type SystemOneProbabilities,
  type SystemOneConfidence,
  type SystemOneUsage,
  MAX_SYSTEM_ONE_REQUEST_BYTES,
  MAX_SYSTEM_ONE_IMAGES_BYTES,
  estimateSystemOneRequestBytes,
} from './system-one.js';

// Higher-level decision helpers (Wave 14B)
export {
  createDecision,
  type Decision,
  type ChoiceDecision,
  type NoulDecision,
  type ScoreDecision,
  type RankResult,
} from './decision.js';
