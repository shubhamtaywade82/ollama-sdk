import { describe, expect, it } from 'vitest';
import { createOllamaCloudFreeTierQuota, QuotaManager } from '../src/quota.js';
import { OllamaQuotaExceededError } from '../src/errors.js';

describe('QuotaManager', () => {
  it('tracks token and request usage across recordUsage calls', () => {
    const quota = new QuotaManager({
      windows: [{ id: 'session', windowMs: 60_000, maxTokens: 1000, maxRequests: 5 }],
    });

    quota.recordUsage({ prompt_eval_count: 100, eval_count: 50 });
    quota.recordUsage({ totalTokens: 200, promptTokens: 150, completionTokens: 50 });

    const [status] = quota.status();
    expect(status?.tokensUsed).toBe(350);
    expect(status?.requestsMade).toBe(2);
    expect(status?.remainingTokens).toBe(650);
    expect(status?.remainingRequests).toBe(3);
  });

  it('canProceed returns false once the token budget would be exceeded', () => {
    const quota = new QuotaManager({
      windows: [{ id: 'session', windowMs: 60_000, maxTokens: 100 }],
    });

    expect(quota.canProceed(90)).toBe(true);
    quota.recordUsage({ prompt_eval_count: 60, eval_count: 30 });
    expect(quota.canProceed(20)).toBe(false);
    expect(quota.canProceed(10)).toBe(true);
  });

  it('canProceed returns false once the request budget is exhausted', () => {
    const quota = new QuotaManager({
      windows: [{ id: 'session', windowMs: 60_000, maxRequests: 2 }],
    });

    quota.recordUsage({ prompt_eval_count: 1, eval_count: 1 });
    quota.recordUsage({ prompt_eval_count: 1, eval_count: 1 });
    expect(quota.canProceed()).toBe(false);
  });

  it('assertCanProceed throws OllamaQuotaExceededError identifying the offending window', () => {
    const quota = new QuotaManager({
      windows: [{ id: 'session', windowMs: 60_000, maxTokens: 100 }],
    });
    quota.recordUsage({ prompt_eval_count: 80, eval_count: 20 });

    expect(() => quota.assertCanProceed(50)).toThrow(OllamaQuotaExceededError);
    try {
      quota.assertCanProceed(50);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaQuotaExceededError);
      const error = err as OllamaQuotaExceededError;
      expect(error.windowId).toBe('session');
      expect(error.code).toBe('quota_exceeded');
      expect(error.retryable).toBe(false);
    }
  });

  it('rolls a window over to zero usage once its duration elapses', () => {
    let now = 0;
    const quota = new QuotaManager({
      windows: [{ id: 'session', windowMs: 1000, maxTokens: 100 }],
      now: () => now,
    });

    quota.recordUsage({ prompt_eval_count: 60, eval_count: 30 });
    expect(quota.canProceed(20)).toBe(false);

    now = 1001;
    expect(quota.canProceed(20)).toBe(true);
    const [status] = quota.status();
    expect(status?.tokensUsed).toBe(0);
    expect(status?.requestsMade).toBe(0);
  });

  it('enforces every configured window independently', () => {
    const quota = new QuotaManager({
      windows: [
        { id: 'session', windowMs: 60_000, maxTokens: 1000 },
        { id: 'weekly', windowMs: 604_800_000, maxTokens: 150 },
      ],
    });

    quota.recordUsage({ prompt_eval_count: 100, eval_count: 40 });
    expect(quota.canProceed(0)).toBe(true);
    expect(quota.canProceed(20)).toBe(false); // would exceed the weekly window only

    const statuses = quota.status();
    expect(statuses.map((s) => s.id)).toEqual(['session', 'weekly']);
  });

  it('reset(windowId) zeroes only the named window', () => {
    const quota = new QuotaManager({
      windows: [
        { id: 'session', windowMs: 60_000, maxTokens: 100 },
        { id: 'weekly', windowMs: 604_800_000, maxTokens: 100 },
      ],
    });
    quota.recordUsage({ prompt_eval_count: 50, eval_count: 20 });

    quota.reset('session');
    const statuses = quota.status();
    expect(statuses.find((s) => s.id === 'session')?.tokensUsed).toBe(0);
    expect(statuses.find((s) => s.id === 'weekly')?.tokensUsed).toBe(70);
  });

  it('reset() with no argument zeroes all windows', () => {
    const quota = new QuotaManager({
      windows: [
        { id: 'session', windowMs: 60_000, maxTokens: 100 },
        { id: 'weekly', windowMs: 604_800_000, maxTokens: 100 },
      ],
    });
    quota.recordUsage({ prompt_eval_count: 50, eval_count: 20 });

    quota.reset();
    for (const status of quota.status()) {
      expect(status.tokensUsed).toBe(0);
      expect(status.requestsMade).toBe(0);
    }
  });

  it('throws synchronously when constructed with no windows', () => {
    expect(() => new QuotaManager({ windows: [] })).toThrow();
  });
});

describe('createOllamaCloudFreeTierQuota', () => {
  it('wires up a 5-hour session window and a 7-day weekly window', () => {
    const quota = createOllamaCloudFreeTierQuota({
      session: { maxTokens: 50_000 },
      weekly: { maxTokens: 200_000 },
    });

    const statuses = quota.status();
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({ id: 'session', windowMs: 5 * 60 * 60 * 1000 });
    expect(statuses[1]).toMatchObject({ id: 'weekly', windowMs: 7 * 24 * 60 * 60 * 1000 });
  });

  it('supports configuring only one of the two windows', () => {
    const quota = createOllamaCloudFreeTierQuota({ session: { maxRequests: 10 } });
    expect(quota.status()).toHaveLength(1);
    expect(quota.status()[0]?.id).toBe('session');
  });

  it('throws when neither session nor weekly budgets are provided', () => {
    expect(() => createOllamaCloudFreeTierQuota({})).toThrow();
  });
});
