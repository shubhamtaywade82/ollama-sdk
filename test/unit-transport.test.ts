import { describe, expect, it, vi } from 'vitest';
import { calculateBackoff } from '../src/transport/backoff.js';
import { withRetry } from '../src/transport/retry.js';
import { createTimeoutSignal } from '../src/transport/timeout.js';
import { HttpClient } from '../src/transport/http.js';
import { OllamaAuthError, OllamaNotFoundError, OllamaServerError } from '../src/errors.js';

describe('Unit: Transport & Resilience', () => {
  describe('calculateBackoff', () => {
    it('applies exponential scaling with jitter within configured bounds', () => {
      const config = { maxRetries: 3, initialDelayMs: 100, maxDelayMs: 1000, backoffFactor: 2 };
      const delay0 = calculateBackoff(0, config);
      const delay1 = calculateBackoff(1, config);

      expect(delay0).toBeGreaterThanOrEqual(0);
      expect(delay0).toBeLessThanOrEqual(100);
      expect(delay1).toBeGreaterThanOrEqual(0);
      expect(delay1).toBeLessThanOrEqual(200);
    });

    it('clamps to maxDelayMs when computed delay exceeds bound', () => {
      const config = { maxRetries: 5, initialDelayMs: 500, maxDelayMs: 800, backoffFactor: 3 };
      const delay = calculateBackoff(4, config);
      expect(delay).toBeLessThanOrEqual(800);
      expect(delay).toBeGreaterThanOrEqual(0);
    });
  });

  describe('withRetry', () => {
    it('succeeds on first attempt without retrying', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const res = await withRetry(fn, {
        maxRetries: 2,
        initialDelayMs: 1,
        maxDelayMs: 10,
        backoffFactor: 2,
      });
      expect(res).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on retryable server errors and eventually succeeds', async () => {
      let attempts = 0;
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3) throw new OllamaServerError('Busy', 503);
        return 'success';
      });

      const res = await withRetry(fn, {
        maxRetries: 3,
        initialDelayMs: 1,
        maxDelayMs: 10,
        backoffFactor: 1,
      });
      expect(res).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('cancels an in-progress retry backoff via AbortSignal', async () => {
      const controller = new AbortController();
      const fn = vi.fn().mockRejectedValue(new OllamaServerError('Busy', { status: 503 }));
      const retryPromise = withRetry(
        fn,
        { maxRetries: 3, initialDelayMs: 10_000, maxDelayMs: 10_000, backoffFactor: 1 },
        controller.signal,
      );

      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();

      await expect(retryPromise).rejects.toMatchObject({ code: 'aborted' });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('aborts retries immediately on non-retryable errors', async () => {
      const fn = vi.fn().mockRejectedValue(new OllamaAuthError('Bad token'));
      await expect(
        withRetry(fn, { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 10, backoffFactor: 1 }),
      ).rejects.toThrow(OllamaAuthError);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('createTimeoutSignal', () => {
    it('cancels timeout timer cleanly on completion', () => {
      const timeout = createTimeoutSignal(5000);
      expect(timeout.signal.aborted).toBe(false);
      timeout.cancel();
    });

    it('forwards parent abort signal immediately', () => {
      const parentController = new AbortController();
      const timeout = createTimeoutSignal(5000, parentController.signal);
      parentController.abort();
      expect(timeout.signal.aborted).toBe(true);
      timeout.cancel();
    });
  });

  describe('HttpClient', () => {
    it('injects authorization header and custom headers into requests', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ok' }),
      });

      const http = new HttpClient({
        baseUrl: 'http://localhost:11434',
        apiKey: 'secret-key',
        headers: { 'X-Custom': 'ollama-ecosystem' },
        fetch: mockFetch as never,
      });

      await http.request({ path: '/api/version' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.headers['Authorization']).toBe('Bearer secret-key');
      expect(init.headers['X-Custom']).toBe('ollama-ecosystem');
    });

    it('maps 404 response to OllamaNotFoundError with parsed error body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: 'model "llama3" not found' }),
      });

      const http = new HttpClient({ baseUrl: 'http://localhost:11434', fetch: mockFetch as never });
      await expect(http.request({ path: '/api/show', body: { model: 'llama3' } })).rejects.toThrow(
        OllamaNotFoundError,
      );
    });
  });
});
