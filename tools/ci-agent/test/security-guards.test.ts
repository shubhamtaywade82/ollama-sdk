import { describe, it, expect } from 'vitest';
import { isPathAllowed, validateFixProposal } from '../src/security-guards.js';
import { FixProposal } from '../src/schemas.js';

describe('security-guards', () => {
  it('allows safe source paths and denies critical infrastructure', () => {
    expect(isPathAllowed('src/client.ts')).toBe(true);
    expect(isPathAllowed('test/unit.test.ts')).toBe(true);
    expect(isPathAllowed('scripts/verify.ts')).toBe(true);
    expect(isPathAllowed('.github/workflows/ci.yml')).toBe(false);
    expect(isPathAllowed('package.json')).toBe(false);
    expect(isPathAllowed('package-lock.json')).toBe(false);
    expect(isPathAllowed('.env')).toBe(false);
    expect(isPathAllowed('src/package.json')).toBe(false);
    expect(isPathAllowed('src/.env')).toBe(false);
  });

  it('rejects traversal, absolute paths, alternate separators, and non-canonical paths', () => {
    expect(isPathAllowed('../src/client.ts')).toBe(false);
    expect(isPathAllowed('src/../../.github/workflows/ci.yml')).toBe(false);
    expect(isPathAllowed('src/../.github/workflows/ci.yml')).toBe(false);
    expect(isPathAllowed('/src/client.ts')).toBe(false);
    expect(isPathAllowed('src\\client.ts')).toBe(false);
    expect(isPathAllowed('src//client.ts')).toBe(false);
    expect(isPathAllowed('src/./client.ts')).toBe(false);
    expect(isPathAllowed('src/\0client.ts')).toBe(false);
  });

  it('validates proposal confidence, file count, paths, duplicates, and content size', () => {
    const validProposal: FixProposal = {
      diagnosis: 'Off-by-one error',
      explanation: 'Increment index by 1',
      confidence: 'high',
      files: [{ path: 'src/calc.ts', content: 'export const x = 1;' }],
    };
    expect(validateFixProposal(validProposal).valid).toBe(true);

    expect(validateFixProposal({ ...validProposal, confidence: 'low' }).valid).toBe(false);
    expect(
      validateFixProposal({
        ...validProposal,
        files: [{ path: '.github/workflows/ci.yml', content: 'malicious' }],
      }).valid,
    ).toBe(false);
    expect(
      validateFixProposal({
        ...validProposal,
        files: [
          { path: 'src/calc.ts', content: 'one' },
          { path: 'src/calc.ts', content: 'two' },
        ],
      }).valid,
    ).toBe(false);
    expect(
      validateFixProposal({
        ...validProposal,
        files: [{ path: 'src/calc.ts', content: 'x'.repeat(60_001) }],
      }).valid,
    ).toBe(false);
    expect(
      validateFixProposal({
        ...validProposal,
        files: Array.from({ length: 6 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          content: 'export {};',
        })),
      }).valid,
    ).toBe(false);
  });
});
