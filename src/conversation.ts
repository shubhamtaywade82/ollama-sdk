/**
 * KV-prefix-preserving conversation sessions.
 *
 * Ollama reuses the model's KV cache across turns of a conversation by
 * **prompt prefix matching**: if the new prompt's leading tokens are
 * byte-identical to the previous turn's, the cached prefix is reused and
 * only the new suffix is evaluated — surfaced by the server as
 * `prompt_eval_cached_count`. Anything that mutates the prefix invalidates
 * the whole cache and forces a full re-evaluation (`prompt_eval_count`
 * spikes, latency jumps): changing the system prompt, prepending dynamic
 * timestamps or request IDs to the conversation, or reordering past turns.
 *
 * `ConversationSession` makes the cache-friendly structure the default:
 *
 *   - The system prompt (if any) is fixed at construction and always the
 *     first message. There is deliberately **no API to mutate it later** —
 *     a mutable system prompt is the #1 silent KV-cache killer.
 *   - History is append-only. Messages are never reordered, rewritten, or
 *     re-serialized between turns — `getMessages()` copies, so external
 *     mutation can't leak in either.
 *   - Per-turn options (`options`, `think`, `tools`, …) ride on the request,
 *     not the history, so changing them never disturbs the prefix.
 *
 * Each turn records what the server reported about the cache, so degrading
 * hit rates (a symptom of prefix churn somewhere upstream, or a context
 * window that no longer holds the whole history) are visible in
 * {@link ConversationSession.cacheStats} instead of hiding in raw responses.
 */

import type { OllamaClient } from './client.js';
import { estimateMessageTokens, OLLAMA_FALLBACK_CONTEXT_LENGTH } from './context-safety.js';
import type {
  ChatRequestOptions,
  ChatResponse,
  FormatOption,
  Message,
  ModelOptions,
  ThinkValue,
  ToolDefinition,
} from './types.js';

/** What one turn's response reported about KV-cache reuse and evaluation. */
export interface TurnCacheStats {
  /** Prompt tokens served from the KV cache this turn. */
  readonly cachedTokens: number;
  /** Prompt tokens freshly evaluated this turn. */
  readonly evaluatedTokens: number;
  /**
   * Cache hit rate for this turn: `cached / (cached + evaluated)`.
   *
   * Note the denominator adds both counters — when the *entire* prompt hits
   * the cache, Ollama reports `prompt_eval_count: 0`, so dividing by
   * `prompt_eval_count` alone would falsely yield a 0% hit rate on the
   * best-case turn.
   */
  readonly hitRate: number;
}

/** Cumulative cache statistics across every completed turn so far. */
export interface CumulativeCacheStats extends TurnCacheStats {
  /** Number of completed turns (user+assistant pairs). */
  readonly turns: number;
  /** Total prompt tokens across turns, cached + evaluated. */
  readonly totalPromptTokens: number;
}

/** Everything one {@link ConversationSession.sendTurn} call knows. */
export interface SessionTurn {
  /** The assistant's text reply (same value `send()` returns). */
  readonly content: string;
  /** What the server reported about KV-cache reuse for this turn. */
  readonly cache: TurnCacheStats;
  /** The full underlying `/api/chat` response (usage, durations, thinking, …). */
  readonly response: ChatResponse;
}

/** Options for {@link compactConversationHistory} / {@link ConversationSession.compact}. */
export interface CompactionOptions {
  /**
   * Estimated-token budget the compacted history must fit within (including
   * any retained system message and the 10%-style reply reservation below).
   * Estimated with the same CJK-aware heuristic as the pre-flight checks
   * (`estimateMessageTokens` — ±20–30%, message overhead + tool calls +
   * `IMAGE_TOKEN_ESTIMATE` per image included).
   */
  readonly maxEstimatedTokens: number;
  /**
   * Tokens subtracted from the budget and reserved for the model's next
   * reply (default `0` for the pure function; `session.compact()` defaults
   * to ~10% of the window, mirroring the pre-flight warning threshold's
   * headroom).
   */
  readonly reserveForReply?: number | undefined;
  /**
   * Trailing messages always retained, even when they don't fit the budget
   * (default `2` — the latest user/assistant exchange). Guarantees a
   * compacted conversation never loses its most recent context; an
   * oversized tail is retained deliberately rather than truncated, because
   * silent truncation is the server's failure mode, not one this SDK
   * reproduces.
   */
  readonly minTailMessages?: number | undefined;
}

