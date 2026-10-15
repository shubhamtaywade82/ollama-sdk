/**
 * Higher-level System One decision helpers.
 *
 * Wave 14B: These helpers wrap the low-level `OllamaClient.systemOne()`
 * with ergonomic APIs for the six most common decision patterns. Each
 * helper constructs a single-question request, sends it, and extracts
 * the typed answer — so callers don't have to deal with the question
 * map / answer map indirection for single-decision calls.
 *
 * The helpers return typed results (not generic SystemOneAnswer) so
 * callers can branch on the discriminated union without manual
 * type narrowing.
 *
 * For multi-question calls (e.g. routing + urgency + difficulty in
 * one request), use `OllamaClient.systemOne()` directly with the
 * generic key-safe wrapper.
 */

import type { OllamaClient } from './client.js';
import type {
  SystemOneChoiceAnswer,
  SystemOneNoulAnswer,
  SystemOneScoreAnswer,
  SystemOneContent,
} from './system-one.js';

/**
 * Validate an optional confidence/probability threshold shared by the decision
 * helpers. Thresholds are inclusive lower bounds in (0, 1] — `0` would gate
 * nothing and values above `1` can never pass.
 *
 * @throws {RangeError} When the threshold is outside (0, 1].
 */
function validateThreshold(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new RangeError(`${name} must be a number in (0, 1] — got ${String(value)}`);
  }
}

/**
 * Result of a choice decision: the selected option key + probability
 * distribution + confidence.
 */
export interface ChoiceDecision {
  /** The selected option key (highest probability). */
  readonly choice: string;
  /** Probability distribution over all options. */
  readonly probabilities: Record<string, number>;
  /** Distribution concentration (0–1). NOT a guarantee of correctness. */
  readonly confidence: number;
  /**
   * Present only when `minConfidence` was configured: `true` when
   * `confidence >= minConfidence`. Autonomous flows should treat `false` as
   * "do not act on this decision" — the official System One docs warn that a
   * high confidence does not guarantee correctness, and a barely-majority
   * choice (e.g. 0.51) is rarely safe to act on unattended.
   */
  readonly isConfident?: boolean;
  /** Token usage for the call. */
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

/**
 * Result of a noul (yes/no) decision: the probability of true + a
 * boolean derived from it (>= 0.5 → true).
 */
export interface NoulDecision {
  /** Probability of true (0–1). */
  readonly noul: number;
  /**
   * Boolean decision: `true` if `noul >= minProbability` (default 0.5).
   * Raise the bar for safety gates with `minProbability` — e.g. 0.8 for
   * irreversible actions.
   */
  readonly bool: boolean;
  /** Token usage for the call. */
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

/**
 * Result of a score decision: the probability-weighted average score,
 * the legend (index → description), the probability distribution, and
 * confidence.
 */
export interface ScoreDecision {
  /** Probability-weighted average of zero-based criterion indices (0 to N-1). */
  readonly score: number;
  /** Zero-based indices as string keys → criterion descriptions. */
  readonly legend: Record<string, string>;
  /** Probabilities keyed by zero-based criterion indices as strings. */
  readonly probabilities: Record<string, number>;
  /** Distribution concentration (0–1). NOT a guarantee of correctness. */
  readonly confidence: number;
  /** Present only when `minConfidence` was configured: `confidence >= minConfidence`. */
  readonly isConfident?: boolean;
  /** Token usage for the call. */
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

/**
 * Result of a ranking call: candidates sorted by score (highest first),
 * each with its score and probability distribution.
 */
export interface RankResult<T extends string> {
  readonly candidate: T;
  readonly score: number;
  readonly confidence: number;
  /** Present only when `minConfidence` was configured: `confidence >= minConfidence`. */
  readonly isConfident?: boolean;
}

/**
 * Higher-level System One decision helpers.
 *
 * Create via `createDecision(client)` or access via `client.decision`
 * (if the accessor is wired). Each helper constructs a single-question
 * System One request and extracts the typed answer.
 *
 * Example:
 * ```ts
 * const decision = createDecision(client);
 * const result = await decision.choice({
 *   model: 'tev1:4b',
 *   state: 'Customer was charged twice',
 *   instructions: 'What is the primary intent?',
 *   criteria: {
 *     refund: 'Customer wants a refund',
 *     duplicate_charge: 'Customer reports multiple charges',
 *     cancellation: 'Customer wants to cancel',
 *   },
 * });
 * console.log(result.choice); // 'duplicate_charge'
 * console.log(result.confidence); // 0.89
 * ```
 */
export interface Decision {
  /**
   * Ask a single choice question. Returns the selected option + full
   * probability distribution + confidence.
   *
   * Use for: routing, classification, model selection, tool selection,
   * category assignment — any "which one?" decision with bounded options.
   */
  choice(params: {
    model: string;
    state: SystemOneContent;
    instructions: SystemOneContent;
    criteria: Record<string, string | null>;
    images?: string[];
    keepAlive?: string | number;
    /**
     * Opt-in confidence gate in (0, 1]. When set, the result carries
     * `isConfident: confidence >= minConfidence` so autonomous flows can
     * refuse to act on barely-majority decisions. Off by default.
     */
    minConfidence?: number;
  }): Promise<ChoiceDecision>;

