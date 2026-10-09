import { describe, expect, it } from 'vitest';
import { OllamaClient } from '../src/client.js';
import { ConversationSession, compactConversationHistory } from '../src/conversation.js';
import { IMAGE_TOKEN_ESTIMATE, estimateMessageTokens } from '../src/context-safety.js';
import type { Message } from '../src/types.js';

/**
 * Sliding-window history compaction (src/conversation.ts): the pure
 * compactConversationHistory() helper and ConversationSession.compact().
 */

const SYSTEM: Message = { role: 'system', content: 'You are terse.' };
// 80 latin chars -> estimateMessageTokens = 4 + 20 = 24
const turn = (text: string): Message => ({ role: 'user', content: text });

describe('compactConversationHistory (pure)', () => {
  it('keeps the leading system message plus the newest turns that fit the budget', () => {
    const messages: Message[] = [
      SYSTEM,
      turn('a'.repeat(80)),
      turn('b'.repeat(80)),
      turn('c'.repeat(80)),
      turn('d'.repeat(80)),
    ];
    // Budget 60 after reserve: system (8) + 2 turns (48) = 56 fits; 3rd would be 80.
    const kept = compactConversationHistory(messages, { maxEstimatedTokens: 60 });
    expect(kept.map((m) => m.content[0])).toEqual(['Y', 'c', 'd']);
  });

  it('always retains the trailing minTailMessages even when they overflow the budget', () => {
    const messages: Message[] = [
      SYSTEM,
      turn('a'.repeat(80)),
      turn('b'.repeat(80)),
      turn('c'.repeat(80)),
    ];
    // Budget 0: nothing fits, but the last 2 exchanges are kept by default.
    const kept = compactConversationHistory(messages, { maxEstimatedTokens: 0 });
    expect(kept.map((m) => m.content[0])).toEqual(['Y', 'b', 'c']);
  });

  it('honors an explicit minTailMessages, including 0', () => {
    const messages: Message[] = [SYSTEM, turn('a'.repeat(80)), turn('b'.repeat(80))];
    expect(
      compactConversationHistory(messages, { maxEstimatedTokens: 8, minTailMessages: 0 }),
    ).toEqual([SYSTEM]);
    expect(
      compactConversationHistory(messages, { maxEstimatedTokens: 8, minTailMessages: 1 }),
    ).toEqual([SYSTEM, turn('b'.repeat(80))]);
  });

  it('subtracts reserveForReply from the budget', () => {
    const messages: Message[] = [SYSTEM, turn('a'.repeat(80)), turn('b'.repeat(80))];
    // Budget 60, reserve 24 -> effective 36: system(8) + newest(24) = 32 fits; the
    // older turn (56) doesn't. minTail 1 lets the reserve actually evict it.
    const kept = compactConversationHistory(messages, {
      maxEstimatedTokens: 60,
      reserveForReply: 24,
      minTailMessages: 1,
    });
    expect(kept).toEqual([SYSTEM, turn('b'.repeat(80))]);
    // Without the reservation the same budget keeps both turns (8+24+24 = 56 <= 60).
    expect(
      compactConversationHistory(messages, { maxEstimatedTokens: 60, minTailMessages: 1 }),
    ).toEqual(messages);
  });

  it('never mutates the input array and reuses message objects by reference', () => {
    const messages: Message[] = [SYSTEM, turn('a'.repeat(80)), turn('b'.repeat(80))];
    const snapshot = [...messages];
    const kept = compactConversationHistory(messages, {
      maxEstimatedTokens: 8,
      minTailMessages: 0,
    });
    expect(messages).toEqual(snapshot);
    expect(kept[0]).toBe(SYSTEM);
  });

  it('handles degenerate inputs: empty and system-only', () => {
    expect(compactConversationHistory([], { maxEstimatedTokens: 100 })).toEqual([]);
    expect(compactConversationHistory([SYSTEM], { maxEstimatedTokens: 100 })).toEqual([SYSTEM]);
  });

  it('uses the CJK-aware estimator: same char count costs more in CJK', () => {
    const cjk: Message = { role: 'user', content: '你'.repeat(40) }; // 4 + 40 = 44
    const latin: Message = { role: 'user', content: 'a'.repeat(40) }; // 4 + 10 = 14
    expect(estimateMessageTokens(cjk)).toBe(44);
    expect(estimateMessageTokens(latin)).toBe(14);
    // Budget 20 fits only the latin message; walk order is newest-first, so
    // the older CJK message is the one that gets dropped.
    const kept = compactConversationHistory([cjk, latin], {
      maxEstimatedTokens: 20,
      minTailMessages: 0,
    });
    expect(kept).toEqual([latin]);
  });

  it('accounts for images and tool_calls, not just text', () => {
    const withImage: Message = { role: 'user', content: '', images: ['AAAA'] }; // 4 + 300
    const withTools: Message = {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Pune' } } }],
    };
    const imageCost = estimateMessageTokens(withImage);
    expect(imageCost).toBeGreaterThanOrEqual(IMAGE_TOKEN_ESTIMATE);
    // Budget fits the cheap tool_call message but not the image message.
    const kept = compactConversationHistory([withImage, withTools], {
      maxEstimatedTokens: estimateMessageTokens(withTools),
      minTailMessages: 0,
    });
    expect(kept).toEqual([withTools]);
  });
});

