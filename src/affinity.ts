/**
 * Model-affinity scheduling: keep the daemon's working set small.
 *
 * Ollama's concurrency model (per the official FAQ):
 *
 *   - A model's KV cache scales by `OLLAMA_NUM_PARALLEL × context_length` —
 *     parallel requests to the *same* loaded model are cheap (each gets its
 *     own slot of the already-allocated cache).
 *   - Requests for a *different* model queue until the first goes idle or is
 *     evicted (`OLLAMA_MAX_LOADED_MODELS`, default 3× GPU count) — a swap is
 *     an expensive unload/cold-load cycle: seconds of VRAM churn that a
 *     concurrent multi-model workload pays again and again when it
 *     interleaves models arbitrarily.
 *   - Once `OLLAMA_MAX_QUEUE` (default 512) requests are waiting, new ones
 *     are rejected outright with 503s.
 *
 * `ModelAffinityScheduler` is the client-side counterpart for workloads that
 * juggle several models — extraction on a coder model, reasoning on a
 * thinking model, embeddings for retrieval. It groups tasks into per-model
 * serial queues and caps how many *distinct* models have work in flight
 * (`concurrentModels`, default 1), preferring to deepen the currently-active
 * model over starting the next one — the anti-thrashing order. Candidate
 * lists let a task run on whichever of several interchangeable models is
 * already loaded (`GET /api/ps`, cached with a TTL).
 *
 * It is a user-space primitive, deliberately not wired into `OllamaClient`'s
 * request path: affinity decisions are workload policy, and the scheduler is
 * the foundation the multi-instance routing work builds on. See ADR 0026.
 */

import { OllamaClientError } from './errors.js';
import type { OllamaClient } from './client.js';

/**
 * The minimal client surface the scheduler needs. `OllamaClient` satisfies it
 * structurally; tests and custom setups can pass any compatible object.
 */
export interface ModelAffinityClient {
  readonly models: {
    ps(): Promise<{ readonly models: ReadonlyArray<{ readonly name: string }> }>;
  };
}

/** Options for {@link ModelAffinityScheduler}. */
export interface ModelAffinitySchedulerOptions {
  /**
   * Maximum number of *distinct* models with work in flight at once
   * (default `1`). `1` is the anti-thrashing setting: one model stays hot
   * until its queue drains, then the next loads. Raise it only when the
   * host has VRAM for several concurrent models
   * (`OLLAMA_MAX_LOADED_MODELS`).
   */
  readonly concurrentModels?: number | undefined;
  /**
   * Parallel tasks allowed per active model (default `1`). Raising this
   * mirrors the server's own `OLLAMA_NUM_PARALLEL` — same-model parallelism
   * reuses the loaded weights without swap cost.
   */
  readonly perModelConcurrency?: number | undefined;
  /**
   * How long a `GET /api/ps` result is reused when choosing among candidate
   * models (default `30_000` ms). Only multi-candidate `run()` calls and
   * `loadedModels()` consult the server; single-model tasks never do.
   */
  readonly psCacheTtlMs?: number | undefined;
}

/** Live scheduling state, from {@link ModelAffinityScheduler.stats}. */
export interface ModelAffinityStats {
  /** Models with at least one task currently executing. */
  readonly activeModels: readonly string[];
  /** Tasks waiting in queues (not yet started). */
  readonly queuedTasks: number;
}

interface TaskEntry {
  readonly task: (model: string) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

interface ModelQueue {
  readonly items: TaskEntry[];
  active: number;
}

const DEFAULT_CONCURRENT_MODELS = 1;
const DEFAULT_PER_MODEL_CONCURRENCY = 1;
const DEFAULT_PS_CACHE_TTL_MS = 30_000;

/**
 * Groups async work by model with load-aware dispatch.
 *
 * ```ts
 * const scheduler = new ModelAffinityScheduler(client);
 *
 * // Serial queue per model; one model hot at a time (default):
 * await scheduler.run('deepseek-r1', () => reason(client));
 * await scheduler.run('qwen2.5:coder', () => extract(client));
 *
 * // Either-or: picks whichever candidate is already loaded (/api/ps):
 * const summary = await scheduler.run(
 *   ['qwen2.5:coder', 'qwen2.5:14b'],
 *   (model) => extractWith(client, model),
 * );
 * ```
 *
 * Dispatch order is **affinity-sticky, not round-robin**: when a queued
 * model is already active, its tasks start before a different model's (up to
 * `perModelConcurrency`), because deepening the hot model avoids a swap.
 * Tasks run in FIFO order within each model's queue. Task functions are the
 * caller's own — the scheduler adds no retry, timeout, or failover, and a
 * rejected task simply rejects its `run()` promise while its siblings
 * proceed.
 */
export class ModelAffinityScheduler {
  private readonly queues = new Map<string, ModelQueue>();
  private readonly concurrentModels: number;
  private readonly perModelConcurrency: number;
  private readonly psCacheTtlMs: number;
  private psCache: { at: number; names: ReadonlySet<string> } | undefined;
  private readonly drainWaiters: Array<() => void> = [];

