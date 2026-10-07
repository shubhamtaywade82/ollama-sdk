/**
 * Ergonomic OpenAI Responses API bridge — `client.responses.create()`.
 *
 * Ollama (v0.13.3+) exposes OpenAI's Responses API at `POST /v1/responses` as
 * a **stateless** compatibility endpoint: it accepts `model`, `input`,
 * `instructions`, `tools`, `stream`, `temperature`, `top_p`,
 * `max_output_tokens`, `reasoning.effort`, `truncation`, and the Ollama
 * extension `think` — and rejects OpenAI's stateful `previous_response_id` /
 * `conversation` fields, because every call is independent. Responses deliver
 * text inside `output[] → message → content[] → output_text` blocks rather
 * than chat-completion `choices`.
 *
 * This module wraps that endpoint with a small, OpenAI-SDK-shaped surface for
 * teams migrating from `openai.responses.create()` — and adds a safety net the
 * raw compat layer doesn't have: **dual-mode transport**.
 *
 *   1. **Native** — POST `/v1/responses` directly. Used when the server
 *      supports it (Ollama ≥ v0.13.3, or Ollama Cloud).
 *   2. **Chat adapter** — on `404 Not Found` (older Ollama builds without the
 *      endpoint), the same request is transparently re-issued against
 *      `/api/chat` with `instructions` mapped to a system message,
 *      `max_output_tokens` to `options.num_predict`, and tools mapped to the
 *      native tool-definition shape. The response is normalized back into the
 *      Responses form (`output_text`, `usage.input_tokens`/`output_tokens`),
 *      so migrating code works unchanged against old servers.
 *
 * The `transport` field on the result records which path served the request.
 *
 * For the full OpenAI-shaped surface (stateful fields accepted-but-ignored,
 * raw `output` items, SSE event objects), use `client.openai.responses()`
 * instead — this module is the ergonomic subset.
 */

import { OllamaNotFoundError } from './errors.js';
import type {
  OpenAIResponsesResponse,
  OpenAIResponsesStream,
  OpenAIResponsesUsage,
} from './integrations/openai.js';
import { OpenAIResponsesStream as OpenAIResponsesStreamClass } from './integrations/openai.js';
import { normalizeChatStream } from './streaming/normalize.js';
import type { ChatStreamResult } from './streaming/types.js';
import type {
  ChatResponse,
  RequestCancellationOptions,
  ThinkValue,
  ToolCall,
  ToolDefinition,
  ToolParameters,
} from './types.js';
import type { RequestRunner } from './transport/runner.js';

/** Flat tool definition, matching the `openai` npm SDK's `tools[]` shape. */
export interface ResponsesToolDefinition {
  readonly name: string;
  readonly description?: string | undefined;
  readonly parameters?: ToolParameters | undefined;
}

/** Reasoning effort levels Ollama's `/v1/responses` accepts under `reasoning.effort`. */
export type ResponsesReasoningEffort = 'low' | 'medium' | 'high';

/**
 * Ergonomic request for {@link ResponsesModule.create} — the subset of
 * OpenAI's Responses API that Ollama supports, minus the stateful fields
 * (`previous_response_id`, `conversation`) Ollama rejects.
 */
export interface ResponsesCreateRequest extends RequestCancellationOptions {
  readonly model: string;
  /** The user prompt. Send the full conversation here — Ollama is stateless. */
  readonly input: string;
  /** System/developer instructions, mapped to a system message. */
  readonly instructions?: string | undefined;
  readonly tools?: readonly ResponsesToolDefinition[] | undefined;
  readonly temperature?: number | undefined;
  readonly top_p?: number | undefined;
  readonly max_output_tokens?: number | undefined;
  /** Maps to `reasoning.effort` on the native endpoint; ignored by the chat adapter. */
  readonly reasoning_effort?: ResponsesReasoningEffort | undefined;
  /** Ollama-specific extension: thinking output control (boolean or model-defined level). */
  readonly think?: ThinkValue | undefined;
}

