/**
 * Vision-history hygiene (see src/conversation.ts, ADR 0027).
 *
 * `/api/chat` is stateless — every request re-sends the whole history,
 * base64 images included, and every image costs context tokens on every
 * turn. A consumer-managed vision history therefore re-uploads each photo
 * long after the model answered the question that needed it.
 * `sanitizeHistoryForNextTurn()` evicts stale image payloads outside a
 * trailing keep-window, conversation text fully preserved — the same
 * caller-initiated philosophy as session compaction.
 *
 *   npm run example examples/vision-history-hygiene.ts
 */
import { OllamaClient, sanitizeHistoryForNextTurn } from '../src/index.js';
import type { Message } from '../src/index.js';

async function main() {
  const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
  const model = process.env.OLLAMA_VISION_MODEL ?? 'llava';

  // A consumer-managed multi-turn vision history (images as raw base64 —
  // data URIs, URLs, and file paths are resolved by the vision resolver).
  const history: Message[] = [
    {
      role: 'user',
      content: 'What is in this photo?',
      images: ['cGhvdG8gMSBieXRlcyAoc3RhbmQtaW4p'],
    },
  ];

  try {
    // Turn 1 — the model sees the photo.
    const first = await client.chat({
      model,
      messages: history,
    });
    console.log('turn 1:', first.message.content.slice(0, 100));
    history.push(first.message);

    // Turn 2 — append the newest image, then sanitize: the turn-1 payload
    // is evicted (payload, context tokens, heap), only the trailing turn
    // keeps its image. With imagePlaceholder the model still knows an
    // image used to be there.
    history.push({
      role: 'user',
      content: 'Now what is in THIS one?',
      images: ['cGhvdG8gMiBieXRlcyAoc3RhbmQtaW4p'],
    });
    const messages = sanitizeHistoryForNextTurn(history, {
      imagePlaceholder: '[image from an earlier turn removed to save context]',
    });

    const beforeBytes = JSON.stringify(history).length;
    const afterBytes = JSON.stringify(messages).length;
    console.log(`payload: ${beforeBytes} B -> ${afterBytes} B (stale images evicted)`);

    const second = await client.chat({ model, messages });
    console.log('turn 2:', second.message.content.slice(0, 100));
    history.length = 0;
    history.push(...messages, second.message);

    // Widening the window is one option: keep the last N images instead of 1.
    console.log(
      'keep-2 window sizes the next request at',
      JSON.stringify(sanitizeHistoryForNextTurn(history, { keepImagesOnLastMessages: 2 })).length,
      'B',
    );
  } catch (error) {
    console.error('example failed (is a vision-capable model pulled?):', error);
  } finally {
    await client.destroy();
  }
}

void main();
