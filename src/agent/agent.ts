/**
 * Multi-turn tool execution loop agent.
 */

import { OllamaAgentMaxIterationsError } from '../errors.js';
import {
  withSpan,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_OLLAMA_AGENT_MAX_ITERATIONS,
  ATTR_OLLAMA_AGENT_ITERATION,
  GEN_AI_SYSTEM_OLLAMA,
} from '../telemetry/index.js';
import { ensureToolCallIds } from '../tools/tool-call-id.js';
import type { Message, ModelOptions, ToolDefinition } from '../types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentConfig, AgentHooks, AgentResult, AgentRunInput, AgentTurn } from './types.js';

export interface AgentChatClient {
  chat(request: {
    readonly model: string;
    readonly messages: readonly Message[];
    readonly tools?: readonly ToolDefinition[] | undefined;
    readonly options?: ModelOptions | undefined;
    readonly think?: boolean | 'low' | 'medium' | 'high' | 'max' | undefined;
    readonly stream?: false | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{ readonly message: Message }>;
}

/**
 * Runs a multi-turn `chat` + tool-execution loop until the model responds without
 * requesting further tool calls, or `maxIterations` is exceeded. Tool calls within a
 * single turn are handed to `ToolRegistry.executeToolCalls` and their results are
 * appended to history in the same order the model requested them, each tagged with the
 * originating call's `tool_call_id` — see the {@link ToolCall} type docs for how that id
 * is produced (Ollama's native tool-calling protocol has none; this SDK synthesizes one).
 * `Agent` assigns ids defensively even when `AgentChatClient` isn't `OllamaClient` (e.g. a
 * custom/test implementation), so this guarantee holds regardless of which chat client is
 * supplied.
 */
export class Agent {
  private readonly client: AgentChatClient;
  private readonly tools?: ToolRegistry | undefined;
  private readonly maxIterations: number;
  private readonly hooks?: AgentHooks | undefined;

  constructor(client: AgentChatClient, config: AgentConfig = {}) {
    this.client = client;
    this.tools = config.tools;
    this.maxIterations = config.maxIterations ?? 10;
    this.hooks = config.hooks;
  }

  run(input: AgentRunInput): Promise<AgentResult> {
    return withSpan(
      `invoke_agent ${input.model}`,
      {
        [ATTR_GEN_AI_SYSTEM]: GEN_AI_SYSTEM_OLLAMA,
        [ATTR_GEN_AI_OPERATION_NAME]: 'invoke_agent',
        [ATTR_GEN_AI_REQUEST_MODEL]: input.model,
        [ATTR_OLLAMA_AGENT_MAX_ITERATIONS]: this.maxIterations,
      },
      () => this.runLoop(input),
    );
  }

  private async runLoop(input: AgentRunInput): Promise<AgentResult> {
    const history: Message[] = [...input.messages];
    const turns: AgentTurn[] = [];
    const toolDefs = this.tools?.definitions();

    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      const outcome = await withSpan(
        'ollama.agent.turn',
        { [ATTR_OLLAMA_AGENT_ITERATION]: iteration },
        async () => {
          this.hooks?.onTurnStart?.(iteration);

          const response = await this.client.chat({
            model: input.model,
            messages: history,
            ...(toolDefs !== undefined ? { tools: toolDefs } : {}),
            ...(input.options !== undefined ? { options: input.options } : {}),
            ...(input.think !== undefined ? { think: input.think } : {}),
            stream: false,
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
          });

          const rawToolCalls = response.message.tool_calls;
          const toolCalls = ensureToolCallIds(rawToolCalls);
          const assistantMessage: Message =
            toolCalls === rawToolCalls
              ? response.message
              : { ...response.message, tool_calls: toolCalls };
          history.push(assistantMessage);

          if (!toolCalls || toolCalls.length === 0 || !this.tools) {
            const finalTurn: AgentTurn = { iteration, message: assistantMessage };
            turns.push(finalTurn);
            this.hooks?.onTurnEnd?.(finalTurn);
            return { done: true as const, finalMessage: assistantMessage };
          }

          for (const tc of toolCalls) {
            this.hooks?.onToolCallStart?.(tc);
          }

          const toolResults = await this.tools.executeToolCalls(toolCalls, {
            signal: input.signal,
          });

          for (const res of toolResults) {
            this.hooks?.onToolCallEnd?.(res);
            history.push({
              role: 'tool',
              tool_name: res.toolName,
              ...(res.toolCallId !== undefined ? { tool_call_id: res.toolCallId } : {}),
              content: res.outputString,
            });
          }

          const turn: AgentTurn = { iteration, message: assistantMessage, toolCalls, toolResults };
          turns.push(turn);
          this.hooks?.onTurnEnd?.(turn);
          return { done: false as const };
        },
      );

      if (outcome.done) {
        return { finalMessage: outcome.finalMessage, turns, totalIterations: iteration };
      }
    }

    throw new OllamaAgentMaxIterationsError(
      `Agent exceeded max iterations (${this.maxIterations}) without converging`,
      { maxIterations: this.maxIterations },
    );
  }
}
