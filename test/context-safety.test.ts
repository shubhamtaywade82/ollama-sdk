import { describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/client.js';
import type { Logger } from '../src/logger.js';
import {
  DEFAULT_CONTEXT_WARNING_THRESHOLD,
  OLLAMA_FALLBACK_CONTEXT_LENGTH,
  checkChatContext,
  contextWarningMessage,
  estimateChatRequestTokens,
  estimateGenerateRequestTokens,
  estimateTokens,
} from '../src/context-safety.js';

/**
 * Context-window safety (src/context-safety.ts): heuristic token estimation
 * and pre-flight overflow warnings against the effective num_ctx window.
 */

describe('estimateTokens', () => {
  it('scales English text at roughly 4 characters per token', () => {
    expect(estimateTokens('')).toBe(0);
    // 20 chars -> ~5 tokens
    expect(estimateTokens('abcdefghijklmnopqrst')).toBe(5);
  });

  it('counts CJK code points at roughly one token each', () => {
    // 6 CJK chars + 0 other -> ~6 tokens (far above the chars/4 estimate of 1.5)
    expect(estimateTokens('你好世界再见')).toBe(6);
  });

  it('blends CJK and Latin content', () => {
    const text = '你好 world'; // 2 CJK + 6 latin incl. space
    const cjk = 2;
    const other = text.length - cjk; // 6
    expect(estimateTokens(text)).toBe(Math.ceil(cjk + other / 4));
  });
});

describe('request-level estimators', () => {
  it('includes per-message overhead, tool_calls, and tool schemas for chat', () => {
    const estimate = estimateChatRequestTokens({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are terse.' },
        {
          role: 'assistant',
          content: 'calling',
          tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Pune' } } }],
        },
        { role: 'user', content: 'weather?', images: ['AAAA', 'BBBB'] },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the weather for a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    });
    // Images alone contribute 2 * IMAGE_TOKEN_ESTIMATE = 600.
    expect(estimate).toBeGreaterThan(600);
  });

  it('includes prompt + system + images for generate', () => {
    const estimate = estimateGenerateRequestTokens({
      model: 'm',
      prompt: 'hello world',
      system: 'be terse',
      images: [new Uint8Array(4)],
    });
    expect(estimate).toBeGreaterThan(300);
  });
});

describe('checkChatContext window sources', () => {
  const req = { model: 'm', messages: [{ role: 'user', content: 'x'.repeat(4000) }] };

  it("uses the request's explicit num_ctx with the threshold margin", () => {
    // ~2000 tokens vs 0.9 * 2048 = 1843 — exceeds.
    const exceeds = checkChatContext({
      model: 'm',
      messages: [{ role: 'user', content: 'x'.repeat(8000) }],
      options: { num_ctx: 2048 },
    });
    expect(exceeds.windowSource).toBe('request');
    expect(exceeds.effectiveContextLength).toBe(2048);
    expect(exceeds.exceedsThreshold).toBe(true);

    // ~1000 tokens — comfortably inside 0.9 * 2048.
    const within = checkChatContext({
      model: 'm',
      messages: [{ role: 'user', content: 'x'.repeat(4000) }],
      options: { num_ctx: 2048 },
    });
    expect(within.exceedsThreshold).toBe(false);
  });

  it('falls back to the client defaultContextLength when the request omits num_ctx', () => {
    const check = checkChatContext(req, { defaultContextLength: 4096 });
    expect(check.windowSource).toBe('client-default');
    expect(check.effectiveContextLength).toBe(4096);
    expect(check.exceedsThreshold).toBe(false); // ~1000 < 0.9 * 4096
  });

  it('warns against the conservative server default only when the estimate outright exceeds it', () => {
    const check = checkChatContext(req);
    expect(check.windowSource).toBe('server-fallback');
    expect(check.effectiveContextLength).toBe(OLLAMA_FALLBACK_CONTEXT_LENGTH);
    // ~1000 tokens — below the 2048 fallback, so no warning yet.
    expect(check.exceedsThreshold).toBe(false);

    const bigCheck = checkChatContext({
      model: 'm',
      messages: [{ role: 'user', content: 'x'.repeat(10_000) }],
    });
    expect(bigCheck.exceedsThreshold).toBe(true); // ~2500 > 2048
  });
});

describe('contextWarningMessage', () => {
  it('mentions num_ctx for request-sourced windows and defaultContextLength for client-sourced ones', () => {
    const requestMsg = contextWarningMessage(
      {
        estimatedPromptTokens: 1900,
        effectiveContextLength: 2048,
        windowSource: 'request',
        exceedsThreshold: true,
      },
      'chat',
    );
    expect(requestMsg).toContain('num_ctx=2048');
    expect(requestMsg).toContain('OllamaClient.chat()');

    const clientMsg = contextWarningMessage(
      {
        estimatedPromptTokens: 1900,
        effectiveContextLength: 2048,
        windowSource: 'client-default',
        exceedsThreshold: true,
      },
      'generate',
    );
    expect(clientMsg).toContain('defaultContextLength');
    expect(clientMsg).toContain('OllamaClient.generate()');

    const fallbackMsg = contextWarningMessage(
      {
        estimatedPromptTokens: 3000,
        effectiveContextLength: OLLAMA_FALLBACK_CONTEXT_LENGTH,
        windowSource: 'server-fallback',
        exceedsThreshold: true,
      },
      'chat',
    );
    expect(fallbackMsg).toContain('server-default');
  });
});

describe('OllamaClient pre-flight integration', () => {
  function capturingClient(config: ConstructorParameters<typeof OllamaClient>[0] = {}) {
    const bodies: Record<string, unknown>[] = [];
    const warnings: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    };
    const client = new OllamaClient({
      ...config,
      logger,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(
          init?.body !== undefined
            ? (JSON.parse(String(init.body)) as Record<string, unknown>)
            : {},
        );
        return new Response(
          JSON.stringify({
            model: 'm',
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content: 'ok' },
            done: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof globalThis.fetch,
    });
    return { client, bodies, warnings };
  }

  it('injects defaultContextLength as num_ctx when the request omits it', async () => {
    const { client, bodies } = capturingClient({ defaultContextLength: 8192 });
    await client.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      options: { temperature: 0.5 },
    });
    const body = bodies[0] as { options: { num_ctx: number; temperature: number } };
    expect(body.options).toEqual({ temperature: 0.5, num_ctx: 8192 });
  });

  it('never overrides an explicit request num_ctx', async () => {
    const { client, bodies } = capturingClient({ defaultContextLength: 8192 });
    await client.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      options: { num_ctx: 1024 },
    });
    const body = bodies[0] as { options: { num_ctx: number } };
    expect(body.options.num_ctx).toBe(1024);
  });

  it('logs a warning when the estimate approaches the effective window', async () => {
    const { client, warnings, bodies } = capturingClient({ defaultContextLength: 512 });
    await client.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'x'.repeat(4000) }], // ~1000 tokens > 0.9 * 512
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('defaultContextLength');
    // Warning is advisory — the request still goes out.
    expect(bodies).toHaveLength(1);
  });

  it("doesn't warn below the threshold", async () => {
    const { client, warnings } = capturingClient({ defaultContextLength: 4096 });
    await client.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'x'.repeat(400) }], // ~100 tokens
    });
    expect(warnings).toHaveLength(0);
  });

  it("throws client-side with onContextOverflow: 'throw'", async () => {
    const { client } = capturingClient({
      defaultContextLength: 512,
      onContextOverflow: 'throw',
    });
    await expect(
      client.chat({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(4000) }] }),
    ).rejects.toThrow(/defaultContextLength.*silently truncate|silently truncate/s);
  });

  it('generate() participates in the same policy', async () => {
    const { client, warnings, bodies } = capturingClient({ defaultContextLength: 256 });
    await client.generate({ model: 'm', prompt: 'y'.repeat(2000) }); // ~500 > 0.9*256
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('OllamaClient.generate()');
    const body = bodies[0] as { options: { num_ctx: number } };
    expect(body.options.num_ctx).toBe(256);
  });
});

describe('DEFAULT_CONTEXT_WARNING_THRESHOLD', () => {
  it('defaults to 0.9', () => {
    expect(DEFAULT_CONTEXT_WARNING_THRESHOLD).toBe(0.9);
  });
});

// Keep vi referenced for future spies in this file.
void vi;