/** Token usage in OpenAI Responses naming. */
export interface ResponsesUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
}

/**
 * Normalized, non-stateful Responses result — `output_text` is the joined
 * text of all `output_text` content blocks, so consumers never touch the
 * nested `output[]` structure.
 */
export interface ResponsesCreateResponse {
  readonly id: string;
  readonly model: string;
  readonly created_at: string;
  readonly output_text: string;
  /** Reasoning-model thinking trace, when produced with `think` enabled. */
  readonly thinking?: string | undefined;
  /** Parsed function calls the model requested, when `tools` were provided. */
  readonly tool_calls?: readonly ToolCall[] | undefined;
  readonly usage?: ResponsesUsage | undefined;
  /** Which transport served the request — see the module doc on dual-mode. */
  readonly transport: 'native' | 'chat-adapter';
}

/** Simplified streaming events from {@link ResponsesModule.stream}. */
export type ResponsesStreamEvent =
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'thinking_delta'; readonly delta: string }
  | { readonly type: 'done'; readonly response: ResponsesCreateResponse };

/** Sequences client-synthesized response IDs for the chat-adapter path. */
let adapterResponseSequence = 0;

function toNativeTools(
  tools: readonly ResponsesToolDefinition[] | undefined,
): readonly ToolDefinition[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

function mapNativeUsage(usage: OpenAIResponsesUsage | undefined): ResponsesUsage | undefined {
  if (usage === undefined) return undefined;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

function parseToolCallArguments(raw: string): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Model emitted malformed JSON — surface the raw string under a stable
    // key rather than dropping the call entirely.
    return { _raw: raw };
  }
}

/** Extracts the joined `output_text` payload, thinking trace, and tool calls from a native response. */
function mapNativeResponse(
  native: OpenAIResponsesResponse,
): Pick<
  ResponsesCreateResponse,
  'id' | 'model' | 'created_at' | 'output_text' | 'thinking' | 'tool_calls' | 'usage'
> {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const item of native.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text') textParts.push(part.text ?? '');
        else if (part.type === 'refusal') textParts.push(part.refusal ?? '');
      }
    } else if (item.type === 'reasoning') {
      if (item.text !== undefined && item.text !== '') thinkingParts.push(item.text);
    } else if (item.type === 'function_call') {
      toolCalls.push({
        ...(item.id !== undefined ? { id: item.id } : {}),
        function: { name: item.name, arguments: parseToolCallArguments(item.arguments) },
      });
    }
  }
  return {
    id: native.id ?? `resp_${Date.now().toString(36)}`,
    model: native.model,
    created_at: new Date((native.created_at ?? 0) * 1000).toISOString(),
    output_text: textParts.join(''),
    ...(thinkingParts.length > 0 ? { thinking: thinkingParts.join('\n') } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(mapNativeUsage(native.usage) !== undefined ? { usage: mapNativeUsage(native.usage)! } : {}),
  };
}

