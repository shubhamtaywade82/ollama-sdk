import { describe, expect, it } from 'vitest';
import { shouldContinueAfterAutoFix } from '../scripts/auto-fix-ci-policy.js';

describe('shouldContinueAfterAutoFix', () => {
  it('continues after a successful formatter run', () => {
    expect(shouldContinueAfterAutoFix('prettier', 0)).toBe(true);
  });

  it('allows parser diagnostics through to the repair agent', () => {
    expect(shouldContinueAfterAutoFix('prettier', 2)).toBe(true);
  });

  it('continues after a successful ESLint auto-fix', () => {
    expect(shouldContinueAfterAutoFix('eslint', 0)).toBe(true);
  });

  it('allows remaining non-auto-fixable lint findings through to the repair agent', () => {
    expect(shouldContinueAfterAutoFix('eslint', 1)).toBe(true);
  });

  it('stops on formatter execution failures', () => {
    expect(shouldContinueAfterAutoFix('prettier', 1)).toBe(false);
    expect(shouldContinueAfterAutoFix('prettier', 127)).toBe(false);
    expect(shouldContinueAfterAutoFix('prettier', null)).toBe(false);
  });

  it('stops on ESLint configuration and execution failures', () => {
    expect(shouldContinueAfterAutoFix('eslint', 2)).toBe(false);
    expect(shouldContinueAfterAutoFix('eslint', 127)).toBe(false);
    expect(shouldContinueAfterAutoFix('eslint', null)).toBe(false);
  });
});
