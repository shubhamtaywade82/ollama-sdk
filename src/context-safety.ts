/**
 * Context-window safety: client-side token estimation and pre-flight overflow
 * warnings for `/api/chat` and `/api/generate`.
 *
 * Why this exists: when `options.num_ctx` is left unset, Ollama loads the
 * model with a conservative default context window (commonly 2048–4096
 * tokens, model-dependent) and **silently truncates** any prompt that doesn't
 * fit — the model just loses the top of the conversation with no error, no
 * warning, and often no visible symptom beyond degraded answers. This module
 * estimates the prompt size client-side (a fast heuristic — no tokenizer
 * download, no model dependency) and surfaces a warning *before* the request
 * is sent, when the estimate approaches the effective context window.
 *
 * The estimator is deliberately simple and documented as approximate
 * (±20–30% vs a real BPE tokenizer):
 *
 *   - CJK code points (Chinese/Japanese/Korean) count as ~1 token each —
 *     modern tokenizers emit roughly one token per CJK character.
 *   - Everything else estimates at ~4 characters per token, the classic
 *     English GPT-style average.
 *   - Each attached image adds a fixed {@link IMAGE_TOKEN_ESTIMATE} —
 *     vision encoders consume a roughly predictable tile budget per image
 *     (e.g. LLaVA-family encoders emit a few hundred tokens per image).
 *
 * It is used in three places:
 *
 *   1. `OllamaClient.chat()`/`generate()` pre-flight — logs a warning (or
 *      throws, per `onContextOverflow`) when the estimate crosses
 *      {@link DEFAULT_CONTEXT_WARNING_THRESHOLD} of the effective window.
 *   2. The `defaultContextLength` client config — injects `num_ctx` when the
 *      caller didn't set one, making the effective window explicit instead
 *      of server-default guesswork.
 *   3. `ConversationSession` — sessions grow monotonically, so they surface
 *      cache and context stats per turn.
 */

import type { ChatRequestOptions, GenerateRequestOptions, Message } from './types.js';

/**
 * Fraction of the effective context window at which a pre-flight warning
 * fires. 0.9 = warn when the estimated prompt reaches 90% of `num_ctx`.
 * Above this, the response has little room left and the next turn's history
 * will almost certainly overflow.
 */
export const DEFAULT_CONTEXT_WARNING_THRESHOLD = 0.9;

/**
 * Rough token budget consumed per attached image. Vision encoders emit a few
 * hundred embedding tokens per image tile; 300 sits between LLaVA-1.5's ~258
 * and qwen-vl's higher tile counts. This is an estimate for warning purposes
 * only — it never gates a request on its own unless images push the total
 * past the threshold.
 */
export const IMAGE_TOKEN_ESTIMATE = 300;

/** Tokens estimated per non-CJK character of text. */
const CHARS_PER_TOKEN = 4;

/** CJK Unified Ideographs and the common extension/full-width ranges. */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0xff00 && code <= 0xffef) // Full-width forms
  );
}

/**
 * Heuristic token estimate for a single text string: ~1 token per CJK
 * character + ~1 token per 4 non-CJK characters. Approximate by design —
 * accurate enough to warn against silent truncation without shipping a
 * model-specific tokenizer.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (isCjkCodePoint(char.codePointAt(0) ?? 0)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / CHARS_PER_TOKEN);
}

/**
 * Rough per-message framing overhead: role tags, chat-template delimiters.
 */
export const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateMessageTokens(message: Message): number {
  let total = MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content ?? '');
  if (message.thinking !== undefined) total += estimateTokens(message.thinking);
  if (message.tool_calls !== undefined) {
    for (const call of message.tool_calls) {
      total += estimateTokens(call.function.name);
      total += estimateTokens(JSON.stringify(call.function.arguments ?? {}));
    }
  }
  if (message.images !== undefined) total += message.images.length * IMAGE_TOKEN_ESTIMATE;
  return total;
}

/**
 * Estimated prompt tokens for a `/api/chat` request: every message plus
 * tool-schema overhead (each tool definition's JSON schema serializes into
 * the prompt on Ollama's side).
 */
export function estimateChatRequestTokens(req: ChatRequestOptions): number {
  let total = 0;
  for (const message of req.messages) total += estimateMessageTokens(message);
  if (req.tools !== undefined) {
    for (const tool of req.tools) {
      total += estimateTokens(tool.function.description ?? '');
      total += estimateTokens(JSON.stringify(tool.function.parameters ?? {}));
    }
  }
  return total;
}

