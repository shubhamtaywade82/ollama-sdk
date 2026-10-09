/**
 * Agent loop options, turn state, and execution hooks.
 */

import type { Message, ModelOptions, ThinkValue, ToolCall } from '../types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutionResult } from '../tools/types.js';

export interface AgentTurn {
  readonly iteration: number;
  readonly message: Message;
  readonly toolCalls?: readonly ToolCall[] | undefined;
  readonly toolResults?: readonly ToolExecutionResult[] | undefined;
}

export interface AgentResult {
  readonly finalMessage: Message;
  readonly turns: readonly AgentTurn[];
  readonly totalIterations: number;
}

export interface AgentHooks {
  readonly onTurnStart?: ((iteration: number) => void) | undefined;
  readonly onToken?: ((delta: string) => void) | undefined;
  readonly onThinking?: ((delta: string) => void) | undefined;
  readonly onToolCallStart?: ((toolCall: ToolCall) => void) | undefined;
  readonly onToolCallEnd?: ((result: ToolExecutionResult) => void) | undefined;
  readonly onTurnEnd?: ((turn: AgentTurn) => void) | undefined;
}

export interface AgentConfig {
  readonly tools?: ToolRegistry | undefined;
  readonly maxIterations?: number | undefined;
  /** Maximum total tool calls allowed during one agent run. */
  readonly maxToolCalls?: number | undefined;
  /**
   * Cycle detection: maximum executions of one *identical* tool call — same
   * tool name and same arguments — during a single run. When the model would
   * exceed this budget (the classic stuck-loop signature: re-emitting the
   * same call without reacting to its results), the run fails fast with
   * {@link OllamaAgentToolLoopError} instead of burning the remaining
   * iterations on the same wasted call.
   *
   * Off by default (`undefined`), matching `maxToolCalls`: an explicit,
   * caller-owned guardrail. Counting is per canonical signature, so
   * argument key order never splits one repeated call into several
   * "distinct" ones. Every call handed to the registry counts — failed,
   * unregistered, and timed-out executions included, since re-calling a
   * failing tool with unchanged arguments is exactly the loop this catches.
   */
  readonly maxRepeatedToolCalls?: number | undefined;
  readonly hooks?: AgentHooks | undefined;
  /** Validate tool support from /api/show before starting a tool-enabled run. Default: true. */
  readonly validateToolCapability?: boolean | undefined;
  /**
   * Automatic context size for tool-enabled runs when options.num_ctx is not supplied.
   * Defaults to 32768 and is clamped to the model-reported maximum when available.
   */
  readonly toolContextSize?: number | undefined;
}

export interface AgentRunInput {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly options?: ModelOptions | undefined;
  readonly think?: ThinkValue | undefined;
  readonly signal?: AbortSignal | undefined;
}
