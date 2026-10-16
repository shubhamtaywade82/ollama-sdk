/**
 * Ergonomic System One types — key-safe generics on top of the generated
 * contract models.
 *
 * The generated `SystemOneRequest` and `SystemOneResponse` (in
 * `src/generated/models/`) use `Record<string, ...>` for the
 * questions/answers maps. That's structurally correct but loses the
 * connection between the question names the caller sends and the answer
 * names they receive back — `response.answers.someRandomKey` would
 * compile even though the caller never asked that question.
 *
 * This file adds a generic layer:
 *
 * ```ts
 * const result = await ollama.systemOne({
 *   model: 'tev1:4b',
 *   state: { ticket: 'charged twice' },
 *   questions: {
 *     intent: { type: 'choice', ... },
 *     urgent: { type: 'noul', ... },
 *   },
 * });
 *
 * // Key-safe: 'intent' and 'urgent' are the only valid keys.
 * result.answers.intent  // ✓ SystemOneAnswer
 * result.answers.urgent  // ✓ SystemOneAnswer
 * result.answers.typo    // ✗ TypeScript error
 * ```
 *
 * The generic is purely a compile-time wrapper — the runtime behavior is
 * unchanged. The generated types remain the canonical contract; these
 * types are an SDK-level convenience that OpenAPI cannot express.
 *
 * Wave 13.
 */

// Re-export the concrete generated types that the OpenAPI source defines
// as named schemas.
//
// Each type is imported directly from its own model file (NOT the
// `./generated/models/index.js` barrel) to avoid the circular chunk
// dependency Rollup warned about during `tsup` builds (the barrel
// `index.js` re-exports the same files this module imports, so going
// through it makes `system-one.ts` and `generated/models/index.ts`
// mutually dependent). The barrel still exists for downstream
// consumers; this internal-only import path sidesteps the cycle
// without changing the public surface.
export type { SystemOneContent } from './generated/models/SystemOneContent.js';
export type { SystemOneRequest as SystemOneRequestBase } from './generated/models/SystemOneRequest.js';
export type { SystemOneResponse as SystemOneResponseBase } from './generated/models/SystemOneResponse.js';
export type { SystemOneChoiceQuestion } from './generated/models/SystemOneChoiceQuestion.js';
export type { SystemOneNoulQuestion } from './generated/models/SystemOneNoulQuestion.js';
export type { SystemOneScoreQuestion } from './generated/models/SystemOneScoreQuestion.js';
export type { SystemOneChoiceAnswer } from './generated/models/SystemOneChoiceAnswer.js';
export type { SystemOneNoulAnswer } from './generated/models/SystemOneNoulAnswer.js';
export type { SystemOneScoreAnswer } from './generated/models/SystemOneScoreAnswer.js';
export type { SystemOneProbabilities } from './generated/models/SystemOneProbabilities.js';
export type { SystemOneConfidence } from './generated/models/SystemOneConfidence.js';

import type { SystemOneChoiceQuestion } from './generated/models/SystemOneChoiceQuestion.js';
import type { SystemOneNoulQuestion } from './generated/models/SystemOneNoulQuestion.js';
import type { SystemOneScoreQuestion } from './generated/models/SystemOneScoreQuestion.js';
import type { SystemOneChoiceAnswer } from './generated/models/SystemOneChoiceAnswer.js';
import type { SystemOneNoulAnswer } from './generated/models/SystemOneNoulAnswer.js';
import type { SystemOneScoreAnswer } from './generated/models/SystemOneScoreAnswer.js';
import type { SystemOneRequest as SystemOneRequestBase } from './generated/models/SystemOneRequest.js';
import type { SystemOneResponse as SystemOneResponseBase } from './generated/models/SystemOneResponse.js';

/**
 * Whole-request size cap, in bytes, for `/v1/systemone` — the maximum
 * serialized size of the complete request, base64 image bytes included.
 *
 * Part of the dual cap clarified upstream on 2026-10-16: every request
 * must satisfy BOTH bounds simultaneously — this whole-request cap AND
 * the text-and-schema cap of {@link MAX_SYSTEM_ONE_REQUEST_BYTES}
 * (64 KiB, images excluded). The bumped whole-request cap exists
 * specifically to accommodate base64-encoded image bytes shared across
 * all questions in a single System One call; the text and schema
 * portion may never exceed 64 KiB regardless of whether images are
 * attached.
 *
 * The Ollama server enforces both bounds server-side and rejects
 * oversized payloads with HTTP 413. The SDK's runtime also enforces
 * them client-side (see `OllamaRuntime`'s `maxRequestBytesWithImages`
 * handling) so the round-trip is avoided.
 */
