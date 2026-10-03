/**
 * Conformance tests for Ollama's native REST API.
 *
 * Each test hits a real Ollama server and asserts the response matches
 * the IR-generated Zod schema. Failures here mean the wire format has
 * drifted from the contract — either the OpenAPI spec needs updating
 * (run `npm run contract:fetch` to re-pin) or the overlay needs a new
 * field declared.
 *
 * Skips automatically when Ollama isn't running — see harness.ts.
 */
import { expect } from 'vitest';
import {
  ChatResponseSchema,
  GenerateResponseSchema,
  EmbedResponseSchema,
  ShowResponseSchema,
  ListResponseSchema,
  PsResponseSchema,
  VersionResponseSchema,
} from '../../src/generated/models/schemas.js';
import {
  describeConformance,
  itConformance,
  setupConformance,
  CONFORMANCE_EMBED_MODEL,
} from './harness.js';

describeConformance('Native REST API conformance', () => {
  itConformance('GET /api/version returns VersionResponse', async (_ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { api } = setup;
    const res = await api.version();
    const parsed = VersionResponseSchema.safeParse(res);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(
      true,
    );
    expect(typeof res.version).toBe('string');
    expect(res.version.length).toBeGreaterThan(0);
  });

  itConformance('GET /api/tags returns ListResponse', async (_ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { api } = setup;
    const res = await api.tags();
    const parsed = ListResponseSchema.safeParse(res);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(
      true,
    );
    expect(Array.isArray(res.models)).toBe(true);
  });

  itConformance('GET /api/ps returns PsResponse', async (_ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { api } = setup;
    const res = await api.ps();
    const parsed = PsResponseSchema.safeParse(res);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(
      true,
    );
    expect(Array.isArray(res.models)).toBe(true);
  });

  itConformance('POST /api/show returns ShowResponse', async (ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { api, model } = setup;
    try {
      const res = await api.show({ model });
      const parsed = ShowResponseSchema.safeParse(res);
      expect(
        parsed.success,
        parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
      ).toBe(true);
      expect(res.details).toBeDefined();
      expect(typeof res.details.family).toBe('string');
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('not found') || err.message.includes('model'))
      ) {
        ctx.skip();
      }
      throw err;
    }
  });

  itConformance('POST /api/chat returns ChatResponse', async (ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { api, model } = setup;
    try {
      const res = await api.chat({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly the word "ok".' }],
        stream: false,
        options: { temperature: 0 },
      });
      const parsed = ChatResponseSchema.safeParse(res);
      expect(
        parsed.success,
        parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
      ).toBe(true);
      expect(res.model).toBe(model);
      expect(res.done).toBe(true);
      expect(res.message?.content).toBeDefined();
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('not found') || err.message.includes('model'))
      ) {
        ctx.skip();
      }
      throw err;
    }
  });

  itConformance('POST /api/generate returns GenerateResponse', async (ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { api, model } = setup;
    try {
      const res = await api.generate({
        model,
        prompt: 'Reply with exactly the word "ok".',
        stream: false,
        options: { temperature: 0 },
      });
      const parsed = GenerateResponseSchema.safeParse(res);
      expect(
        parsed.success,
        parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
      ).toBe(true);
      expect(res.model).toBe(model);
      expect(res.done).toBe(true);
      expect(typeof res.response).toBe('string');
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('not found') || err.message.includes('model'))
      ) {
        ctx.skip();
      }
      throw err;
    }
  });

  itConformance('POST /api/embed returns EmbedResponse', async (ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { api } = setup;
    try {
      const res = await api.embed({
        model: CONFORMANCE_EMBED_MODEL,
        input: 'hello world',
      });
      const parsed = EmbedResponseSchema.safeParse(res);
      expect(
        parsed.success,
        parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
      ).toBe(true);
      expect(res.model).toBe(CONFORMANCE_EMBED_MODEL);
      expect(Array.isArray(res.embeddings)).toBe(true);
      expect(res.embeddings.length).toBeGreaterThan(0);
      expect(res.embeddings[0]?.length).toBeGreaterThan(0);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('not found') || err.message.includes('model'))
      ) {
        ctx.skip();
      }
      throw err;
    }
  });

  itConformance('POST /api/chat streaming yields ChatResponse-shaped chunks', async (ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { api, model } = setup;
    try {
      const stream = await api.chat({
        model,
        messages: [{ role: 'user', content: 'Say "ok".' }],
        stream: true,
        options: { temperature: 0 },
      });
      const chunks: unknown[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
      const last = chunks[chunks.length - 1] as Record<string, unknown>;
      expect(last.done).toBe(true);
      for (const chunk of chunks) {
        const parsed = ChatResponseSchema.safeParse(chunk);
        expect(
          parsed.success,
          parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
        ).toBe(true);
      }
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('not found') || err.message.includes('model'))
      ) {
        ctx.skip();
      }
      throw err;
    }
  });
});

describeConformance('OllamaClient vs NativeApi shape parity', () => {
  itConformance('chat() returns the same model field from both surfaces', async (ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { client, api, model } = setup;
    try {
      const legacy = await client.chat({
        model,
        messages: [{ role: 'user', content: 'Say "ok".' }],
        stream: false,
        options: { temperature: 0 },
      });
      const generated = await api.chat({
        model,
        messages: [{ role: 'user', content: 'Say "ok".' }],
        stream: false,
        options: { temperature: 0 },
      });
      expect(legacy.model).toBe(generated.model);
      expect(legacy.done).toBe(true);
      expect(generated.done).toBe(true);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('not found') || err.message.includes('model'))
      ) {
        ctx.skip();
      }
      throw err;
    }
  });

  itConformance('version() returns the same version from both surfaces', async (_ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { client, api } = setup;
    const legacy = await client.version();
    const generated = await api.version();
    expect(legacy.version).toBe(generated.version);
  });
});
