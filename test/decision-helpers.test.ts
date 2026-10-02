import { describe, expect, it } from 'vitest';
import { OllamaClient } from '../src/client.js';
import type { ChoiceDecision, NoulDecision, ScoreDecision } from '../src/decision.js';

/**
 * Wave 14B: Higher-level System One decision helpers.
 *
 * Tests the six decision helpers (choice, noul, score, route, verify,
 * rank) with mocked responses. The helpers wrap OllamaClient.systemOne()
 * with ergonomic single-question APIs and extract the typed answer.
 */

function mockFetch(response: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

function mockFetchCapturing(
  responseFactory: (body: unknown) => unknown,
): { fetchImpl: typeof globalThis.fetch; getLastBody: () => unknown } {
  let lastBody: unknown;
  return {
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      lastBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify(responseFactory(lastBody)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch,
    getLastBody: () => lastBody,
  };
}

describe('Wave 14B: Decision helpers', () => {
  describe('decision.choice()', () => {
    it('returns the selected option + probabilities + confidence', async () => {
      const mockResponse = {
        model: 'tev1:4b',
        answers: {
          decision: {
            type: 'choice',
            choice: 'duplicate_charge',
            probabilities: { refund: 0.05, duplicate_charge: 0.9, cancellation: 0.05 },
            confidence: 0.89,
          },
        },
        usage: { input_tokens: 142, output_tokens: 8 },
      };
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        fetch: mockFetch(mockResponse),
      });

      const result: ChoiceDecision = await client.decision.choice({
        model: 'tev1:4b',
        state: 'Customer was charged twice',
        instructions: 'What is the primary intent?',
        criteria: {
          refund: 'Customer wants a refund',
          duplicate_charge: 'Customer reports multiple charges',
          cancellation: 'Customer wants to cancel',
        },
      });

      expect(result.choice).toBe('duplicate_charge');
      expect(result.probabilities.duplicate_charge).toBe(0.9);
      expect(result.confidence).toBe(0.89);
      expect(result.usage.input_tokens).toBe(142);
    });

    it('sends the correct request shape (single choice question named "decision")', async () => {
      const { fetchImpl, getLastBody } = mockFetchCapturing(() => ({
        model: 'tev1:4b',
        answers: {
          decision: {
            type: 'choice',
            choice: 'a',
            probabilities: { a: 0.9, b: 0.1 },
            confidence: 0.8,
          },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      }));
      const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });

      await client.decision.choice({
        model: 'tev1:4b',
        state: 'test',
        instructions: 'Pick',
        criteria: { a: 'A', b: 'B' },
      });

      const body = getLastBody() as { questions: Record<string, unknown> };
      const question = body.questions.decision as { type: string; criteria: unknown };
      expect(question.type).toBe('choice');
      expect(question.criteria).toEqual({ a: 'A', b: 'B' });
    });
  });

  describe('decision.noul()', () => {
    it('returns the probability of true + a derived boolean (>= 0.5 → true)', async () => {
      const mockResponse = {
        model: 'tev1:4b',
        answers: {
          decision: {
            type: 'noul',
            noul: 0.87,
          },
        },
        usage: { input_tokens: 50, output_tokens: 4 },
      };
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        fetch: mockFetch(mockResponse),
      });

      const result: NoulDecision = await client.decision.noul({
        model: 'tev1:4b',
        state: 'Customer was charged twice',
        instructions: 'Does this require immediate attention?',
      });

      expect(result.noul).toBe(0.87);
      expect(result.bool).toBe(true); // 0.87 >= 0.5
    });

    it('returns bool=false when noul < 0.5', async () => {
      const mockResponse = {
        model: 'tev1:4b',
        answers: { decision: { type: 'noul', noul: 0.3 } },
        usage: { input_tokens: 50, output_tokens: 4 },
      };
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        fetch: mockFetch(mockResponse),
      });

      const result = await client.decision.noul({
        model: 'tev1:4b',
        state: 'test',
        instructions: 'Is this urgent?',
      });

      expect(result.noul).toBe(0.3);
      expect(result.bool).toBe(false);
    });
  });

  describe('decision.score()', () => {
    it('returns the weighted score + legend + probabilities + confidence', async () => {
      const mockResponse = {
        model: 'tev1:4b',
        answers: {
          decision: {
            type: 'score',
            score: 2.73,
            legend: { '0': 'trivial', '1': 'simple', '2': 'moderate', '3': 'complex', '4': 'very_complex' },
            probabilities: { '0': 0.05, '1': 0.1, '2': 0.2, '3': 0.55, '4': 0.1 },
            confidence: 0.78,
          },
        },
        usage: { input_tokens: 80, output_tokens: 6 },
      };
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        fetch: mockFetch(mockResponse),
      });

      const result: ScoreDecision = await client.decision.score({
        model: 'tev1:4b',
        state: 'A bug causes a typo in the footer.',
        instructions: 'How severe is this issue?',
        criteria: ['cosmetic', 'minor', 'moderate', 'serious', 'critical'],
      });

      expect(result.score).toBe(2.73);
      expect(result.legend['3']).toBe('complex');
      expect(result.probabilities['3']).toBe(0.55);
      expect(result.confidence).toBe(0.78);
    });
  });

  describe('decision.route()', () => {
    it('returns the selected route name + confidence', async () => {
      const mockResponse = {
        model: 'tev1:4b',
        answers: {
          decision: {
            type: 'choice',
            choice: 'billing',
            probabilities: { billing: 0.9, technical: 0.05, sales: 0.05 },
            confidence: 0.85,
          },
        },
        usage: { input_tokens: 100, output_tokens: 5 },
      };
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        fetch: mockFetch(mockResponse),
      });

      const result = await client.decision.route({
        model: 'tev1:4b',
        state: 'Customer wants a refund for a double charge',
        instructions: 'Which department should handle this?',
        criteria: {
          billing: 'Payments and refunds',
          technical: 'Software errors and bugs',
          sales: 'Sales and upgrades',
        },
      });

      expect(result.route).toBe('billing');
      expect(result.confidence).toBe(0.85);
    });

    it('the route name is typed as the criteria key union (not just string)', async () => {
      const mockResponse = {
        model: 'tev1:4b',
        answers: {
          decision: {
            type: 'choice',
            choice: 'frontend',
            probabilities: { frontend: 0.9, backend: 0.1 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 50, output_tokens: 3 },
      };
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        fetch: mockFetch(mockResponse),
      });

      const result = await client.decision.route({
        model: 'tev1:4b',
        state: 'The UI is broken',
        instructions: 'Which team?',
        criteria: {
          frontend: 'UI/UX issues',
          backend: 'API and server issues',
        },
      });

      // TypeScript knows result.route is 'frontend' | 'backend', not string.
      // This assignment would fail to compile if route were typed as string.
      const _typed: 'frontend' | 'backend' = result.route;
      expect(_typed).toBe('frontend');
    });
  });

  describe('decision.verify()', () => {
    it('returns verified=true when noul >= 0.5', async () => {
      const mockResponse = {
        model: 'tev1:4b',
        answers: { decision: { type: 'noul', noul: 0.92 } },
        usage: { input_tokens: 60, output_tokens: 2 },
      };
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        fetch: mockFetch(mockResponse),
      });

      const result = await client.decision.verify({
        model: 'tev1:4b',
        claim: 'Release 2.4.0 is live',
        evidence: 'Deployment log shows version 2.4.0 deployed at 3pm',
      });

      expect(result.verified).toBe(true);
      expect(result.probability).toBe(0.92);
    });

    it('returns verified=false when noul < 0.5', async () => {
      const mockResponse = {
        model: 'tev1:4b',
        answers: { decision: { type: 'noul', noul: 0.2 } },
        usage: { input_tokens: 60, output_tokens: 2 },
      };
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        fetch: mockFetch(mockResponse),
      });

      const result = await client.decision.verify({
        model: 'tev1:4b',
        claim: 'The API supports streaming',
        evidence: 'No mention of streaming in the docs',
      });

      expect(result.verified).toBe(false);
      expect(result.probability).toBe(0.2);
    });

    it('sends the claim + evidence as structured state', async () => {
      const { fetchImpl, getLastBody } = mockFetchCapturing(() => ({
        model: 'tev1:4b',
        answers: { decision: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 2 },
      }));
      const client = new OllamaClient({ baseUrl: 'http://localhost:11434', fetch: fetchImpl });

      await client.decision.verify({
        model: 'tev1:4b',
        claim: 'The sky is blue',
        evidence: 'Observation on a clear day',
      });

      const body = getLastBody() as { state: { claim: unknown; evidence: unknown } };
      expect(body.state.claim).toBe('The sky is blue');
      expect(body.state.evidence).toBe('Observation on a clear day');
    });
  });

  describe('decision.rank()', () => {
    it('ranks candidates by score (highest first)', async () => {
      // Score each candidate based on its state (deterministic, not
      // call-order-dependent — Promise.all parallelizes the requests).
      const scoresByState: Record<string, number> = {
        'Candidate A resume': 1.2,
        'Candidate B resume': 3.8,
        'Candidate C resume': 2.5,
      };
      const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const state = (body as { state: unknown }).state;
        const score = scoresByState[String(state)] ?? 0;
        return new Response(
          JSON.stringify({
            model: 'tev1:4b',
            answers: {
              decision: {
                type: 'score',
                score,
                legend: { '0': 'poor', '1': 'weak', '2': 'ok', '3': 'good', '4': 'excellent' },
                probabilities: { '0': 0.1, '1': 0.2, '2': 0.3, '3': 0.3, '4': 0.1 },
                confidence: 0.7,
              },
            },
            usage: { input_tokens: 50, output_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof globalThis.fetch;

      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        fetch: fetchImpl,
      });

      const results = await client.decision.rank({
        model: 'tev1:4b',
        instructions: 'How well does this candidate match the requirements?',
        criteria: ['poor', 'weak', 'ok', 'good', 'excellent'],
        candidates: [
          { id: 'alice', state: 'Candidate A resume' },
          { id: 'bob', state: 'Candidate B resume' },
          { id: 'carol', state: 'Candidate C resume' },
        ],
      });

      expect(results).toHaveLength(3);
      // Highest score first: bob (3.8) > carol (2.5) > alice (1.2)
      expect(results[0]!.candidate).toBe('bob');
      expect(results[0]!.score).toBe(3.8);
      expect(results[1]!.candidate).toBe('carol');
      expect(results[1]!.score).toBe(2.5);
      expect(results[2]!.candidate).toBe('alice');
      expect(results[2]!.score).toBe(1.2);
    });
  });

  describe('decision getter is cached', () => {
    it('returns the same Decision instance on repeated calls', () => {
      const client = new OllamaClient({ baseUrl: 'http://localhost:11434' });
      const a = client.decision;
      const b = client.decision;
      expect(a).toBe(b);
    });
  });
});
