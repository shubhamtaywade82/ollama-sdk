import { describe, it, expect } from 'vitest';
import { isPathAllowed, validateFixProposal } from '../src/security-guards.js';
import { FixProposal } from '../src/schemas.js';

describe('security-guards', () => {
  it('allows safe source paths and denies critical infrastructure', () => {
    expect(isPathAllowed('src/client.ts')).toBe(true);
    expect(isPathAllowed('test/unit.test.ts')).toBe(true);
    expect(isPathAllowed('.github/workflows/ci.yml')).toBe(false);
    expect(isPathAllowed('package.json')).toBe(false);
    expect(isPathAllowed('package-lock.json')).toBe(false);
    expect(isPathAllowed('.env')).toBe(false);
  });

  it('validates fix proposal boundaries', () => {
    const validProposal: FixProposal = {
      diagnosis: 'Off-by-one error',
      explanation: 'Increment index by 1',
      confidence: 'high',
      files: [{ path: 'src/calc.ts', content: 'export const x = 1;' }],
    };
    expect(validateFixProposal(validProposal).valid).toBe(true);

    const lowConfidence: FixProposal = { ...validProposal, confidence: 'low' };
    expect(validateFixProposal(lowConfidence).valid).toBe(false);

    const forbiddenPath: FixProposal = {
      ...validProposal,
      files: [{ path: '.github/workflows/ci.yml', content: 'malicious' }],
    };
    expect(validateFixProposal(forbiddenPath).valid).toBe(false);
  });
});