/** Estimated prompt tokens for a `/api/generate` request (prompt + system + images). */
export function estimateGenerateRequestTokens(req: GenerateRequestOptions): number {
  let total = estimateTokens(req.prompt ?? '');
  if (req.system !== undefined) total += estimateTokens(req.system);
  if (req.template !== undefined) total += estimateTokens(req.template);
  if (req.images !== undefined) total += req.images.length * IMAGE_TOKEN_ESTIMATE;
  return total;
}

/** Where the context window used by a pre-flight check came from. */
export type ContextWindowSource =
  /** Explicit `options.num_ctx` on the request — exact, server-enforced. */
  | 'request'
  /** Client `defaultContextLength` config — injected as `num_ctx` by the pipeline. */
  | 'client-default'
  /** Neither set; Ollama's server default applies (2048–4096, model-dependent). */
  | 'server-fallback';

/** What the pre-flight check concluded about one request. */
export interface ContextCheck {
  /** Estimated prompt tokens (heuristic — see {@link estimateTokens}). */
  readonly estimatedPromptTokens: number;
  /** The context window the estimate was compared against. */
  readonly effectiveContextLength: number;
  /** Where that window came from. */
  readonly windowSource: ContextWindowSource;
  /** True when the estimate crossed the warning threshold of the effective window. */
  readonly exceedsThreshold: boolean;
  /**
   * Present only when `exceedsThreshold` is `true`: the smallest power-of-two
   * window with ~30% generation headroom above the estimate (see
   * {@link recommendContextWindow}). A starting point, not a verdict — check
   * the model's native ceiling with `client.models.getContextLength()` before
   * adopting it; a prompt that outgrows the native maximum needs compaction
   * or history truncation, not a bigger `num_ctx`.
   */
  readonly recommendedNumCtx?: number | undefined;
}

/**
 * Smallest power-of-two context window that comfortably fits
 * `estimatedTokens` — ~30% headroom for the response, floored at 4096 (the
 * common modern server default when `num_ctx` is unset).
 *
 * Uses an exact doubling loop rather than
 * `Math.pow(2, Math.ceil(Math.log2(x)))`: floating-point `log2` of exact
 * powers of two can land marginally above the integer (e.g.
 * `Math.log2(8) > 3` on some platforms), which rounds a perfect fit *up* a
 * whole power of two. The loop has no such boundary bugs.
 *
 * Non-finite / non-positive inputs return the 4096 floor rather than throwing:
 * callers use this to *suggest* a window after their own estimate already
 * flagged a problem, so garbage-in should degrade to a conservative
 * suggestion, not a second error path.
 */
export function recommendContextWindow(estimatedTokens: number): number {
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return 4096;
  const target = estimatedTokens * 1.3;
  let window = 4096;
  while (window < target) window *= 2;
  return window;
}

export interface ContextCheckOptions {
  /** Client `defaultContextLength`, applied when the request doesn't set `num_ctx`. */
  readonly defaultContextLength?: number | undefined;
  /** Warning threshold; defaults to {@link DEFAULT_CONTEXT_WARNING_THRESHOLD}. */
  readonly threshold?: number | undefined;
}

/**
 * Runs the pre-flight context check for a chat request. Pure — callers decide
 * what to do with the result (log, throw, ignore).
 */
export function checkChatContext(
  req: ChatRequestOptions,
  options: ContextCheckOptions = {},
): ContextCheck {
  return check(estimateChatRequestTokens(req), req.options?.num_ctx, options);
}

/**
 * Runs the pre-flight context check for a generate request. Pure — callers
 * decide what to do with the result (log, throw, ignore).
 */
export function checkGenerateContext(
  req: GenerateRequestOptions,
  options: ContextCheckOptions = {},
): ContextCheck {
  return check(estimateGenerateRequestTokens(req), req.options?.num_ctx, options);
}

