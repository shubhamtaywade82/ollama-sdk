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
  CONFORMANCE_MODEL,
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

  itConformance('POST /api/show returns ShowResponse', async (_ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { api } = setup;
    const res = await api.show({ model: CONFORMANCE_MODEL });
    const parsed = ShowResponseSchema.safeParse(res);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(
      true,
    );
    expect(res.details).toBeDefined();
    expect(typeof res.details.family).toBe('string');
  });

  itConformance('POST /api/chat returns ChatResponse', async (_ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { api } = setup;
    const res = await api.chat({
      model: CONFORMANCE_MODEL,
      messages: [{ role: 'user', content: 'Reply with exactly the word "ok".' }],
      stream: false,
      options: { temperature: 0 },
    });
    const parsed = ChatResponseSchema.safeParse(res);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(
      true,
    );
    expect(res.model).toBe(CONFORMANCE_MODEL);
    expect(res.done).toBe(true);
    expect(res.message?.content).toBeDefined();
  });

  itConformance('POST /api/generate returns GenerateResponse', async (_ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { api } = setup;
    const res = await api.generate({
      model: CONFORMANCE_MODEL,
      prompt: 'Reply with exactly the word "ok".',
      stream: false,
      options: { temperature: 0 },
    });
    const parsed = GenerateResponseSchema.safeParse(res);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(
      true,
    );
    expect(res.model).toBe(CONFORMANCE_MODEL);
    expect(res.done).toBe(true);
    expect(typeof res.response).toBe('string');
  });

  itConformance('POST /api/embed returns EmbedResponse', async (_ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { api } = setup;
    const res = await api.embed({
      model: CONFORMANCE_EMBED_MODEL,
      input: 'hello world',
    });
    const parsed = EmbedResponseSchema.safeParse(res);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(
      true,
    );
    expect(res.model).toBe(CONFORMANCE_EMBED_MODEL);
    expect(Array.isArray(res.embeddings)).toBe(true);
    expect(res.embeddings.length).toBeGreaterThan(0);
    expect(res.embeddings[0]?.length).toBeGreaterThan(0);
  });

  itConformance('POST /api/chat streaming yields ChatResponse-shaped chunks', async (_ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { api } = setup;
    const stream = await api.chat({
      model: CONFORMANCE_MODEL,
      messages: [{ role: 'user', content: 'Say "ok".' }],
      stream: true,
      options: { temperature: 0 },
    });
    const chunks: unknown[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    // The last chunk should have `done: true` and look like a ChatResponse
    const last = chunks[chunks.length - 1] as Record<string, unknown>;
    expect(last.done).toBe(true);
    // Validate every chunk against the ChatResponse schema — streaming
    // chunks are the same shape as the final response (with incremental
    // fields filled in as the model progresses).
    for (const chunk of chunks) {
      const parsed = ChatResponseSchema.safeParse(chunk);
      expect(
        parsed.success,
        parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
      ).toBe(true);
    }
  });
});

describeConformance('OllamaClient vs NativeApi shape parity', () => {
  // These tests confirm the legacy OllamaClient and the generated NativeApi
  // return structurally identical responses for the same request. If they
  // diverge, the Wave 8 deprecation path (OllamaClient → NativeApi) would
  // silently break callers.

  itConformance('chat() returns the same model field from both surfaces', async (_ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { client, api } = setup;
    const legacy = await client.chat({
      model: CONFORMANCE_MODEL,
      messages: [{ role: 'user', content: 'Say "ok".' }],
      stream: false,
      options: { temperature: 0 },
    });
    const generated = await api.chat({
      model: CONFORMANCE_MODEL,
      messages: [{ role: 'user', content: 'Say "ok".' }],
      stream: false,
      options: { temperature: 0 },
    });
    expect(legacy.model).toBe(generated.model);
    expect(legacy.done).toBe(true);
    expect(generated.done).toBe(true);
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
