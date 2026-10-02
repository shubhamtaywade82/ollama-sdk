/**
 * Conformance tests for Ollama's System One decision API (/v1/systemone).
 *
 * Wave 13: These tests hit a REAL Ollama server with a real System One
 * model (tev1/nimble) and assert the response matches the IR-generated
 * Zod schema. Failures here mean the wire format has drifted from the
 * contract — either the OpenAPI spec needs updating or the overlay
 * needs a new field declared.
 *
 * Requires Ollama >= 0.35.0 and a System One-compatible model pulled
 * locally (e.g. `ollama pull tev1:0.8b`). Skips automatically when
 * Ollama isn't running or the model isn't available.
 */
import { expect } from 'vitest';
import { SystemOneResponseSchema } from '../../src/generated/models/SystemOneResponse.schema.js';
import {
  describeConformance,
  itConformance,
  setupConformance,
  CONFORMANCE_SYSTEMONE_MODEL,
} from './harness.js';

describeConformance('System One conformance', () => {
  itConformance('POST /v1/systemone choice question returns typed response', async (ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { client } = setup;

    let result;
    try {
      result = await client.systemOne({
        model: CONFORMANCE_SYSTEMONE_MODEL,
        state: 'Our checkout has returned 500 errors since 9am.',
        questions: {
          label: {
            type: 'choice',
            instructions: 'Which label fits this ticket?',
            criteria: {
              billing: 'Payments and refunds',
              bug: 'Software errors',
              account: 'Login and account access',
            },
          },
        },
      });
    } catch (err) {
      // If the model isn't available, skip rather than fail.
      if (
        err instanceof Error &&
        (err.message.includes('not found') || err.message.includes('model'))
      ) {
        ctx.skip();
      }
      throw err;
    }

    // Validate against the generated Zod schema — this is the critical
    // conformance check. If the real server returns a different shape
    // (e.g. confidence as { score } instead of a bare number), this fails.
    const parsed = SystemOneResponseSchema.safeParse(result);
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
    ).toBe(true);

    // Structural assertions on the choice answer.
    expect(result.model).toBe(CONFORMANCE_SYSTEMONE_MODEL);
    expect(result.answers.label.type).toBe('choice');
    if (result.answers.label.type === 'choice') {
      expect(typeof result.answers.label.choice).toBe('string');
      expect(result.answers.label.choice.length).toBeGreaterThan(0);
      expect(typeof result.answers.label.confidence).toBe('number');
      expect(result.answers.label.confidence).toBeGreaterThanOrEqual(0);
      expect(result.answers.label.confidence).toBeLessThanOrEqual(1);
      expect(result.answers.label.probabilities).toBeDefined();
    }
    expect(result.usage.input_tokens).toBeGreaterThanOrEqual(0);
    expect(result.usage.output_tokens).toBeGreaterThanOrEqual(0);
  });

  itConformance('POST /v1/systemone noul question returns typed response', async (ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { client } = setup;

    let result;
    try {
      result = await client.systemOne({
        model: CONFORMANCE_SYSTEMONE_MODEL,
        state: 'A customer submitted a refund request within 30 days.',
        questions: {
          eligible: {
            type: 'noul',
            instructions: 'Is this customer eligible for a refund?',
          },
        },
      });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('not found') || err.message.includes('model'))
      ) {
        ctx.skip();
      }
      throw err;
    }

    const parsed = SystemOneResponseSchema.safeParse(result);
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
    ).toBe(true);

    expect(result.answers.eligible.type).toBe('noul');
    if (result.answers.eligible.type === 'noul') {
      // noul is the probability of true (0-1), NOT a boolean.
      expect(typeof result.answers.eligible.noul).toBe('number');
      expect(result.answers.eligible.noul).toBeGreaterThanOrEqual(0);
      expect(result.answers.eligible.noul).toBeLessThanOrEqual(1);
    }
  });

  itConformance('POST /v1/systemone score question returns typed response', async (ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { client } = setup;

    let result;
    try {
      result = await client.systemOne({
        model: CONFORMANCE_SYSTEMONE_MODEL,
        state: 'A bug causes a typo in the footer of the landing page.',
        questions: {
          severity: {
            type: 'score',
            instructions: 'How severe is this issue?',
            criteria: ['cosmetic', 'minor', 'moderate', 'serious', 'critical'],
          },
        },
      });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('not found') || err.message.includes('model'))
      ) {
        ctx.skip();
      }
      throw err;
    }

    const parsed = SystemOneResponseSchema.safeParse(result);
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
    ).toBe(true);

    expect(result.answers.severity.type).toBe('score');
    if (result.answers.severity.type === 'score') {
      // score is a probability-weighted average (number, 0 to N-1),
      // NOT an integer index.
      expect(typeof result.answers.severity.score).toBe('number');
      expect(result.answers.severity.score).toBeGreaterThanOrEqual(0);
      // legend is a Record<string, string>, NOT a string.
      expect(typeof result.answers.severity.legend).toBe('object');
      expect(Object.keys(result.answers.severity.legend).length).toBeGreaterThan(0);
      // probabilities is a Record<string, number>, NOT number[].
      expect(typeof result.answers.severity.probabilities).toBe('object');
      // confidence is a bare number, NOT { score: number }.
      expect(typeof result.answers.severity.confidence).toBe('number');
      expect(result.answers.severity.confidence).toBeGreaterThanOrEqual(0);
      expect(result.answers.severity.confidence).toBeLessThanOrEqual(1);
    }
  });

  itConformance('POST /v1/systemone mixed questions return typed responses', async (ctx) => {
    const setup = await setupConformance();
    if (!setup) return;
    const { client } = setup;

    let result;
    try {
      result = await client.systemOne({
        model: CONFORMANCE_SYSTEMONE_MODEL,
        state: { ticket: 'Customer was charged twice and wants a refund' },
        questions: {
          intent: {
            type: 'choice',
            instructions: 'What is the primary intent?',
            criteria: {
              refund: 'Customer wants a refund',
              duplicate_charge: 'Customer reports multiple charges',
              cancellation: 'Customer wants to cancel',
              none: 'None of these',
            },
          },
          urgent: {
            type: 'noul',
            instructions: 'Does this require immediate attention?',
          },
          difficulty: {
            type: 'score',
            instructions: 'How difficult is this case?',
            criteria: ['trivial', 'simple', 'moderate', 'complex', 'very_complex'],
          },
        },
      });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('not found') || err.message.includes('model'))
      ) {
        ctx.skip();
      }
      throw err;
    }

    const parsed = SystemOneResponseSchema.safeParse(result);
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
    ).toBe(true);

    // All three answer types should be present and correctly typed.
    expect(result.answers.intent.type).toBe('choice');
    expect(result.answers.urgent.type).toBe('noul');
    expect(result.answers.difficulty.type).toBe('score');
    expect(result.usage.input_tokens).toBeGreaterThan(0);
  });
});
