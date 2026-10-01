import { describe, expect, it } from 'vitest';
import {
  ChatRequestSchema,
  ChatResponseSchema,
  GenerateRequestSchema,
  EmbedRequestSchema,
  VersionResponseSchema,
} from '../../src/generated/models/schemas.js';

describe('Wave 9: generated Zod schemas — happy path', () => {
  it('parses a minimal valid ChatRequest', () => {
    const result = ChatRequestSchema.parse({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toMatchObject({ model: 'gpt-4' });
  });

  it('parses a ChatRequest with options, stream, and tools', () => {
    const result = ChatRequestSchema.parse({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      think: true,
      keep_alive: '5m',
      options: { temperature: 0.7 },
    });
    expect(result).toMatchObject({ model: 'gpt-4', stream: true });
  });

  it('parses a ChatResponse', () => {
    const result = ChatResponseSchema.parse({
      model: 'gpt-4',
      created_at: '2025-01-01T00:00:00Z',
      message: { role: 'assistant', content: 'hello' },
      done: true,
    });
    expect(result).toMatchObject({ model: 'gpt-4', done: true });
  });

  it('parses a GenerateRequest with optional fields', () => {
    const result = GenerateRequestSchema.parse({
      model: 'llama3',
      prompt: 'Hello',
      stream: false,
    });
    expect(result).toMatchObject({ model: 'llama3', prompt: 'Hello' });
  });

  it('parses an EmbedRequest', () => {
    const result = EmbedRequestSchema.parse({
      model: 'nomic-embed-text',
      input: 'hello world',
    });
    expect(result).toMatchObject({ model: 'nomic-embed-text' });
  });

  it('parses a VersionResponse', () => {
    const result = VersionResponseSchema.parse({ version: '0.5.0' });
    expect(result.version).toBe('0.5.0');
  });
});

describe('Wave 9: generated Zod schemas — rejection', () => {
  it('rejects a ChatRequest missing required fields', () => {
    expect(() => ChatRequestSchema.parse({ model: 'gpt-4' })).toThrow();
  });

  it('rejects a ChatRequest with wrong-typed fields', () => {
    expect(() =>
      ChatRequestSchema.parse({
        model: 'gpt-4',
        messages: 'not-an-array',
      }),
    ).toThrow();
  });

  it('rejects a VersionResponse with wrong-typed version', () => {
    expect(() => VersionResponseSchema.parse({ version: 123 })).toThrow();
  });

  it('does not reject a VersionResponse missing version (OpenAPI spec marks it optional)', () => {
    // The OpenAPI spec for VersionResponse doesn't include `required: [version]`,
    // so the generated Zod schema treats `version` as optional. Empty objects
    // parse successfully. This is a known divergence from the hand-written
    // `VersionResponse` interface (which makes `version: string` required) —
    // callers wanting stricter validation can wrap the schema with
    // `.refine(data => data.version !== undefined)`.
    const result = VersionResponseSchema.parse({});
    expect(result).toEqual({});
  });

  it('strips unknown fields by default (Zod object default behavior)', () => {
    const result = ChatRequestSchema.parse({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      unknownExtraField: 'should be stripped',
    });
    expect((result as Record<string, unknown>).unknownExtraField).toBeUndefined();
  });
});

describe('Wave 9: generated Zod schemas — schema metadata', () => {
  it('every exported schema is a ZodType (has .parse and .safeParse)', () => {
    // Zod v4 schemas expose `parse` and `safeParse` (no longer `_parse`).
    for (const schema of [
      ChatRequestSchema,
      ChatResponseSchema,
      GenerateRequestSchema,
      EmbedRequestSchema,
      VersionResponseSchema,
    ]) {
      expect(typeof schema.parse).toBe('function');
      expect(typeof schema.safeParse).toBe('function');
    }
  });
});
