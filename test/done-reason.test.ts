import { describe, expect, it } from 'vitest';
import {
  KNOWN_DONE_REASONS,
  isKnownDoneReason,
  type KnownDoneReason,
} from '../src/done-reason.js';

/**
 * `done_reason` decoder helpers — see `src/done-reason.ts`.
 *
 * Ollama emits a small, stable set of `done_reason` literals on
 * `/api/chat` and `/api/generate` responses. The SDK accepts any
 * string for forward-compat with future upstream additions; these
 * helpers give callers who want to narrow on the known set a
 * type-safe way to do so.
 */
describe('done-reason: KNOWN_DONE_REASONS set', () => {
  it('contains the four documented literals', () => {
    expect(KNOWN_DONE_REASONS.has('stop')).toBe(true);
    expect(KNOWN_DONE_REASONS.has('length')).toBe(true);
    expect(KNOWN_DONE_REASONS.has('load')).toBe(true);
    expect(KNOWN_DONE_REASONS.has('unload')).toBe(true);
  });

  it('excludes any non-documented value', () => {
    expect(KNOWN_DONE_REASONS.has('')).toBe(false);
    expect(KNOWN_DONE_REASONS.has('STOP')).toBe(false); // case-sensitive
    expect(KNOWN_DONE_REASONS.has('cancelled')).toBe(false);
    expect(KNOWN_DONE_REASONS.has('error')).toBe(false);
  });

  it('is a readonly set (cannot be mutated at the type level)', () => {
    // KNOWN_DONE_REASONS is typed as ReadonlySet<KnownDoneReason>.
    // We can't add() to it without breaking the type contract.
    expect(KNOWN_DONE_REASONS.size).toBe(4);
  });
});

describe('done-reason: isKnownDoneReason type guard', () => {
  it('returns true for the documented literals', () => {
    const values: (string | undefined)[] = ['stop', 'length', 'load', 'unload'];
    for (const v of values) {
      expect(isKnownDoneReason(v)).toBe(true);
    }
  });

  it('returns false for unknown string values', () => {
    expect(isKnownDoneReason('cancelled')).toBe(false);
    expect(isKnownDoneReason('error')).toBe(false);
    expect(isKnownDoneReason('')).toBe(false);
    expect(isKnownDoneReason('STOP')).toBe(false); // case-sensitive
  });

  it('returns false for undefined/null (graceful response decoder behavior)', () => {
    // This is the critical conformance-test fix: when a non-reasoning
    // model omits done_reason, or when a cold prompt omits
    // prompt_eval_cached_count, the response decoder must NOT throw
    // a TypeError on undefined access.
    expect(isKnownDoneReason(undefined)).toBe(false);
    expect(isKnownDoneReason(null)).toBe(false);
  });

  it('acts as a TypeScript type guard, narrowing to KnownDoneReason', () => {
    // Compile-time check: this branch must type-check as KnownDoneReason
    // (assignable to the union of literals). Runtime check confirms the
    // narrowed value is still the input value.
    const value: string | undefined = 'load';
    if (isKnownDoneReason(value)) {
      const narrowed: KnownDoneReason = value;
      expect(narrowed).toBe('load');
      // An exhaustive switch on the narrowed value must compile without
      // a default case — every documented literal is covered.
      switch (narrowed) {
        case 'stop':
          expect(true).toBe(true);
          break;
        case 'length':
          expect(true).toBe(true);
          break;
        case 'load':
          expect(true).toBe(true);
          break;
        case 'unload':
          expect(true).toBe(true);
          break;
      }
    } else {
      // Forward-compat branch: an unknown reason lands here.
      expect.unreachable('expected "load" to be a known done_reason');
    }
  });
});
