import { describe, expect, it } from 'vitest';
import { SystemOneRequestSchema } from '../src/generated/models/SystemOneRequest.schema.js';
import { SystemOneResponseSchema } from '../src/generated/models/SystemOneResponse.schema.js';

/**
 * Wave 13 correction: boundary validation tests.
 *
 * The upstream OpenAPI declares structural constraints that the generated
 * Zod schemas must enforce at runtime:
 *
 *   - SystemOneRequest.questions: 1–64 properties, non-empty names
 *   - SystemOneChoiceQuestion.criteria: 2–26 properties, non-empty names
 *   - SystemOneScoreQuestion.criteria: 2–26 items
 *   - SystemOneContent: non-empty string (pattern \S)
 *
 * These tests prove invalid boundary requests fail validation. Without
 * them, the SDK would silently send malformed requests that Ollama
 * rejects with a 400.
 */
function makeChoiceQuestion() {
  return {
    type: 'choice' as const,
    instructions: 'Pick one',
    criteria: { a: 'Option A', b: 'Option B' },
  };
}

function makeScoreQuestion() {
  return {
    type: 'score' as const,
    instructions: 'Rate this',
    criteria: ['low', 'high'],
  };
}

function makeNoulQuestion() {
  return {
    type: 'noul' as const,
    instructions: 'Is this true?',
  };
}

describe('Wave 13: System One boundary validation — questions count', () => {
  it('rejects empty questions (minProperties: 1)', () => {
    const result = SystemOneRequestSchema.safeParse({
      model: 'tev1:4b',
      state: 'test',
      questions: {},
    });
    expect(result.success).toBe(false);
  });

  it('accepts exactly 1 question (boundary)', () => {
    const result = SystemOneRequestSchema.safeParse({
      model: 'tev1:4b',
      state: 'test',
      questions: { q1: makeNoulQuestion() },
    });
    expect(result.success).toBe(true);
  });

  it('accepts exactly 64 questions (boundary)', () => {
    const questions: Record<string, unknown> = {};
    for (let i = 1; i <= 64; i++) {
      questions[`q${i}`] = makeNoulQuestion();
    }
    const result = SystemOneRequestSchema.safeParse({
      model: 'tev1:4b',
      state: 'test',
      questions,
    });
    expect(result.success).toBe(true);
  });

  it('rejects 65 questions (maxProperties: 64)', () => {
    const questions: Record<string, unknown> = {};
    for (let i = 1; i <= 65; i++) {
      questions[`q${i}`] = makeNoulQuestion();
    }
    const result = SystemOneRequestSchema.safeParse({
      model: 'tev1:4b',
      state: 'test',
      questions,
    });
    expect(result.success).toBe(false);
  });
});

