/**
 * Tool registry for managing definitions and executing model tool calls.
 */

import {
  OllamaNotFoundError,
  OllamaToolTimeoutError,
  OllamaToolValidationError,
} from '../errors.js';
import {
  withSpan,
  setSpanError,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_CALL_ID,
} from '../telemetry/index.js';
import type { ToolCall, ToolDefinition } from '../types.js';
import type { AnyTool, Tool, ToolExecutionContext, ToolExecutionResult } from './types.js';
import { disposableTimer } from '../utils.js';

export interface ToolRegistryOptions {
  readonly tools?: readonly AnyTool[] | undefined;
  readonly onError?: ((error: Error, toolCall: ToolCall) => string) | undefined;
  /**
   * Default per-call execution timeout in milliseconds, applied to any tool that
   * doesn't declare its own `timeoutMs`. Undefined (the default) means no timeout is
   * enforced, matching prior behavior. Recommended whenever tool arguments or
   * implementations are influenced by model output you don't fully control, since an
   * unbounded tool call can otherwise stall the entire agent loop indefinitely.
   *
   * Enforcement is cooperative: it races the tool's promise against a timer and
   * reports a timeout failure, but cannot forcibly halt synchronous or non-abort-aware
   * asynchronous work already in flight on the same thread. Tools that perform I/O
   * should honor `ToolExecutionContext.signal` to stop promptly on timeout.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Maximum number of tool calls executed concurrently by `executeToolCalls`.
   * Undefined (the default) runs all calls in parallel, matching prior behavior.
   */
  readonly maxConcurrency?: number | undefined;
  /**
   * Maximum length of a tool's `outputString` before it is truncated. Guards against a
   * single tool call flooding the conversation history / model context (and process
   * memory) with unbounded output. Undefined (the default) applies no limit.
   */
  readonly maxOutputChars?: number | undefined;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();
  private readonly onError?: ((error: Error, toolCall: ToolCall) => string) | undefined;
  private readonly defaultTimeoutMs?: number | undefined;
  private readonly maxConcurrency?: number | undefined;
  private readonly maxOutputChars?: number | undefined;

  constructor(toolsOrOptions?: readonly AnyTool[] | ToolRegistryOptions | undefined) {
    if (Array.isArray(toolsOrOptions)) {
      this.registerMany(toolsOrOptions);
    } else if (toolsOrOptions !== undefined) {
      const opts = toolsOrOptions as ToolRegistryOptions;
      this.onError = opts.onError;
      this.defaultTimeoutMs = opts.timeoutMs;
      this.maxConcurrency = opts.maxConcurrency;
      this.maxOutputChars = opts.maxOutputChars;
      if (opts.tools) {
        this.registerMany(opts.tools);
      }
    }
  }