export const MAX_SYSTEM_ONE_IMAGES_BYTES = 32 * 1024 * 1024; // 32 MiB

/**
 * Text-and-schema size cap, in bytes, for `/v1/systemone` — the maximum
 * serialized size of the request with its `images` array excluded.
 *
 * Part of the dual cap clarified upstream on 2026-10-16: this bound
 * applies to EVERY request, images or not — attaching images raises
 * the whole-request ceiling to {@link MAX_SYSTEM_ONE_IMAGES_BYTES}
 * (32 MiB) but never relaxes this 64 KiB text-and-schema ceiling. The
 * runtime enforces both bounds client-side (see `OllamaRuntime`'s
 * `maxRequestBytes` handling).
 */
export const MAX_SYSTEM_ONE_REQUEST_BYTES = 64 * 1024; // 64 KiB

/**
 * Discriminated union of the three question kinds. The upstream OpenAPI
 * defines this inline as `oneOf` within SystemOneRequest.questions; we
 * reconstruct it as a named type for SDK ergonomics.
 */
export type SystemOneQuestion =
  SystemOneChoiceQuestion | SystemOneNoulQuestion | SystemOneScoreQuestion;

/**
 * Discriminated union of the three answer kinds. The upstream OpenAPI
 * defines this inline as `oneOf` within SystemOneResponse.answers; we
 * reconstruct it as a named type for SDK ergonomics.
 */
export type SystemOneAnswer = SystemOneChoiceAnswer | SystemOneNoulAnswer | SystemOneScoreAnswer;

/**
 * Token usage for a System One call. The upstream OpenAPI defines this
 * inline within SystemOneResponse; we reconstruct it as a named type
 * for SDK ergonomics. Carries input_tokens and output_tokens (not
 * prompt_tokens/completion_tokens).
 */
export interface SystemOneUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/** Map of question id → question descriptor. */
export type SystemOneQuestions = Record<string, SystemOneQuestion>;

/**
 * Wave 16 (P2): conditional mapping from a question type to its
 * corresponding answer type. This gives compile-time type correlation:
 *
 *   choice question → choice answer
 *   noul question   → noul answer
 *   score question  → score answer
 *
 * Without this, `SystemOneAnswers<Q>` maps every key to the full
 * `SystemOneAnswer` union, requiring manual narrowing. With this,
 * `result.answers.myChoiceQuestion` is automatically typed as
 * `SystemOneChoiceAnswer`.
 */
export type AnswerFor<Q> = Q extends { readonly type: 'choice' }
  ? SystemOneChoiceAnswer
  : Q extends { readonly type: 'noul' }
    ? SystemOneNoulAnswer
    : Q extends { readonly type: 'score' }
      ? SystemOneScoreAnswer
      : SystemOneAnswer;

/**
 * Key-safe answers map: for every question key `K` in `Q`, the response
 * carries the answer type that corresponds to that question's type.
 * Wave 16: now uses `AnswerFor<Q[K]>` for exact type correlation.
 */
export type SystemOneAnswers<Q extends SystemOneQuestions = SystemOneQuestions> = {
  readonly [K in keyof Q]: AnswerFor<Q[K]>;
};