describe('ConversationSession.compact', () => {
  function scriptedFetch(script: readonly { content: string }[]) {
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
          message: { role: 'assistant', content: turn?.content ?? 'ok' },
          done: true,
          prompt_eval_count: 10,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;
    return { fetchImpl, bodies };
  }

  it('compacts against the session num_ctx minus a 10% reply reservation, reporting the stats', async () => {
    // 80-char replies keep the assistant messages at the same 24-token cost as the user turns.
    const long = 'r'.repeat(80);
    const { fetchImpl } = scriptedFetch([{ content: long }, { content: long }, { content: long }]);
    const client = new OllamaClient({ fetch: fetchImpl });
    const session = new ConversationSession(client, {
      model: 'llama3.1',
      systemPrompt: 'You are terse.',
      options: { num_ctx: 100 },
    });
    await session.send('a'.repeat(80));
    await session.send('b'.repeat(80));
    await session.send('c'.repeat(80));

    const result = session.compact();
    // Before: system(8) + 6 x 24 = 152. Budget 90 -> retains system + 3 newest (80).
    expect(result.droppedMessages).toBe(3);
    expect(result.estimatedTokensBefore).toBe(152);
    expect(result.estimatedTokensAfter).toBe(80);
    expect(result.effectiveBudget).toBe(90);
    expect(session.getMessages()).toHaveLength(4); // system + 3
    expect(session.getMessages()[0]).toEqual({ role: 'system', content: 'You are terse.' });

    // Cumulative cache tallies are observations — compaction never resets them.
    expect(session.cacheStats.turns).toBe(3);
  });

  it('the next turn sends the compacted history (and only that)', async () => {
    const long = 'r'.repeat(80);
    const { fetchImpl, bodies } = scriptedFetch([{ content: long }, { content: long }]);
    const client = new OllamaClient({ fetch: fetchImpl });
    const session = new ConversationSession(client, {
      model: 'llama3.1',
      systemPrompt: 'sys',
      options: { num_ctx: 60 },
    });
    await session.send('a'.repeat(80));
    await session.send('b'.repeat(80));
    session.compact();

    await session.send('next');
    // Third /api/chat call = first after compaction.
    const finalMessages = bodies[2]?.messages as { role: string; content: string }[];
    // Budget 54: system(5) + u2(24) + a2(24) = 53 fits; a1 would exceed -> dropped with u1.
    expect(finalMessages.map((m) => m.content)).toEqual(['sys', 'b'.repeat(80), long, 'next']);
    // Older dropped turns never return.
    expect(finalMessages.map((m) => m.content)).not.toContain('a'.repeat(80));
  });

  it('is a no-op when the history already fits', async () => {
    const { fetchImpl } = scriptedFetch([{ content: 'r1' }]);
    const client = new OllamaClient({ fetch: fetchImpl });
    const session = new ConversationSession(client, {
      model: 'llama3.1',
      systemPrompt: 'sys',
      options: { num_ctx: 4096 },
    });
    await session.send('hello');

    const result = session.compact();
    expect(result.droppedMessages).toBe(0);
    expect(result.estimatedTokensBefore).toBe(result.estimatedTokensAfter);
    expect(session.getMessages()).toHaveLength(3); // system + user + assistant
  });

  it('honors explicit maxEstimatedTokens / reserveForReply / minTailMessages overrides', async () => {
    const long = 'r'.repeat(80);
    const { fetchImpl } = scriptedFetch([{ content: long }, { content: long }]);
    const client = new OllamaClient({ fetch: fetchImpl });
    const session = new ConversationSession(client, {
      model: 'llama3.1',
      systemPrompt: 'sys',
      options: { num_ctx: 4096 },
    });
    await session.send('a'.repeat(80));
    await session.send('b'.repeat(80));

    const result = session.compact({
      maxEstimatedTokens: 40,
      reserveForReply: 0,
      minTailMessages: 1,
    });
    // Budget 40: system(5) + newest reply(24) = 29 fits; the user turn would be 53 -> dropped.
    expect(result.droppedMessages).toBe(3);
    expect(result.effectiveBudget).toBe(40);
    expect(session.getMessages()).toHaveLength(2);
  });
});