/**
 * Sliding-window history compaction: keep the pinned system message(s) plus
 * the most recent turns that fit `maxEstimatedTokens`, dropping the oldest
 * turns in between.
 *
 * Deliberately **not** automatic anywhere in the SDK: compaction rewrites the
 * prompt prefix, so the next request's KV-cache hit rate drops to zero and
 * the whole retained suffix re-evaluates. That tradeoff (latency + recompute
 * for a window that now fits) is sometimes exactly right — long-running
 * agent threads that would otherwise silently lose their oldest turns — and
 * sometimes catastrophic (a hot cache-friendly session that never actually
 * overflows). `ConversationSession.cacheStats` makes the "session no longer
 * fits" case visible; this function is the explicit, caller-initiated fix.
 *
 * Semantics:
 *
 *   - **Leading `system` messages are always retained** and count against
 *     the budget (they consume context too).
 *   - Non-system messages are walked newest → oldest; each is retained while
 *     it fits the remaining budget, or while fewer than `minTailMessages`
 *     have been retained.
 *   - Mid-conversation `system`/`tool` messages are ordinary tailable
 *     history (only the *leading* system block is pinned).
 *   - Returns a new array; the input is never mutated. Message objects are
 *     reused by reference (sessions freeze them; external arrays are copied
 *     defensively by the caller if needed).
 *
 * ```ts
 * const kept = compactConversationHistory(session.getMessages(), {
 *   maxEstimatedTokens: window.contextLength,
 *   reserveForReply: 512,
 * });
 * ```
 */
export function compactConversationHistory(
  messages: readonly Message[],
  options: CompactionOptions,
): readonly Message[] {
  const reserve = Math.max(0, options.reserveForReply ?? 0);
  const minTail = Math.max(0, options.minTailMessages ?? 2);
  const budget = Math.max(0, options.maxEstimatedTokens - reserve);

  // Pin the leading system block (zero or more messages).
  let split = 0;
  while (split < messages.length && messages[split]!.role === 'system') split += 1;
  const pinned = messages.slice(0, split);
  const tail = messages.slice(split);

  let used = 0;
  for (const message of pinned) used += estimateMessageTokens(message);

  const retained: Message[] = [];
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const message = tail[i]!;
    const cost = estimateMessageTokens(message);
    const fits = used + cost <= budget;
    if (!fits && retained.length >= minTail) break;
    retained.unshift(message);
    used += cost;
  }

  return [...pinned, ...retained];
}

/** Options for {@link ConversationSession.compact}; all fields optional. */
export interface SessionCompactionOptions {
  /**
   * Token budget for the compacted history. Defaults to the session's own
   * window: `options.num_ctx` from the session config, or Ollama's
   * conservative 2048 fallback when unset — pair with
   * `client.models.getContextLength()` to program against the real window.
   */
  readonly maxEstimatedTokens?: number | undefined;
  /** Reply reservation; defaults to ~10% of the (derived) budget. */
  readonly reserveForReply?: number | undefined;
  /** Trailing messages always kept (default `2`). See {@link CompactionOptions}. */
  readonly minTailMessages?: number | undefined;
}

/** What {@link ConversationSession.compact} did. */
export interface SessionCompactionResult {
  /** Number of messages dropped from the front of the tailable history. */
  readonly droppedMessages: number;
  /** Estimated tokens of the whole history before compaction. */
  readonly estimatedTokensBefore: number;
  /** Estimated tokens of the retained history after compaction. */
  readonly estimatedTokensAfter: number;
  /** The budget that was applied (after the reply reservation). */
  readonly effectiveBudget: number;
}

