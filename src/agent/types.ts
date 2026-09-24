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
  readonly hooks?: AgentHooks | undefined;
}

export interface AgentRunInput {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly options?: ModelOptions | undefined;
  readonly think?: ThinkValue | undefined;
  readonly signal?: AbortSignal | undefined;
}