  register(tool: AnyTool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  registerMany(tools: readonly AnyTool[]): this {
    for (const tool of tools) {
      this.register(tool);
    }
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  async executeToolCall(
    toolCall: ToolCall,
    ctx: ToolExecutionContext = {},
  ): Promise<ToolExecutionResult> {
    const { name } = toolCall.function;
    return withSpan(
      `execute_tool ${name}`,
      { [ATTR_GEN_AI_TOOL_NAME]: name, [ATTR_GEN_AI_TOOL_CALL_ID]: toolCall.id },
      async (span) => {
        const result = await this.executeToolCallUninstrumented(toolCall, ctx);
        if (!result.success) {
          await setSpanError(span, result.error);
        }
        return result;
      },
    );
  }

  private async executeToolCallUninstrumented(
    toolCall: ToolCall,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const { name, arguments: args } = toolCall.function;
    const tool = this.tools.get(name);

    if (!tool) {
      const err = new OllamaNotFoundError(`Tool "${name}" is not registered in this registry`);
      return this.handleExecutionError(err, toolCall);
    }

    const parseResult = tool.schema.safeParse(args);
    if (!parseResult.success) {
      const err = new OllamaToolValidationError(`Tool "${name}" arguments validation failed`, {
        toolName: name,
        issues: parseResult.error.issues,
        cause: parseResult.error,
      });
      return this.handleExecutionError(err, toolCall);
    }

    try {
      const result = await this.runWithTimeout(tool, parseResult.data, ctx, name);
      const outputString = this.truncateOutput(
        typeof result === 'string' ? result : JSON.stringify(result),
      );
      return {
        toolName: name,
        toolCallId: toolCall.id,
        success: true,
        result,
        outputString,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return this.handleExecutionError(error, toolCall);
    }
  }

  /**
   * Executes every call in `toolCalls` and returns results in the same order, so results
   * are always correlatable by array position regardless of `id`. Each result also echoes
   * its call's `toolCallId` for callers who'd rather match by ID — see the {@link ToolCall}
   * docs for how that id is produced. Runs fully in parallel (`Promise.all`) unless
   * `maxConcurrency` was configured, in which case a bounded worker pool is used instead.
   */
  async executeToolCalls(
    toolCalls: readonly ToolCall[],
    ctx: ToolExecutionContext = {},
  ): Promise<ToolExecutionResult[]> {
    const limit = this.maxConcurrency;
    if (!limit || limit >= toolCalls.length) {
      return Promise.all(toolCalls.map((tc) => this.executeToolCall(tc, ctx)));
    }

    const results = new Array<ToolExecutionResult>(toolCalls.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      for (let i = nextIndex++; i < toolCalls.length; i = nextIndex++) {
        results[i] = await this.executeToolCall(toolCalls[i] as ToolCall, ctx);
      }
    };
    await Promise.all(Array.from({ length: limit }, () => worker()));
    return results;
  }

  private async runWithTimeout<TParams>(
    tool: Tool<TParams, unknown>,
    params: TParams,
    ctx: ToolExecutionContext,
    toolName: string,
  ): Promise<unknown> {
    const timeoutMs = tool.timeoutMs ?? this.defaultTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) {
      return tool.execute(params, ctx);
    }

    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort(ctx.signal?.reason);
    if (ctx.signal) {
      if (ctx.signal.aborted) {
        controller.abort(ctx.signal.reason);
      } else {
        ctx.signal.addEventListener('abort', onParentAbort, { once: true });
      }
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    using _timer = disposableTimer(timer);
    // Also clean up the parent-abort listener at scope exit (conditional on ctx.signal)
    using _listener = {
      [Symbol.dispose]() {
        ctx.signal?.removeEventListener('abort', onParentAbort);
      },
    };

    const executePromise = Promise.resolve(
      tool.execute(params, { ...ctx, signal: controller.signal }),
    );
    // Prevent an unhandled rejection if the tool's promise loses the race and later
    // rejects; the tool remains responsible for actually stopping its own work via
    // `signal` since JS cannot forcibly cancel work already in flight.
    executePromise.catch(() => undefined);

    const abortRejection = (): Error =>
      timedOut
        ? new OllamaToolTimeoutError(`Tool "${toolName}" timed out after ${timeoutMs}ms`, {
            toolName,
            timeoutMs,
          })
        : ((ctx.signal?.reason as Error | undefined) ?? new Error('Tool execution aborted'));

    return await Promise.race([
      executePromise,
      controller.signal.aborted
        ? Promise.reject(abortRejection())
        : new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => reject(abortRejection()), {
              once: true,
            });
          }),
    ]);
    // clearTimeout(timer) + removeEventListener called automatically via `using`
  }

  private truncateOutput(output: string): string {
    const limit = this.maxOutputChars;
    if (!limit || output.length <= limit) {
      return output;
    }
    return `${output.slice(0, limit)}\n… [truncated ${output.length - limit} of ${output.length} chars]`;
  }

  private handleExecutionError(error: Error, toolCall: ToolCall): ToolExecutionResult {
    const fallbackMessage = this.onError ? this.onError(error, toolCall) : error.message;
    return {
      toolName: toolCall.function.name,
      toolCallId: toolCall.id,
      success: false,
      error,
      outputString: this.truncateOutput(fallbackMessage),
    };
  }
}