/**
 * Generic System One request. When `Q` is provided, `questions` is typed
 * as `Q` (the caller's specific question map) rather than the loose
 * `Record<string, SystemOneQuestion>`. The response's `answers` will
 * then carry the same keys.
 *
 * The `model`, `state`, `images`, and `keep_alive` fields are inherited
 * from the generated base type unchanged.
 *
 * ## Image support
 *
 * The `images` field accepts up to N base64-encoded images shared by
 * all questions in the request. The dual cap (2026-10-16 upstream
 * clarification) applies to every request simultaneously: the text and
 * schema portion (images excluded) must stay within
 * {@link MAX_SYSTEM_ONE_REQUEST_BYTES} (64 KiB), and the whole payload
 * (JSON + images) within {@link MAX_SYSTEM_ONE_IMAGES_BYTES} (32 MiB).
 *
 * Use {@link estimateSystemOneRequestBytes} for a client-side pre-flight
 * check before sending a large multi-image batch — the runtime also
 * enforces both caps, but the early check avoids the round-trip when
 * the caller already knows the payload is too large.
 *
 * ## Context window
 *
 * Beyond the byte caps, upstream requires the complete input (state,
 * questions, and images) to fit the model's loaded context window, and
 * System One never truncates input — oversized prompts are rejected by
 * the server with HTTP 400 locally ("a rendered prompt that exceeds the
 * loaded context"), not 413 (which is reserved for the byte caps
 * above); for cloud requests, upstream documents 413 for input that
 * exceeds the model's context window (65,536 tokens) as well as for
 * requests over 13 MiB.
 * Decision models (Nimble, Tev) additionally reserve two token
 * positions at the end of the window for scoring. The SDK deliberately
 * does not estimate this client-side (upstream documents no
 * tokenization formula); callers who need the real limit can use
 * `client.models.getContextLength()`.
 *
 * Requires Clef or Clef Flash with vision weights. URLs and data URLs
 * are NOT supported — pre-encode the bytes to base64 before adding to
 * the array.
 */
export interface SystemOneRequest<Q extends SystemOneQuestions = SystemOneQuestions> extends Omit<
  SystemOneRequestBase,
  'questions'
> {
  readonly questions: Q;
}

/**
 * Generic System One response. When `Q` is provided, `answers` is typed
 * as `SystemOneAnswers<Q>` — a key-safe map matching the questions the
 * caller asked.
 */
export interface SystemOneResponse<Q extends SystemOneQuestions = SystemOneQuestions> extends Omit<
  SystemOneResponseBase,
  'answers' | 'usage'
> {
  readonly answers: SystemOneAnswers<Q>;
  readonly usage: SystemOneUsage;
}

/**
 * Estimate the on-the-wire byte size of a System One request body, for
 * pre-flight validation against the dual cap (2026-10-16 upstream
 * clarification): the whole body against
 * {@link MAX_SYSTEM_ONE_IMAGES_BYTES} (32 MiB) and, when `images` is
 * attached, the images-excluded portion against
 * {@link MAX_SYSTEM_ONE_REQUEST_BYTES} (64 KiB) — pass
 * `{ excludeImages: true }` to measure the text-and-schema portion.
 *
 * The estimate is conservative: it uses `JSON.stringify` length and
 * assumes UTF-8 encoding. The actual wire size may differ slightly due
 * to server-side JSON normalization (key ordering, whitespace), but the
 * estimate is always within a few percent of the real payload size and
 * is suitable for "fail fast before sending" checks.
 *
 * @example
 *   ```ts
 *   const request: SystemOneRequest = { ... };
 *   const bytes = estimateSystemOneRequestBytes(request);
 *   const textBytes = request.images?.length
 *     ? estimateSystemOneRequestBytes(request, { excludeImages: true })
 *     : bytes;
 *   if (textBytes > MAX_SYSTEM_ONE_REQUEST_BYTES || bytes > MAX_SYSTEM_ONE_IMAGES_BYTES) {
 *     throw new Error(`payload ${bytes}B (text ${textBytes}B) exceeds the dual cap`);
 *   }
 *   await client.systemOne(request);
 *   ```
 */
export function estimateSystemOneRequestBytes(
  request: SystemOneRequest | SystemOneRequestBase,
  options?: { readonly excludeImages?: boolean },
): number {
  // JSON.stringify is a faithful proxy for what the runtime sends on
  // the wire — see src/transport/http.ts's request() method, which
  // calls JSON.stringify on the body before passing to fetch. UTF-8
  // multi-byte chars (the common case for non-ASCII base64) are counted
  // correctly because String.prototype.length already reflects UTF-16
  // code units; for pure-ASCII payloads (the typical case) the length
  // equals the byte length directly. We err on the side of over-counting
  // so the pre-flight check is conservative.
  //
  // 2026-10-16: excludeImages drops the `images` array before
  // serializing (undefined properties vanish in JSON.stringify) so the
  // caller can measure the text-and-schema half of the dual cap —
  // mirroring the runtime's serializeWithoutImages() guard.
  const body =
    options?.excludeImages && request.images !== undefined
      ? ({ ...request, images: undefined } as SystemOneRequest | SystemOneRequestBase)
      : request;
  return new TextEncoder().encode(JSON.stringify(body)).byteLength;
}