describe('Wave 13: System One boundary validation — choice criteria', () => {
  it('rejects choice with 1 criterion (minProperties: 2)', () => {
    const result = SystemOneRequestSchema.safeParse({
      model: 'tev1:4b',
      state: 'test',
      questions: {
        q1: {
          type: 'choice',
          instructions: 'Pick',
          criteria: { only: 'One option' },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts choice with exactly 2 criteria (boundary)', () => {
    const result = SystemOneRequestSchema.safeParse({
      model: 'tev1:4b',
      state: 'test',
      questions: { q1: makeChoiceQuestion() },
    });
    expect(result.success).toBe(true);
  });

  it('accepts choice with exactly 26 criteria (boundary)', () => {
    const criteria: Record<string, string> = {};
    for (let i = 1; i <= 26; i++) {
      criteria[`c${i}`] = `Option ${i}`;
    }
    const result = SystemOneRequestSchema.safeParse({
      model: 'tev1:4b',
      state: 'test',
      questions: {
        q1: { type: 'choice', instructions: 'Pick', criteria },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects choice with 27 criteria (maxProperties: 26)', () => {
    const criteria: Record<string, string> = {};
    for (let i = 1; i <= 27; i++) {
      criteria[`c${i}`] = `Option ${i}`;
    }
    const result = SystemOneRequestSchema.safeParse({
      model: 'tev1:4b',
      state: 'test',
      questions: {
        q1: { type: 'choice', instructions: 'Pick', criteria },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('Wave 13: System One boundary validation — score criteria', () => {
  it('rejects score with 1 criterion (minItems: 2)', () => {
    const result = SystemOneRequestSchema.safeParse({
      model: 'tev1:4b',
      state: 'test',
      questions: {
        q1: {
          type: 'score',
          instructions: 'Rate',
          criteria: ['only'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts score with exactly 2 criteria (boundary)', () => {
    const result = SystemOneRequestSchema.safeParse({
      model: 'tev1:4b',
      state: 'test',
      questions: { q1: makeScoreQuestion() },
    });
    expect(result.success).toBe(true);
  });

  it('accepts score with exactly 26 criteria (boundary)', () => {
    const criteria = Array.from({ length: 26 }, (_, i) => `level_${i}`);
    const result = SystemOneRequestSchema.safeParse({
      model: 'tev1:4b',
      state: 'test',
      questions: {
        q1: { type: 'score', instructions: 'Rate', criteria },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects score with 27 criteria (maxItems: 26)', () => {
    const criteria = Array.from({ length: 27 }, (_, i) => `level_${i}`);
    const result = SystemOneRequestSchema.safeParse({
      model: 'tev1:4b',
      state: 'test',
      questions: {
        q1: { type: 'score', instructions: 'Rate', criteria },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('Wave 13: System One boundary validation — property names', () => {
  it('rejects empty-string question name (pattern: \\S)', () => {
    const result = SystemOneRequestSchema.safeParse({
      model: 'tev1:4b',
      state: 'test',
      questions: { '': makeNoulQuestion() },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty-string choice criterion key (pattern: \\S)', () => {
    const result = SystemOneRequestSchema.safeParse({
      model: 'tev1:4b',
      state: 'test',
      questions: {
        q1: {
          type: 'choice',
          instructions: 'Pick',
          criteria: { '': 'Empty key', b: 'Option B' },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('Wave 13: System One response validation — correct wire format', () => {
  it('accepts a real upstream choice response (confidence is a number, not an object)', () => {
    const result = SystemOneResponseSchema.safeParse({
      model: 'nimble',
      answers: {
        label: {
          type: 'choice',
          choice: 'bug',
          probabilities: { billing: 0.0125, bug: 0.9781, account: 0.0093 },
          confidence: 0.8906,
        },
      },
      usage: { input_tokens: 174, output_tokens: 1 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects choice response with confidence as { score: number } (old wrong format)', () => {
    const result = SystemOneResponseSchema.safeParse({
      model: 'nimble',
      answers: {
        label: {
          type: 'choice',
          choice: 'bug',
          probabilities: { bug: 0.97 },
          confidence: { score: 0.89 }, // WRONG — should be a number
        },
      },
      usage: { input_tokens: 174, output_tokens: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a real upstream noul response (noul is a number, not bool+probability)', () => {
    const result = SystemOneResponseSchema.safeParse({
      model: 'nimble',
      answers: {
        urgent: {
          type: 'noul',
          noul: 0.9989,
        },
      },
      usage: { input_tokens: 50, output_tokens: 1 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects noul response with bool+probability (old wrong format)', () => {
    const result = SystemOneResponseSchema.safeParse({
      model: 'nimble',
      answers: {
        urgent: {
          type: 'noul',
          bool: true, // WRONG — should be `noul: number`
          probability: 0.87,
        },
      },
      usage: { input_tokens: 50, output_tokens: 1 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a real upstream score response (legend is Record, probabilities is Record, score is number)', () => {
    const result = SystemOneResponseSchema.safeParse({
      model: 'nimble',
      answers: {
        severity: {
          type: 'score',
          score: 1.73,
          legend: { '0': 'Routine', '1': 'Soon', '2': 'Immediate' },
          probabilities: { '0': 0.12, '1': 0.21, '2': 0.67 },
          confidence: 0.61,
        },
      },
      usage: { input_tokens: 80, output_tokens: 2 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects score response with legend as string (old wrong format)', () => {
    const result = SystemOneResponseSchema.safeParse({
      model: 'nimble',
      answers: {
        severity: {
          type: 'score',
          score: 3,
          legend: 'complex', // WRONG — should be Record<string, string>
          probabilities: { '0': 0.1, '1': 0.9 },
          confidence: 0.78,
        },
      },
      usage: { input_tokens: 80, output_tokens: 2 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects score response missing required probabilities field', () => {
    const result = SystemOneResponseSchema.safeParse({
      model: 'nimble',
      answers: {
        severity: {
          type: 'score',
          score: 1.73,
          legend: { '0': 'Low', '1': 'High' },
          confidence: 0.61,
          // Missing required: probabilities
        },
      },
      usage: { input_tokens: 80, output_tokens: 2 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects choice response missing required confidence field', () => {
    const result = SystemOneResponseSchema.safeParse({
      model: 'nimble',
      answers: {
        label: {
          type: 'choice',
          choice: 'bug',
          probabilities: { bug: 0.97 },
          // Missing required: confidence
        },
      },
      usage: { input_tokens: 80, output_tokens: 2 },
    });
    expect(result.success).toBe(false);
  });
});