function mapChatUsage(res: ChatResponse | ChatStreamResult): ResponsesUsage | undefined {
  const asChat = res as ChatResponse;
  const asStream = res as ChatStreamResult;
  const input =
    asChat.prompt_eval_count ??
    asStream.usage?.promptTokens ??
    asStream.raw?.prompt_eval_count ??
    0;
  const output =
    asChat.eval_count ?? asStream.usage?.completionTokens ?? asStream.raw?.eval_count ?? 0;
  if (input === 0 && output === 0) return undefined;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

/** Maps a native `/api/chat` response into the Responses result shape. */
function mapChatResponse(res: ChatResponse): ResponsesCreateResponse {
  adapterResponseSequence += 1;
  return {
    id: `resp_${Date.now().toString(36)}${adapterResponseSequence.toString(36)}`,
    model: res.model,
    created_at: res.created_at,
    output_text: res.message.content,
    ...(res.message.thinking !== undefined ? { thinking: res.message.thinking } : {}),
    ...(res.message.tool_calls !== undefined && res.message.tool_calls.length > 0
      ? { tool_calls: res.message.tool_calls }
      : {}),
    ...(mapChatUsage(res) !== undefined ? { usage: mapChatUsage(res)! } : {}),
    transport: 'chat-adapter',
  };
}

/**
 * Dual-mode Responses API bridge. Access via `client.responses` — see the
 * module doc for the transport selection rules.
 */
export class ResponsesModule {
  constructor(private readonly runner: RequestRunner) {}

  /** The request body sent to the native endpoint (also reused for streaming). */
  private nativeBody(req: ResponsesCreateRequest): Record<string, unknown> {
    return {
      model: req.model,
      input: req.input,
      ...(req.instructions !== undefined ? { instructions: req.instructions } : {}),
      ...(req.tools !== undefined && req.tools.length > 0
        ? { tools: toNativeTools(req.tools) }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
      ...(req.max_output_tokens !== undefined ? { max_output_tokens: req.max_output_tokens } : {}),
      ...(req.reasoning_effort !== undefined
        ? { reasoning: { effort: req.reasoning_effort } }
        : {}),
      ...(req.think !== undefined ? { think: req.think } : {}),
    };
  }

  /**
   * Runs one Responses request, preferring the native `POST /v1/responses`
   * endpoint and transparently re-issuing via `/api/chat` when the server
   * answers `404` (pre-v0.13.3 Ollama without the compatibility endpoint).
   */
  async create(req: ResponsesCreateRequest): Promise<ResponsesCreateResponse> {
    const body = this.nativeBody(req);
    try {
      const native = await this.runner(
        (http, signal) =>
          http.request<OpenAIResponsesResponse>({
            path: '/v1/responses',
            body: { ...body, stream: false },
            signal,
          }),
        { model: req.model, signal: req.signal, timeoutMs: req.timeoutMs },
      );
      return { ...mapNativeResponse(native), transport: 'native' };
    } catch (err) {
      if (!(err instanceof OllamaNotFoundError)) throw err;
    }
    return this.createViaChatAdapter(req);
  }

  /** Convenience: `create()` returning only the `output_text` string. */
  async createText(req: ResponsesCreateRequest): Promise<string> {
    const res = await this.create(req);
    return res.output_text;
  }

  private async createViaChatAdapter(
    req: ResponsesCreateRequest,
  ): Promise<ResponsesCreateResponse> {
    const messages = [
      ...(req.instructions !== undefined
        ? [{ role: 'system' as const, content: req.instructions }]
        : []),
      { role: 'user' as const, content: req.input },
    ];
    const chatRes = await this.runner(
      (http, signal) =>
        http.request<ChatResponse>({
          path: '/api/chat',
          body: {
            model: req.model,
            messages,
            ...(req.tools !== undefined && req.tools.length > 0
              ? { tools: toNativeTools(req.tools) }
              : {}),
            options: {
              ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
              ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
              ...(req.max_output_tokens !== undefined
                ? { num_predict: req.max_output_tokens }
                : {}),
            },
            ...(req.think !== undefined ? { think: req.think } : {}),
            stream: false,
          },
          signal,
        }),
      { model: req.model, signal: req.signal, timeoutMs: req.timeoutMs },
    );
    return mapChatResponse(chatRes);
  }

  /**
   * Streams a Responses request as simplified
   * `{type: 'text_delta' | 'thinking_delta' | 'done'}` events. Dual-mode like
   * {@link create}: native SSE from `/v1/responses` when available, otherwise
   * the normalized `/api/chat` token stream. Tool calls are not delta'd —
   * collect them from the final `done` event's `response.tool_calls`.
   *
   * This is a lazy async generator: nothing is sent until the first
   * iteration, matching `for await (... of client.responses.stream(req))`
   * intuition. The generator is also cancellable through `req.signal`.
   */
  async *stream(req: ResponsesCreateRequest): AsyncGenerator<ResponsesStreamEvent, void, void> {
    const body = this.nativeBody(req);

    // Phase 1 — establish the native stream. A 404 here (endpoint absent)
    // falls through to the chat adapter. Errors during iteration (phase 2)
    // do NOT trigger the fallback — the consumer may already have consumed
    // partial output, so silently re-issuing would duplicate it.
    let nativeStream: OpenAIResponsesStream | undefined;
    try {
      nativeStream = await this.runner(
        async (http, signal) => {
          const source = await http.requestSseStream({
            path: '/v1/responses',
            body: { ...body, stream: true },
            signal,
          });
          return new OpenAIResponsesStreamClass(source, signal);
        },
        {
          model: req.model,
          signal: req.signal,
          timeoutMs: req.timeoutMs,
          holdUntil: (s) => s.finalResult,
        },
      );
    } catch (err) {
      if (!(err instanceof OllamaNotFoundError)) throw err;
    }

    if (nativeStream !== undefined) {
      for await (const event of nativeStream) {
        // The stream-event union carries a `{ type: string; [k: string]: unknown }`
        // forward-compat catch-all, so narrow by casting rather than by
        // discriminated-union checks.
        const type = (event as { type: string }).type;
        if (type === 'response.output_text.delta') {
          yield { type: 'text_delta', delta: (event as { delta: string }).delta };
        } else if (type === 'response.reasoning_text.delta') {
          yield { type: 'thinking_delta', delta: (event as { delta: string }).delta };
        }
      }
      yield {
        type: 'done',
        response: { ...mapNativeResponse(await nativeStream.finalResult), transport: 'native' },
      };
      return;
    }

    // Phase 2 — chat-adapter fallback stream.
    const chatStream = await this.runner(
      async (http, signal) => {
        const source = await http.requestStream<ChatResponse>({
          path: '/api/chat',
          body: {
            model: req.model,
            messages: [
              ...(req.instructions !== undefined
                ? [{ role: 'system' as const, content: req.instructions }]
                : []),
              { role: 'user' as const, content: req.input },
            ],
            ...(req.tools !== undefined && req.tools.length > 0
              ? { tools: toNativeTools(req.tools) }
              : {}),
            options: {
              ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
              ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
              ...(req.max_output_tokens !== undefined
                ? { num_predict: req.max_output_tokens }
                : {}),
            },
            ...(req.think !== undefined ? { think: req.think } : {}),
            stream: true,
          },
          signal,
        });
        return normalizeChatStream(source, signal);
      },
      {
        model: req.model,
        signal: req.signal,
        timeoutMs: req.timeoutMs,
        holdUntil: (s) => s.finalResult,
      },
    );

    // Iterate first — `finalResult` only settles once the stream has been
    // fully consumed (see OllamaStream), so awaiting it before the loop would
    // deadlock. Buffer nothing here; consumers see deltas live.
    for await (const event of chatStream) {
      if (event.type === 'token') {
        yield { type: 'text_delta', delta: (event.data as { delta: string }).delta };
      } else if (event.type === 'thinking') {
        yield { type: 'thinking_delta', delta: (event.data as { delta: string }).delta };
      }
    }
    const result = await chatStream.finalResult;
    yield {
      type: 'done',
      response: {
        id: `resp_${Date.now().toString(36)}${(++adapterResponseSequence).toString(36)}`,
        model: result.model,
        created_at: new Date().toISOString(),
        output_text: result.message.content,
        ...(result.message.thinking !== undefined ? { thinking: result.message.thinking } : {}),
        ...(result.message.tool_calls !== undefined && result.message.tool_calls.length > 0
          ? { tool_calls: result.message.tool_calls }
          : {}),
        ...(mapChatUsage(result) !== undefined ? { usage: mapChatUsage(result)! } : {}),
        transport: 'chat-adapter',
      },
    };
  }
}
