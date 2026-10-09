import { describe, expect, it, vi } from 'vitest';
import { sanitizeHistoryForNextTurn } from '../src/conversation.js';
import { OllamaClient } from '../src/client.js';
import type { Message } from '../src/types.js';

/**
 * CTX-01: vision-history hygiene. Consumer-managed multi-turn vision
 * histories re-upload every prior base64 image on every request (Ollama's
 * /api/chat is stateless); `sanitizeHistoryForNextTurn` evicts stale image
 * payloads while preserving conversation text — pure, opt-in, never wired
 * into the request path automatically (ADR 0027).
 */

const B64_A = 'aW1hZ2Vh';
const B64_B = 'aW1hZ2Vi';
const B64_C = 'aW1hZ2Vj';

describe('sanitizeHistoryForNextTurn', () => {
  const visionHistory: Message[] = [
    { role: 'system', content: 'You describe images.' },
    { role: 'user', content: 'What is in this photo?', images: [B64_A] },
    { role: 'assistant', content: 'A cat on a sofa.' },
    { role: 'user', content: 'And this one?', images: [B64_B] },
    { role: 'assistant', content: 'A dog in a park.' },
    { role: 'user', content: 'What about THIS one?', images: [B64_C] },
  ];

  it('drops base64 images from every message except the last (default window)', () => {
    const sanitized = sanitizeHistoryForNextTurn(visionHistory);
    expect(sanitized).toHaveLength(visionHistory.length);
    expect(sanitized[1]?.images).toBeUndefined();
    expect(sanitized[3]?.images).toBeUndefined();
    // The trailing message keeps its payload — the model still sees the
    // image the current turn is asking about.
    expect(sanitized[5]?.images).toEqual([B64_C]);
  });

  it('preserves conversation text exactly, including evicted turns', () => {
    const sanitized = sanitizeHistoryForNextTurn(visionHistory);
    expect(sanitized.map((m) => m.role)).toEqual(visionHistory.map((m) => m.role));
    expect(sanitized.map((m) => m.content)).toEqual(visionHistory.map((m) => m.content));
  });

  it('is pure: the input array and its message objects are never mutated', () => {
    const input = visionHistory.map((m) => ({ ...m }));
    const snapshot = JSON.stringify(input);
    sanitizeHistoryForNextTurn(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input[1]?.images).toEqual([B64_A]);
  });

  it('reuses untouched messages by reference (KV-prefix stability where nothing changed)', () => {
    const sanitized = sanitizeHistoryForNextTurn(visionHistory);
    // Messages without images and the kept trailing message are identical
    // references; only evicted messages are fresh copies.
    expect(sanitized[0]).toBe(visionHistory[0]);
    expect(sanitized[2]).toBe(visionHistory[2]);
    expect(sanitized[4]).toBe(visionHistory[4]);
    expect(sanitized[5]).toBe(visionHistory[5]);
    expect(sanitized[1]).not.toBe(visionHistory[1]);
  });

  it('keeps images on the last N messages when keepImagesOnLastMessages is set', () => {
    const sanitized = sanitizeHistoryForNextTurn(visionHistory, {
      keepImagesOnLastMessages: 4,
    });
    // Last 4 messages: indexes 2..5 — the index-3 image survives.
    expect(sanitized[1]?.images).toBeUndefined();
    expect(sanitized[3]?.images).toEqual([B64_B]);
    expect(sanitized[5]?.images).toEqual([B64_C]);
  });

  it('evicts every image with keepImagesOnLastMessages: 0 (text-only follow-up)', () => {
    const sanitized = sanitizeHistoryForNextTurn(visionHistory, {
      keepImagesOnLastMessages: 0,
    });
    for (const message of sanitized) {
      expect(message.images).toBeUndefined();
    }
  });

  it('clamps negative keep windows to 0 instead of throwing', () => {
    const sanitized = sanitizeHistoryForNextTurn(visionHistory, {
      keepImagesOnLastMessages: -3,
    });
    for (const message of sanitized) {
      expect(message.images).toBeUndefined();
    }
  });

  it('appends the placeholder note to evicted messages when requested', () => {
    const note = '[image from an earlier turn removed to save context]';
    const sanitized = sanitizeHistoryForNextTurn(visionHistory, { imagePlaceholder: note });
    expect(sanitized[1]?.content).toBe(`What is in this photo?\n\n${note}`);
    expect(sanitized[3]?.content).toBe(`And this one?\n\n${note}`);
    // The kept trailing message is untouched — note or not.
    expect(sanitized[5]?.content).toBe('What about THIS one?');
  });

  it('uses the placeholder alone when an evicted message had empty content', () => {
    const note = '[image removed]';
    const sanitized = sanitizeHistoryForNextTurn(
      [
        { role: 'user', content: '', images: [B64_A] },
        { role: 'assistant', content: 'ok' },
      ],
      { imagePlaceholder: note },
    );
    expect(sanitized[0]?.content).toBe(note);
  });

  it('leaves empty images arrays and image-free messages reference-stable', () => {
    const withEmpty: Message[] = [
      { role: 'user', content: 'no images here' },
      { role: 'user', content: 'explicitly empty', images: [] },
    ];
    const sanitized = sanitizeHistoryForNextTurn(withEmpty);
    expect(sanitized[0]).toBe(withEmpty[0]);
    expect(sanitized[1]).toBe(withEmpty[1]);
    expect(sanitized[1]?.images).toEqual([]);
  });

  it('drops raw Uint8Array image payloads the same way (VisionInput passthrough)', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const history: Message[] = [
      { role: 'user', content: 'old', images: [bytes] },
      { role: 'user', content: 'new', images: [bytes] },
    ];
    const sanitized = sanitizeHistoryForNextTurn(history);
    expect(sanitized[0]?.images).toBeUndefined();
    expect(sanitized[1]?.images).toEqual([bytes]);
  });

  it('round-trips through client.chat: the wire body carries no stale base64', async () => {
    // Audit checklist item: prove the sanitized history drops previous
    // base64 images ON THE WIRE while preserving conversation text.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'llava',
          created_at: '2026-10-09T00:00:00Z',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', fetch: fetchMock });

    const history: Message[] = [
      { role: 'user', content: 'What is in this photo?', images: [B64_A] },
      { role: 'assistant', content: 'A cat on a sofa.' },
      { role: 'user', content: 'What about THIS one?', images: [B64_C] },
    ];
    await client.chat({
      model: 'llava',
      messages: sanitizeHistoryForNextTurn(history),
    });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { messages: Array<{ role: string; content: string; images?: string[] }> };
    expect(body.messages[0]?.images).toBeUndefined();
    expect(body.messages[0]?.content).toBe('What is in this photo?');
    expect(body.messages[1]?.content).toBe('A cat on a sofa.');
    expect(body.messages[2]?.images).toEqual([B64_C]);
  });
});