function check(
  estimatedPromptTokens: number,
  requestNumCtx: number | undefined,
  options: ContextCheckOptions,
): ContextCheck {
  const threshold = options.threshold ?? DEFAULT_CONTEXT_WARNING_THRESHOLD;
  // With no explicit window anywhere, compare against the conservative 2048
  // fallback *without* the safety margin — the real server default may be as
  // high as 4096, so warning at merely 90% of an assumed 2048 would produce
  // false positives. Only flag prompts that outright exceed the fallback.
  if (requestNumCtx !== undefined) {
    const exceeds = estimatedPromptTokens > requestNumCtx * threshold;
    return {
      estimatedPromptTokens,
      effectiveContextLength: requestNumCtx,
      windowSource: 'request',
      exceedsThreshold: exceeds,
      ...(exceeds ? { recommendedNumCtx: recommendContextWindow(estimatedPromptTokens) } : {}),
    };
  }
  if (options.defaultContextLength !== undefined) {
    const exceeds = estimatedPromptTokens > options.defaultContextLength * threshold;
    return {
      estimatedPromptTokens,
      effectiveContextLength: options.defaultContextLength,
      windowSource: 'client-default',
      exceedsThreshold: exceeds,
      ...(exceeds ? { recommendedNumCtx: recommendContextWindow(estimatedPromptTokens) } : {}),
    };
  }
  const exceeds = estimatedPromptTokens > OLLAMA_FALLBACK_CONTEXT_LENGTH;
  return {
    estimatedPromptTokens,
    effectiveContextLength: OLLAMA_FALLBACK_CONTEXT_LENGTH,
    windowSource: 'server-fallback',
    exceedsThreshold: exceeds,
    ...(exceeds ? { recommendedNumCtx: recommendContextWindow(estimatedPromptTokens) } : {}),
  };
}

/**
 * The conservative server-side default (2048) Ollama most commonly applies
 * when `num_ctx` is unset — used to warn about *likely* truncation even when
 * no effective window is known client-side.
 */
export const OLLAMA_FALLBACK_CONTEXT_LENGTH = 2048;

/**
 * Builds the human-readable warning text for a failed pre-flight check.
 * Exported for reuse by `ConversationSession` and for tests.
 */
export function contextWarningMessage(check: ContextCheck, kind: 'chat' | 'generate'): string {
  const where = `OllamaClient.${kind}()`;
  const estimate = `~${check.estimatedPromptTokens} tokens`;
  // When the check carries a concrete suggestion (it does whenever it
  // exceeds the threshold — see `check()`), surface it with the ceiling
  // caveat: the number is a fit for *this estimate*, not a guarantee the
  // model's native context goes that high.
  const suggestion =
    check.recommendedNumCtx !== undefined
      ? ` A window of at least ${check.recommendedNumCtx} tokens would fit this prompt with ~30% ` +
        `headroom (see \`recommendContextWindow\`) — verify the model's native maximum via ` +
        `\`client.models.getContextLength()\` before adopting it.`
      : '';
  if (check.windowSource === 'request') {
    return (
      `${where}: estimated prompt size ${estimate} is close to or beyond the request's ` +
      `context window (num_ctx=${check.effectiveContextLength}). The server will likely ` +
      `silently truncate the top of the conversation — the model loses earlier turns with ` +
      `no error. Raise \`options.num_ctx\` or shorten the conversation.${suggestion} ` +
      `Estimates are heuristic (±20–30%); see \`estimateTokens\`.`
    );
  }
  if (check.windowSource === 'client-default') {
    return (
      `${where}: estimated prompt size ${estimate} is close to or beyond the client's ` +
      `\`defaultContextLength\` (${check.effectiveContextLength}, injected as \`num_ctx\`). ` +
      `The server will likely silently truncate the top of the conversation — the model ` +
      `loses earlier turns with no error. Raise \`defaultContextLength\`, set \`options.num_ctx\` ` +
      `per request, or shorten the conversation.${suggestion} ` +
      `Estimates are heuristic (±20–30%); see \`estimateTokens\`.`
    );
  }
  return (
    `${where}: estimated prompt size ${estimate} outright exceeds Ollama's conservative ` +
    `server-default context window (${OLLAMA_FALLBACK_CONTEXT_LENGTH}–4096 tokens when ` +
    `\`num_ctx\` is unset — model-dependent). Unless the model's default is larger, the ` +
    `server will silently truncate the top of the conversation — the model loses earlier ` +
    `turns with no error. Set \`options.num_ctx\` (or the client's \`defaultContextLength\`) ` +
    `to an explicit window to make truncation visible and controllable.${suggestion} ` +
    `Estimates are heuristic (±20–30%); see \`estimateTokens\`.`
  );
}
