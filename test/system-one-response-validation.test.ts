import { describe, expect, it } from 'vitest';
import { NativeApi } from '../src/generated/api/native-api.js';
import { OllamaRuntime } from '../src/generated/runtime/runtime.js';
import { HttpClient } from '../src/transport/http.js';
import { OllamaResponseValidationError } from '../src/errors.js';

/**
 * Wave 13: opt-in response validation path.
 *
 * The runtime now supports `validateResponses: true` which validates
 * the HTTP response body against the operation's registered response
 * schema before returning it. This is opt-in (not global) because
 * legitimate forward-compat wire-format extensions would cause false
 * rejections on operations that don't need strict response typing.
 *
 * Use this for operations where typed response semantics are the entire
 * point — System One being the canonical example. A wrong wire format
 * (e.g. `confidence: { score: 0.9 }` instead of `confidence: 0.9`)
 * would silently produce garbage decisions without this validation.
 */
function mockFetch(response: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

describe('Wave 13: opt-in response validation', () => {
  it('passes when the response matches the schema', async () => {
    const validResponse = {
      model: 'nimble',
      answers: {
        label: {
          type: 'choice',
          choice: 'bug',
          probabilities: { billing: 0.01, bug: 0.98, account: 0.01 },
          confidence: 0.89,
        },
      },
      usage: { input_tokens: 174, output_tokens: 1 },
    };
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: mockFetch(validResponse),
    });
    const runtime = new OllamaRuntime({
      http,
      enforceVersion: 'off',
      validateResponses: true,
    });
    const api = new NativeApi(runtime);

    const result = await api.systemOne({
      model: 'nimble',
      state: 'test',
      questions: {
        label: {
          type: 'choice',
          instructions: 'Pick',
          criteria: { a: 'A', b: 'B' },
        },
      },
    });
    expect(result.model).toBe('nimble');
  });

  it('throws OllamaResponseValidationError when the response has wrong wire format', async () => {
    // Wrong format: confidence is { score: number } instead of number,
    // and noul answer uses bool+probability instead of noul.
    const wrongResponse = {
      model: 'nimble',
      answers: {
        label: {
          type: 'choice',
          choice: 'bug',
          probabilities: { bug: 0.98 },
          confidence: { score: 0.89 }, // WRONG — should be a bare number
        },
      },
      usage: { input_tokens: 174, output_tokens: 1 },
    };
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: mockFetch(wrongResponse),
    });
    const runtime = new OllamaRuntime({
      http,
      enforceVersion: 'off',
      validateResponses: true,
    });
    const api = new NativeApi(runtime);

    await expect(
      api.systemOne({
        model: 'nimble',
        state: 'test',
        questions: {
          label: {
            type: 'choice',
            instructions: 'Pick',
            criteria: { a: 'A', b: 'B' },
          },
        },
      }),
    ).rejects.toBeInstanceOf(OllamaResponseValidationError);
  });

  it('the error carries the Zod issues and operationId', async () => {
    const wrongResponse = {
      model: 'nimble',
      answers: {
        q: {
          type: 'noul',
          bool: true, // WRONG — should be `noul: number`
        },
      },
      usage: { input_tokens: 10, output_tokens: 1 },
    };
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: mockFetch(wrongResponse),
    });
    const runtime = new OllamaRuntime({
      http,
      enforceVersion: 'off',
      validateResponses: true,
    });
    const api = new NativeApi(runtime);

    try {
      await api.systemOne({
        model: 'nimble',
        state: 'test',
        questions: { q: { type: 'noul', instructions: '?' } },
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaResponseValidationError);
      const e = err as OllamaResponseValidationError;
      expect(e.operationId).toBe('systemOne');
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.code).toBe('response_validation_error');
    }
  });

  it('validation is skipped when validateResponses is not set (default)', async () => {
    // Same wrong response, but no validateResponses — should pass through.
    const wrongResponse = {
      model: 'nimble',
      answers: {
        q: {
          type: 'noul',
          bool: true, // Wrong format, but not validated
        },
      },
      usage: { input_tokens: 10, output_tokens: 1 },
    };
    const http = new HttpClient({
      baseUrl: 'http://localhost:11434',
      fetch: mockFetch(wrongResponse),
    });
    const runtime = new OllamaRuntime({ http, enforceVersion: 'off' });
    const api = new NativeApi(runtime);

    // No throw — validation is off.
    const result = await api.systemOne({
      model: 'nimble',
      state: 'test',
      questions: { q: { type: 'noul', instructions: '?' } },
    });
    expect(result.model).toBe('nimble');
  });
});