  /**
   * Ask a single yes/no (noul) question. Returns the probability of
   * true (0–1) + a boolean derived from it (>= 0.5 → true).
   *
   * Use for: gating, verification, safety checks, eligibility, prompt-
   * injection detection — any "is this true?" decision.
   */
  noul(params: {
    model: string;
    state: SystemOneContent;
    instructions: SystemOneContent;
    images?: string[];
    keepAlive?: string | number;
    /**
     * Inclusive lower bound in (0, 1] the probability of `true` must meet
     * for `bool` to be `true`. Default 0.5 (a coin-flip majority). Raise it
     * (e.g. 0.8) for safety gates and irreversible actions.
     */
    minProbability?: number;
  }): Promise<NoulDecision>;

  /**
   * Ask a single score question. Returns the probability-weighted
   * average score + legend + probability distribution + confidence.
   *
   * Use for: severity, priority, difficulty, relevance, quality — any
   * "how strongly does this fit this ordered rubric?" decision.
   */
  score(params: {
    model: string;
    state: SystemOneContent;
    instructions: SystemOneContent;
    /** Ordered criteria from lowest (index 0) to highest. 2–10 items. */
    criteria: string[];
    images?: string[];
    keepAlive?: string | number;
    /** Opt-in confidence gate in (0, 1] — see {@link Decision.choice}. */
    minConfidence?: number;
  }): Promise<ScoreDecision>;

  /**
   * Route a request to one of N named options. Convenience wrapper
   * around `choice()` that returns just the selected route name.
   *
   * Use for: workflow routing, model routing, agent dispatch, tool
   * selection — any "which handler?" decision.
   */
  route<T extends string>(params: {
    model: string;
    state: SystemOneContent;
    instructions: SystemOneContent;
    criteria: Record<T, string | null>;
    images?: string[];
    keepAlive?: string | number;
    /** Opt-in confidence gate in (0, 1] — see {@link Decision.choice}. */
    minConfidence?: number;
  }): Promise<{ readonly route: T; readonly confidence: number; readonly isConfident?: boolean }>;

  /**
   * Verify whether a claim is supported by evidence. Convenience
   * wrapper around `noul()` that returns a boolean + the probability
   * of true (not System One's confidence score — noul answers don't
   * carry a separate confidence field).
   *
   * Use for: evidence verification, safety gates, prompt-injection
   * detection, compliance checks — any "is this claim true given
   * this evidence?" decision.
   */
  verify(params: {
    model: string;
    claim: SystemOneContent;
    evidence: SystemOneContent;
    instructions?: SystemOneContent;
    images?: string[];
    keepAlive?: string | number;
    /**
     * Inclusive lower bound in (0, 1] the probability of `true` must meet
     * for `verified`. Default 0.5. See {@link Decision.noul}.
     */
    minProbability?: number;
  }): Promise<{ readonly verified: boolean; readonly probability: number }>;