  constructor(
    private readonly client: ModelAffinityClient,
    options: ModelAffinitySchedulerOptions = {},
  ) {
    this.concurrentModels = options.concurrentModels ?? DEFAULT_CONCURRENT_MODELS;
    this.perModelConcurrency = options.perModelConcurrency ?? DEFAULT_PER_MODEL_CONCURRENCY;
    this.psCacheTtlMs = options.psCacheTtlMs ?? DEFAULT_PS_CACHE_TTL_MS;
    if (!Number.isInteger(this.concurrentModels) || this.concurrentModels < 1) {
      throw new OllamaClientError('concurrentModels must be an integer >= 1.', {
        code: 'invalid_request',
      });
    }
    if (!Number.isInteger(this.perModelConcurrency) || this.perModelConcurrency < 1) {
      throw new OllamaClientError('perModelConcurrency must be an integer >= 1.', {
        code: 'invalid_request',
      });
    }
    if (!Number.isFinite(this.psCacheTtlMs) || this.psCacheTtlMs < 0) {
      throw new OllamaClientError('psCacheTtlMs must be a non-negative number.', {
        code: 'invalid_request',
      });
    }
  }

  /**
   * Runs `task` on the scheduler, serialized per model. When `model` is a
   * list of candidates, the already-loaded one is preferred (fresh
   * `/api/ps` data subject to the TTL cache); with none loaded — or when the
   * lookup fails — the first candidate runs. The chosen model is handed to
   * the task.
   */
  async run<T>(model: string | readonly string[], task: (model: string) => Promise<T>): Promise<T> {
    const candidates = typeof model === 'string' ? [model] : [...model];
    if (
      candidates.length === 0 ||
      candidates.some((name) => typeof name !== 'string' || name === '')
    ) {
      throw new OllamaClientError('run() requires at least one non-empty model name.', {
        code: 'invalid_request',
      });
    }
    const chosen =
      candidates.length === 1 ? candidates[0]! : await this.chooseCandidate(candidates);
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(chosen) ?? { items: [], active: 0 };
      this.queues.set(chosen, queue);
      queue.items.push({
        task: task as (model: string) => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  /**
   * Names of the models currently loaded, per `GET /api/ps`, cached for
   * `psCacheTtlMs`. Degrades to an empty list when the server can't answer
   * (never throws; candidate selection treats it as "nothing loaded").
   */
  async loadedModels(): Promise<readonly string[]> {
    const names = await this.refreshPsNames();
    return [...names];
  }

  /** Current scheduling state — active models and queued task count. */
  get stats(): ModelAffinityStats {
    const activeModels: string[] = [];
    let queuedTasks = 0;
    for (const [name, queue] of this.queues) {
      if (queue.active > 0) activeModels.push(name);
      queuedTasks += queue.items.length;
    }
    return { activeModels, queuedTasks };
  }

  /**
   * Resolves once every queue is empty and no task is running. Does not
   * abort anything — tasks are caller-owned; abort them via their own
   * signals before disposing if needed.
   */
  async dispose(): Promise<void> {
    if (this.stats.queuedTasks === 0 && this.stats.activeModels.length === 0) return;
    await new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  private async chooseCandidate(candidates: readonly string[]): Promise<string> {
    const loaded = await this.refreshPsNames();
    for (const candidate of candidates) {
      if (loaded.has(candidate)) return candidate;
    }
    return candidates[0]!;
  }

  private async refreshPsNames(): Promise<ReadonlySet<string>> {
    const now = Date.now();
    if (this.psCache !== undefined && now - this.psCache.at <= this.psCacheTtlMs) {
      return this.psCache.names;
    }
    let names: ReadonlySet<string>;
    try {
      const ps = await this.client.models.ps();
      names = new Set(ps.models.map((entry) => entry.name));
    } catch {
      // Unreachable server, compat-only endpoint, auth hiccup — affinity
      // routing is best-effort. Degrade to "nothing loaded" without caching
      // the failure, so the next call retries.
      return new Set();
    }
    this.psCache = { at: now, names };
    return names;
  }

  private pump(): void {
    // Map iteration order = queue creation order, so dispatch is stable and
    // FIFO across models. An already-active model is allowed to deepen (up
    // to perModelConcurrency) even at the concurrentModels cap — that IS the
    // affinity: keep the hot model hot. The distinct-active count is
    // recomputed per check because tasks started earlier in this same pass
    // (or by concurrent completions) must count.
    for (const [name, queue] of this.queues) {
      while (queue.items.length > 0 && queue.active < this.perModelConcurrency) {
        if (queue.active === 0 && this.activeModelCount() >= this.concurrentModels) {
          break; // starting this model would exceed the distinct-models cap
        }
        const entry = queue.items.shift()!;
        queue.active += 1;
        this.execute(name, queue, entry);
      }
    }
  }

  private activeModelCount(): number {
    let count = 0;
    for (const queue of this.queues.values()) {
      if (queue.active > 0) count += 1;
    }
    return count;
  }

  private execute(name: string, queue: ModelQueue, entry: TaskEntry): void {
    void (async () => {
      try {
        entry.resolve(await entry.task(name));
      } catch (err) {
        entry.reject(err);
      } finally {
        queue.active -= 1;
        if (queue.items.length === 0 && queue.active === 0) {
          this.queues.delete(name);
        }
        if (this.stats.queuedTasks === 0 && this.stats.activeModels.length === 0) {
          const waiters = [...this.drainWaiters];
          this.drainWaiters.length = 0;
          for (const resolve of waiters) resolve();
        }
        this.pump();
      }
    })();
  }
}

/** Convenience factory — `createModelAffinityScheduler(client, opts)` reads better in setups. */
export function createModelAffinityScheduler(
  client: ModelAffinityClient | OllamaClient,
  options?: ModelAffinitySchedulerOptions,
): ModelAffinityScheduler {
  return new ModelAffinityScheduler(client as ModelAffinityClient, options);
}