/** Per-turn overrides — none of these touch the history prefix, so they are KV-safe. */
export interface ConversationSendOptions extends Pick<ChatRequestOptions, 'signal' | 'timeoutMs'> {
  readonly options?: ModelOptions | undefined;
  readonly think?: ThinkValue | undefined;
  readonly keep_alive?: string | number | undefined;
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly format?: FormatOption | undefined;
}

/** Static configuration for a session, fixed at construction (KV-prefix safety). */
export interface ConversationSessionOptions {
  readonly model: string;
  /**
   * System prompt, pinned as the first history message for the session's
   * whole lifetime. Avoid dynamic content here (timestamps, request IDs) —
   * a per-call system prompt defeats prefix caching entirely.
   */
  readonly systemPrompt?: string | undefined;
  /** Default `options` (sampler settings, `num_ctx`, …) applied to every turn. */
  readonly options?: ModelOptions | undefined;
  /** Default `think` control applied to every turn. */
  readonly think?: ThinkValue | undefined;
  /** Default `keep_alive` applied to every turn. */
  readonly keep_alive?: string | number | undefined;
  /** Default `tools` applied to every turn. */
  readonly tools?: readonly ToolDefinition[] | undefined;
  /** Default `format` (structured output) applied to every turn. */
  readonly format?: FormatOption | undefined;
}

function extractTurnStats(res: ChatResponse): TurnCacheStats {
  const cachedTokens = res.prompt_eval_cached_count ?? 0;
  const evaluatedTokens = res.prompt_eval_count ?? 0;
  const total = cachedTokens + evaluatedTokens;
  return {
    cachedTokens,
    evaluatedTokens,
    hitRate: total > 0 ? cachedTokens / total : 0,
  };
}

/**
 * A multi-turn chat session with an immutable, cache-friendly message
 * history. Create via `client.session(...)` or construct directly:
 *
 * ```ts
 * const session = client.session('llama3.1', 'You are a concise assistant.');
 * await session.send('Hi!');        // turn 1 — cold cache
 * await session.send('Why is the sky blue?'); // turn 2 — prefix reused
 * session.cacheStats;               // cumulative hit rate
 * ```
 */
export class ConversationSession {
  /** Ordered, append-only history. Message objects are frozen on push. */
  private readonly history: Message[] = [];
  /** Mutable tallies behind the read-only {@link cacheStats} view. */
  private readonly tallies = {
    turns: 0,
    cachedTokens: 0,
    evaluatedTokens: 0,
  };

  constructor(
    private readonly client: OllamaClient,
    private readonly config: ConversationSessionOptions,
  ) {
    if (config.systemPrompt !== undefined && config.systemPrompt !== '') {
      this.history.push(Object.freeze({ role: 'system', content: config.systemPrompt }) as Message);
    }
  }

  /** The model name this session talks to. */
  get model(): string {
    return this.config.model;
  }

  /** Number of completed turns. */
  get turnCount(): number {
    return this.tallies.turns;
  }

  /** Cumulative KV-cache statistics across completed turns. */
  get cacheStats(): CumulativeCacheStats {
    const total = this.tallies.cachedTokens + this.tallies.evaluatedTokens;
    return {
      turns: this.tallies.turns,
      cachedTokens: this.tallies.cachedTokens,
      evaluatedTokens: this.tallies.evaluatedTokens,
      totalPromptTokens: total,
      hitRate: total > 0 ? this.tallies.cachedTokens / total : 0,
    };
  }

  /**
   * Sends the user's message and returns the assistant's reply text —
   * the ergonomic path. Use {@link sendTurn} when you also need the
   * per-turn cache statistics or the raw response.
   */
  async send(content: string, overrides?: ConversationSendOptions): Promise<string> {
    const turn = await this.sendTurn(content, overrides);
    return turn.content;
  }

