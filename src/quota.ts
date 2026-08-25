/**
 * Client-side usage budgeting.
 *
 * Ollama Cloud does not expose account-level quota or remaining-budget through the API —
 * chat/generate responses carry only per-request token counts, and there is no header or
 * endpoint that reports how much of your plan's session or weekly limit is left (the only
 * way to see that today is the https://ollama.com dashboard or the 90%-usage email). See
 * https://github.com/ollama/ollama/issues/15663.
 *
 * `QuotaManager` does not — and cannot — read Ollama's real limits. It tracks usage you
 * record against budgets *you* configure over one or more rolling windows, and refuses to
 * proceed once a window's budget is spent. Pair it with `OllamaRateLimitError` (thrown by
 * `OllamaClient` on the server's actual 429) as the authoritative signal; treat
 * `QuotaManager` as a local safety net that fails fast before the request is even sent.
 */

import { OllamaQuotaExceededError } from './errors.js';
import { extractUsage, type RawUsageSource, type TokenUsage } from './usage.js';

export interface QuotaWindowConfig {
  /** Identifies this window in status reports and thrown errors (e.g. "session", "weekly"). */
  readonly id: string;
  /** Length of the rolling window in milliseconds, after which usage resets to zero. */
  readonly windowMs: number;
  /** Token budget for the window. Omit to only track requests. */
  readonly maxTokens?: number;
  /** Request-count budget for the window. Omit to only track tokens. */
  readonly maxRequests?: number;
}

export interface QuotaWindowStatus extends QuotaWindowConfig {
  readonly tokensUsed: number;
  readonly requestsMade: number;
  readonly windowStartedAt: number;
  readonly windowResetAt: number;
  readonly remainingTokens?: number;
  readonly remainingRequests?: number;
}

export interface QuotaManagerOptions {
  readonly windows: readonly QuotaWindowConfig[];
  /** Clock override for testing. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface WindowState {
  readonly config: QuotaWindowConfig;
  tokensUsed: number;
  requestsMade: number;
  windowStartedAt: number;
}

export class QuotaManager {
  private readonly now: () => number;
  private readonly windows: readonly WindowState[];

  constructor(options: QuotaManagerOptions) {
    if (options.windows.length === 0) {
      throw new Error('QuotaManager requires at least one window configuration.');
    }
    this.now = options.now ?? Date.now;
    this.windows = options.windows.map((config) => ({
      config,
      tokensUsed: 0,
      requestsMade: 0,
      windowStartedAt: this.now(),
    }));
  }

  private rollover(state: WindowState): void {
    if (this.now() - state.windowStartedAt >= state.config.windowMs) {
      state.tokensUsed = 0;
      state.requestsMade = 0;
      state.windowStartedAt = this.now();
    }
  }

  /** Current usage, budgets, and reset time for every configured window. */
  status(): readonly QuotaWindowStatus[] {
    return this.windows.map((state) => {
      this.rollover(state);
      const { config } = state;
      return {
        ...config,
        tokensUsed: state.tokensUsed,
        requestsMade: state.requestsMade,
        windowStartedAt: state.windowStartedAt,
        windowResetAt: state.windowStartedAt + config.windowMs,
        ...(config.maxTokens !== undefined
          ? { remainingTokens: Math.max(0, config.maxTokens - state.tokensUsed) }
          : {}),
        ...(config.maxRequests !== undefined
          ? { remainingRequests: Math.max(0, config.maxRequests - state.requestsMade) }
          : {}),
      };
    });
  }

  /**
   * True if one more request — optionally estimated at `estimatedTokens` — would stay
   * within every configured window's budget. Read-only; does not record usage.
   */
  canProceed(estimatedTokens = 0): boolean {
    return this.windows.every((state) => {
      this.rollover(state);
      const { config } = state;
      if (config.maxRequests !== undefined && state.requestsMade + 1 > config.maxRequests) {
        return false;
      }
      return !(
        config.maxTokens !== undefined && state.tokensUsed + estimatedTokens > config.maxTokens
      );
    });
  }

  /**
   * Throws `OllamaQuotaExceededError` for the first window that `canProceed(estimatedTokens)`
   * would fail on; otherwise a no-op. Call before issuing a request.
   */
  assertCanProceed(estimatedTokens = 0): void {
    for (const state of this.windows) {
      this.rollover(state);
      const { config } = state;
      if (config.maxRequests !== undefined && state.requestsMade + 1 > config.maxRequests) {
        throw new OllamaQuotaExceededError(
          `Client-side quota window "${config.id}" would exceed its request budget ` +
            `(${state.requestsMade}/${config.maxRequests} requests used).`,
          { windowId: config.id, resetAt: state.windowStartedAt + config.windowMs },
        );
      }
      if (config.maxTokens !== undefined && state.tokensUsed + estimatedTokens > config.maxTokens) {
        throw new OllamaQuotaExceededError(
          `Client-side quota window "${config.id}" would exceed its token budget ` +
            `(${state.tokensUsed}/${config.maxTokens} tokens used).`,
          { windowId: config.id, resetAt: state.windowStartedAt + config.windowMs },
        );
      }
    }
  }

  /** Records one request's actual usage — a raw API response or a pre-normalized `TokenUsage` — against every window. */
  recordUsage(usage: RawUsageSource | TokenUsage): void {
    const normalized: TokenUsage = 'totalTokens' in usage ? usage : extractUsage(usage);
    for (const state of this.windows) {
      this.rollover(state);
      state.tokensUsed += normalized.totalTokens;
      state.requestsMade += 1;
    }
  }

  /** Resets one window (by `id`) or, if omitted, all windows — zeroing usage and restarting their clocks. */
  reset(windowId?: string): void {
    for (const state of this.windows) {
      if (windowId === undefined || state.config.id === windowId) {
        state.tokensUsed = 0;
        state.requestsMade = 0;
        state.windowStartedAt = this.now();
      }
    }
  }
}

export interface OllamaCloudFreeTierQuotaBudgets {
  /** Budget for the free tier's ~5-hour session window. Omit to skip tracking it. */
  readonly session?: { readonly maxTokens?: number; readonly maxRequests?: number };
  /** Budget for the free tier's 7-day weekly window. Omit to skip tracking it. */
  readonly weekly?: { readonly maxTokens?: number; readonly maxRequests?: number };
  readonly now?: () => number;
}

/**
 * Convenience factory mirroring Ollama Cloud free-tier's documented reset cadence — a
 * session window that resets every 5 hours and a weekly window that resets every 7 days
 * (see https://ollama.com/pricing). Ollama does not publish the actual token/request
 * ceilings for either window, so you must supply the budgets yourself (e.g. from your own
 * observed usage) — this only wires up the window durations.
 */
export function createOllamaCloudFreeTierQuota(
  budgets: OllamaCloudFreeTierQuotaBudgets,
): QuotaManager {
  const windows: QuotaWindowConfig[] = [];
  if (budgets.session !== undefined) {
    windows.push({ id: 'session', windowMs: 5 * 60 * 60 * 1000, ...budgets.session });
  }
  if (budgets.weekly !== undefined) {
    windows.push({ id: 'weekly', windowMs: 7 * 24 * 60 * 60 * 1000, ...budgets.weekly });
  }
  if (windows.length === 0) {
    throw new Error(
      'createOllamaCloudFreeTierQuota requires at least a `session` or `weekly` budget.',
    );
  }
  return new QuotaManager({ windows, ...(budgets.now !== undefined ? { now: budgets.now } : {}) });
}
