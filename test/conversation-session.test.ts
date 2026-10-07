import { describe, expect, it } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { ConversationSession } from '../src/conversation.js';

/**
 * KV-prefix-preserving conversation sessions (src/conversation.ts).
 */

interface TurnScript {
  readonly content: string;
  readonly prompt_eval_count?: number;
  readonly prompt_eval_cached_count?: number;
  readonly eval_count?: number;
  readonly thinking?: string;
}

/** Fetch mock replaying a scripted sequence of /api/chat responses. */
function scriptedFetch(script: readonly TurnScript[]) {
  const bodies: Record<string, unknown>[] = [];
  let index = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(
      init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    );
    const turn = script[Math.min(index, script.length - 1)];
    index += 1;
    return new Response(
      JSON.stringify({
        model: 'llama3.1',
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: turn?.content ?? 'ok',
          ...(turn?.thinking !== undefined ? { thinking: turn.thinking } : {}),
        },
        done: true,
        ...(turn?.prompt_eval_count !== undefined
          ? { prompt_eval_count: turn.prompt_eval_count }
          : {}),
        ...(turn?.prompt_eval_cached_count !== undefined
          ? { prompt_eval_cached_count: turn.prompt_eval_cached_count }
          : {}),
        ...(turn?.eval_count !== undefined ? { eval_count: turn.eval_count } : {}),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, bodies };
}

describe('ConversationSession', () => {
  it('pins the system prompt as the first history message and sends the full prefix every turn', async () => {
    const { fetchImpl, bodies } = scriptedFetch([
      { content: 'Hi!', prompt_eval_count: 100 },
      { content: 'Blue because...', prompt_eval_count: 5, prompt_eval_cached_count: 100 },
    ]);
    const client = new OllamaClient({ fetch: fetchImpl });
    const session = client.session('llama3.1', 'You are terse.');

    await session.send('hello');
    await session.send('why is the sky blue?');

    expect(bodies).toHaveLength(2);
    const turn1Messages = bodies[0]?.messages as { role: string; content: string }[];
    const turn2Messages = bodies[1]?.messages as { role: string; content: string }[];
    expect(turn1Messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hello' },
    ]);
    // Turn 2 must be a pure append on turn 1's prefix — the KV-cache contract.
    expect(turn2Messages.slice(0, 2)).toEqual(turn1Messages);
    expect(turn2Messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('send() returns the reply text; sendTurn() additionally exposes cache stats', async () => {
    const { fetchImpl } = scriptedFetch([
      { content: 'cold cache', prompt_eval_count: 100, prompt_eval_cached_count: 0, eval_count: 5 },
      { content: 'warm cache', prompt_eval_count: 0, prompt_eval_cached_count: 120, eval_count: 4 },
    ]);
    const client = new OllamaClient({ fetch: fetchImpl });
    const session = new ConversationSession(client, { model: 'llama3.1' });

    await expect(session.send('q1')).resolves.toBe('cold cache');

    const turn = await session.sendTurn('q2');
    expect(turn.content).toBe('warm cache');
    // Full cache hit: Ollama reports prompt_eval_count: 0 — the hit rate
    // must still be 1, not 0 (see TurnCacheStats.hitRate docs).
    expect(turn.cache).toEqual({
      cachedTokens: 120,
      evaluatedTokens: 0,
      hitRate: 1,
    });
    expect(turn.response.message.content).toBe('warm cache');
  });

  it('accumulates cumulative stats across turns', async () => {
    const { fetchImpl } = scriptedFetch([
      { content: 'a', prompt_eval_count: 100, prompt_eval_cached_count: 0 },
      { content: 'b', prompt_eval_count: 20, prompt_eval_cached_count: 100 },
      { content: 'c', prompt_eval_count: 0, prompt_eval_cached_count: 130 },
    ]);
    const client = new OllamaClient({ fetch: fetchImpl });
    const session = client.session('llama3.1');

    await session.send('1');
    await session.send('2');
    await session.send('3');

    expect(session.turnCount).toBe(3);
    expect(session.cacheStats).toEqual({
      turns: 3,
      cachedTokens: 230,
      evaluatedTokens: 120,
      totalPromptTokens: 350,
      hitRate: 230 / 350,
    });
  });

  it('freezes history messages and returns defensive copies from getMessages()', async () => {
    const { fetchImpl } = scriptedFetch([{ content: 'reply' }]);
    const client = new OllamaClient({ fetch: fetchImpl });
    const session = client.session('llama3.1', 'sys');
    await session.send('hello');

    const messages = session.getMessages();
    expect(Object.isFrozen(messages[0])).toBe(true);
    expect(Object.isFrozen(messages[1])).toBe(true);
    expect(Object.isFrozen(messages[2])).toBe(true);

    // Mutating the returned copy must not leak into the session.
    const copy = session.getMessages() as unknown as { role: string; content: string }[];
    copy.push({ role: 'user', content: 'injected' });
    expect(session.getMessages()).toHaveLength(3);
    expect(session.turnCount).toBe(1);
  });

  it('reset() restores the initial system prompt and zeroes the tallies', async () => {
    const { fetchImpl, bodies } = scriptedFetch([
      { content: 'one', prompt_eval_count: 50, prompt_eval_cached_count: 0 },
      { content: 'two', prompt_eval_count: 1, prompt_eval_cached_count: 60 },
    ]);
    const client = new OllamaClient({ fetch: fetchImpl });
    const session = client.session('llama3.1', 'persistent sys');
    await session.send('first');
    expect(session.cacheStats.turns).toBe(1);

    session.reset();
    expect(session.turnCount).toBe(0);
    expect(session.cacheStats.hitRate).toBe(0);
    expect(session.getMessages()).toEqual([{ role: 'system', content: 'persistent sys' }]);

    await session.send('after reset');
    const messages = bodies[1]?.messages as { role: string }[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('carries per-turn option overrides without disturbing the history prefix', async () => {
    const { fetchImpl, bodies } = scriptedFetch([{ content: 'ok' }]);
    const client = new OllamaClient({ fetch: fetchImpl });
    const session = new ConversationSession(client, {
      model: 'llama3.1',
      systemPrompt: 'sys',
      options: { temperature: 0.1 },
    });

    await session.send('hi', { options: { temperature: 0.9 }, think: true });

    const body = bodies[0] as { options: { temperature: number }; think: boolean };
    expect(body.options.temperature).toBe(0.9);
    expect(body.think).toBe(true);
    // History stays system+user only — overrides never leak into messages.
    expect(body.messages as unknown[]).toHaveLength(2);
  });
});
