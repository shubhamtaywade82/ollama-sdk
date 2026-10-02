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
export type {
  SystemOneContent,
  SystemOneRequest as SystemOneRequestBase,
  SystemOneResponse as SystemOneResponseBase,
  SystemOneChoiceQuestion,
  SystemOneNoulQuestion,
  SystemOneScoreQuestion,
  SystemOneChoiceAnswer,
  SystemOneNoulAnswer,
  SystemOneScoreAnswer,
  SystemOneProbabilities,
  SystemOneConfidence,
} from './generated/models/index.js';

import type {
  SystemOneChoiceQuestion,
  SystemOneNoulQuestion,
  SystemOneScoreQuestion,
  SystemOneChoiceAnswer,
  SystemOneNoulAnswer,
  SystemOneScoreAnswer,
  SystemOneRequest as SystemOneRequestBase,
  SystemOneResponse as SystemOneResponseBase,
} from './generated/models/index.js';

/**
 * Discriminated union of the three question kinds. The upstream OpenAPI
 * defines this inline as `oneOf` within SystemOneRequest.questions; we
 * reconstruct it as a named type for SDK ergonomics.
 */
export type SystemOneQuestion =
  | SystemOneChoiceQuestion
  | SystemOneNoulQuestion
  | SystemOneScoreQuestion;

/**
 * Discriminated union of the three answer kinds. The upstream OpenAPI
 * defines this inline as `oneOf` within SystemOneResponse.answers; we
 * reconstruct it as a named type for SDK ergonomics.
 */
export type SystemOneAnswer =
  | SystemOneChoiceAnswer
  | SystemOneNoulAnswer
  | SystemOneScoreAnswer;

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
 * Key-safe answers map: for every question key `K` in `Q`, the response
 * carries a `SystemOneAnswer`. This lets callers do
 * `result.answers.myQuestionId` with full type safety.
 */
export type SystemOneAnswers<Q extends SystemOneQuestions = SystemOneQuestions> = {
  readonly [K in keyof Q]: SystemOneAnswer;
};

/**
 * Generic System One request. When `Q` is provided, `questions` is typed
 * as `Q` (the caller's specific question map) rather than the loose
 * `Record<string, SystemOneQuestion>`. The response's `answers` will
 * then carry the same keys.
 *
 * The `model`, `state`, `images`, and `keep_alive` fields are inherited
 * from the generated base type unchanged.
 */
export interface SystemOneRequest<Q extends SystemOneQuestions = SystemOneQuestions>
  extends Omit<SystemOneRequestBase, 'questions'> {
  readonly questions: Q;
}

/**
 * Generic System One response. When `Q` is provided, `answers` is typed
 * as `SystemOneAnswers<Q>` — a key-safe map matching the questions the
 * caller asked.
 */
export interface SystemOneResponse<Q extends SystemOneQuestions = SystemOneQuestions>
  extends Omit<SystemOneResponseBase, 'answers' | 'usage'> {
  readonly answers: SystemOneAnswers<Q>;
  readonly usage: SystemOneUsage;
}