  /**
   * Rank candidates by score. Sends one System One call per candidate
   * (parallelized), then sorts by score descending.
   *
   * Use for: semantic reranking, candidate ranking, priority scoring,
   * relevance scoring — any "which of these is best?" decision where
   * each candidate is scored independently against the same rubric.
   *
   * Note: this makes N parallel requests (one per candidate). For
   * large candidate sets, consider batching or using a single choice
   * question with all candidates as options instead.
   */
  rank<T extends string>(params: {
    model: string;
    instructions: SystemOneContent;
    /** Ordered criteria from lowest (index 0) to highest. 2–10 items. */
    criteria: string[];
    candidates: ReadonlyArray<{ readonly id: T; readonly state: SystemOneContent }>;
    images?: string[];
    keepAlive?: string | number;
    /** Opt-in confidence gate in (0, 1] — flags each result with `isConfident`. */
    minConfidence?: number;
  }): Promise<ReadonlyArray<RankResult<T>>>;
}

/** Create a Decision helper bound to an OllamaClient. */
export function createDecision(client: OllamaClient): Decision {
  return {
    async choice(params) {
      validateThreshold(params.minConfidence, 'minConfidence');
      const response = await client.systemOne({
        model: params.model,
        state: params.state,
        ...(params.images ? { images: params.images } : {}),
        questions: {
          decision: {
            type: 'choice',
            instructions: params.instructions,
            criteria: params.criteria,
          },
        },
        ...(params.keepAlive !== undefined ? { keep_alive: params.keepAlive } : {}),
      });
      const answer = response.answers.decision as SystemOneChoiceAnswer;
      return {
        choice: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
        ...(params.minConfidence !== undefined
          ? { isConfident: answer.confidence >= params.minConfidence }
          : {}),
        usage: response.usage,
      };
    },

    async noul(params) {
      validateThreshold(params.minProbability, 'minProbability');
      const response = await client.systemOne({
        model: params.model,
        state: params.state,
        ...(params.images ? { images: params.images } : {}),
        questions: {
          decision: {
            type: 'noul',
            instructions: params.instructions,
          },
        },
        ...(params.keepAlive !== undefined ? { keep_alive: params.keepAlive } : {}),
      });
      const answer = response.answers.decision as SystemOneNoulAnswer;
      return {
        noul: answer.noul,
        bool: answer.noul >= (params.minProbability ?? 0.5),
        usage: response.usage,
      };
    },

    async score(params) {
      validateThreshold(params.minConfidence, 'minConfidence');
      const response = await client.systemOne({
        model: params.model,
        state: params.state,
        ...(params.images ? { images: params.images } : {}),
        questions: {
          decision: {
            type: 'score',
            instructions: params.instructions,
            criteria: params.criteria,
          },
        },
        ...(params.keepAlive !== undefined ? { keep_alive: params.keepAlive } : {}),
      });
      const answer = response.answers.decision as SystemOneScoreAnswer;
      return {
        score: answer.score,
        legend: answer.legend,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
        ...(params.minConfidence !== undefined
          ? { isConfident: answer.confidence >= params.minConfidence }
          : {}),
        usage: response.usage,
      };
    },

    async route(params) {
      validateThreshold(params.minConfidence, 'minConfidence');
      const response = await client.systemOne({
        model: params.model,
        state: params.state,
        ...(params.images ? { images: params.images } : {}),
        questions: {
          decision: {
            type: 'choice',
            instructions: params.instructions,
            criteria: params.criteria,
          },
        },
        ...(params.keepAlive !== undefined ? { keep_alive: params.keepAlive } : {}),
      });
      const answer = response.answers.decision as SystemOneChoiceAnswer;
      // `answer.choice` is one of the criteria keys (T extends string).
      // TypeScript can't prove this relationship because createDecision()
      // is not generic — the generic <T> lives on the Decision interface's
      // route() method, not on the factory. The cast is safe because the
      // caller's criteria keys define T, and the server's response choice
      // is guaranteed by the contract to be one of those keys.
      return {
        route: answer.choice as never,
        confidence: answer.confidence,
        ...(params.minConfidence !== undefined
          ? { isConfident: answer.confidence >= params.minConfidence }
          : {}),
      };
    },

    async verify(params) {
      validateThreshold(params.minProbability, 'minProbability');
      const state: SystemOneContent = {
        claim: params.claim,
        evidence: params.evidence,
      };
      const response = await client.systemOne({
        model: params.model,
        state,
        ...(params.images ? { images: params.images } : {}),
        questions: {
          decision: {
            type: 'noul',
            instructions: params.instructions ?? 'Is the claim supported by the evidence?',
          },
        },
        ...(params.keepAlive !== undefined ? { keep_alive: params.keepAlive } : {}),
      });
      const answer = response.answers.decision as SystemOneNoulAnswer;
      return {
        verified: answer.noul >= (params.minProbability ?? 0.5),
        probability: answer.noul,
      };
    },

    async rank(params) {
      validateThreshold(params.minConfidence, 'minConfidence');
      const promises = params.candidates.map(async (candidate) => {
        const response = await client.systemOne({
          model: params.model,
          state: candidate.state,
          ...(params.images ? { images: params.images } : {}),
          questions: {
            decision: {
              type: 'score',
              instructions: params.instructions,
              criteria: params.criteria,
            },
          },
          ...(params.keepAlive !== undefined ? { keep_alive: params.keepAlive } : {}),
        });
        const answer = response.answers.decision as SystemOneScoreAnswer;
        return {
          candidate: candidate.id,
          score: answer.score,
          confidence: answer.confidence,
          ...(params.minConfidence !== undefined
            ? { isConfident: answer.confidence >= params.minConfidence }
            : {}),
        };
      });
      const results = await Promise.all(promises);
      // Sort by score descending (highest first). Cast through unknown to
      // RankResult<T>[] — same pattern as route(): the generic <T> lives
      // on the Decision interface, not on the factory. The candidate IDs
      // come from the caller's typed array, so the runtime shape is
      // RankResult<T>[], but TypeScript can't prove it through the
      // non-generic createDecision factory.
      return results.sort((a, b) => b.score - a.score) as unknown as ReadonlyArray<
        RankResult<never>
      >;
    },
  };
}
