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
export type {
  SystemOneRequest as SystemOneRequestBase,
} from './generated/models/SystemOneRequest.js';
export type {
  SystemOneResponse as SystemOneResponseBase,
} from './generated/models/SystemOneResponse.js';
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
import type {
  SystemOneRequest as SystemOneRequestBase,
} from './generated/models/SystemOneRequest.js';
import type {
  SystemOneResponse as SystemOneResponseBase,
} from './generated/models/SystemOneResponse.js';

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