  /**
   * Sends the user's message and returns the full turn record: reply text,
   * per-turn KV-cache statistics, and the raw `/api/chat` response.
   */
  async sendTurn(content: string, overrides?: ConversationSendOptions): Promise<SessionTurn> {
    this.history.push(Object.freeze({ role: 'user', content }) as Message);

    const response = await this.client.chat({
      model: this.config.model,
      messages: [...this.history],
      ...(this.config.tools !== undefined || overrides?.tools !== undefined
        ? { tools: overrides?.tools ?? this.config.tools }
        : {}),
      ...(this.config.format !== undefined || overrides?.format !== undefined
        ? { format: overrides?.format ?? this.config.format }
        : {}),
      options: { ...this.config.options, ...overrides?.options },
      ...(this.config.think !== undefined || overrides?.think !== undefined
        ? { think: overrides?.think ?? this.config.think }
        : {}),
      ...(this.config.keep_alive !== undefined || overrides?.keep_alive !== undefined
        ? { keep_alive: overrides?.keep_alive ?? this.config.keep_alive }
        : {}),
      ...(overrides?.signal !== undefined ? { signal: overrides.signal } : {}),
      ...(overrides?.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
      stream: false,
    });

    // Append exactly what the server produced (content, tool_calls, thinking)
    // — reusing the response's message object verbatim guarantees the next
    // turn's prefix matches what the model actually saw.
    this.history.push(Object.freeze({ ...response.message }) as Message);

    const cache = extractTurnStats(response);
    this.tallies.turns += 1;
    this.tallies.cachedTokens += cache.cachedTokens;
    this.tallies.evaluatedTokens += cache.evaluatedTokens;

    return { content: response.message.content, cache, response };
  }

  /**
   * A defensive copy of the session history — mutating the returned array or
   * its frozen messages has no effect on the session.
   */
  getMessages(): readonly Message[] {
    return this.history.map((message) => message);
  }

  /**
   * Compacts the session's history in place: pinned system prompt plus the
   * most recent turns that fit the budget, oldest tailable turns dropped.
   *
   * This is the explicit escape hatch for sessions that outgrew their
   * window — `cacheStats.hitRate` collapsing toward zero while history grows
   * is the usual symptom, and the pre-flight warnings on `chat()` fire once
   * the prompt estimate crosses the threshold. After compaction the next
   * turn's prompt prefix differs from everything before it, so the KV cache
   * starts cold — visible as a one-turn `evaluatedTokens` spike in
   * `cacheStats`. Cumulative cache tallies are deliberately **not** reset:
   * they are observations, and the spike is part of the story.
   *
   * Returns the before/after estimates and the drop count. No-op (zero
   * drops, equal before/after estimates) when the history already fits.
   */
  compact(options: SessionCompactionOptions = {}): SessionCompactionResult {
    const window =
      options.maxEstimatedTokens ?? this.config.options?.num_ctx ?? OLLAMA_FALLBACK_CONTEXT_LENGTH;
    const reserve = options.reserveForReply ?? Math.ceil(window * 0.1);
    const estimatedTokensBefore = this.history.reduce(
      (sum, message) => sum + estimateMessageTokens(message),
      0,
    );
    const compacted = compactConversationHistory(this.history, {
      maxEstimatedTokens: window,
      reserveForReply: reserve,
      ...(options.minTailMessages !== undefined
        ? { minTailMessages: options.minTailMessages }
        : {}),
    });
    const estimatedTokensAfter = compacted.reduce(
      (sum, message) => sum + estimateMessageTokens(message),
      0,
    );
    const droppedMessages = this.history.length - compacted.length;
    this.history.length = 0;
    this.history.push(...compacted);
    return {
      droppedMessages,
      estimatedTokensBefore,
      estimatedTokensAfter,
      effectiveBudget: window - reserve,
    };
  }

  /**
   * Clears the conversation back to its initial state (system prompt, zero
   * turns, zeroed cache statistics). The next turn starts with a cold cache
   * by definition — there is nothing upstream of it to reuse.
   */
  reset(): void {
    this.history.length = 0;
    if (this.config.systemPrompt !== undefined && this.config.systemPrompt !== '') {
      this.history.push(
        Object.freeze({ role: 'system', content: this.config.systemPrompt }) as Message,
      );
    }
    this.tallies.turns = 0;
    this.tallies.cachedTokens = 0;
    this.tallies.evaluatedTokens = 0;
  }
}
