/**
 * Ergonomic System One types — key-safe generics on top of the generated
 * contract models.
 *
 * The generated `SystemOneRequest` and `SystemOneResponse` (in
 * `src/generated/models/`) use `Record<string, SystemOneQuestion>` for
 * the questions/answers maps. That's structurally correct but loses the
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

export type {
  SystemOneContent,
  SystemOneRequest as SystemOneRequestBase,
  SystemOneResponse as SystemOneResponseBase,
  SystemOneQuestion,
  SystemOneChoiceQuestion,
  SystemOneNoulQuestion,
  SystemOneScoreQuestion,
  SystemOneAnswer,
  SystemOneChoiceAnswer,
  SystemOneNoulAnswer,
  SystemOneScoreAnswer,
  SystemOneProbabilities,
  SystemOneConfidence,
  SystemOneUsage,
} from './generated/models/index.js';

import type {
  SystemOneQuestion,
  SystemOneAnswer,
  SystemOneRequest as SystemOneRequestBase,
  SystemOneResponse as SystemOneResponseBase,
} from './generated/models/index.js';

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
  extends Omit<SystemOneResponseBase, 'answers'> {
  readonly answers: SystemOneAnswers<Q>;
}
