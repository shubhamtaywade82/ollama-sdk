import { describe, expect, it } from 'vitest';
import {
  KEEP_ALIVE_INDEFINITE,
  KEEP_ALIVE_UNLOAD,
  isKeepAliveSugar,
  normalizeKeepAlive,
  type KeepAlive,
} from '../src/keep-alive.js';

/**
 * VRAM lifecycle primitives — see `src/keep-alive.ts`.
 *
 * The `keep_alive` field accepts four upstream-supported shapes plus
 * two SDK-level sugar literals. These tests verify the normalization
 * function maps every accepted shape to the raw `string | number`
 * form the wire expects, while leaving opaque values untouched.
 */
describe('keep-alive: normalizeKeepAlive', () => {
  it('maps "unload" → 0 (immediate eviction sentinel)', () => {
    expect(normalizeKeepAlive('unload')).toBe(0);
    expect(normalizeKeepAlive('unload')).toBe(KEEP_ALIVE_UNLOAD);
  });

  it('maps "indefinite" → -1 (perpetual pinning sentinel)', () => {
    expect(normalizeKeepAlive('indefinite')).toBe(-1);
    expect(normalizeKeepAlive('indefinite')).toBe(KEEP_ALIVE_INDEFINITE);
  });

  it('passes duration strings through unchanged', () => {
    expect(normalizeKeepAlive('5m')).toBe('5m');
    expect(normalizeKeepAlive('24h')).toBe('24h');
    expect(normalizeKeepAlive('0s')).toBe('0s');
    expect(normalizeKeepAlive('-1m')).toBe('-1m');
  });

  it('passes integer seconds through unchanged (including 0 and -1)', () => {
    expect(normalizeKeepAlive(0)).toBe(0);
    expect(normalizeKeepAlive(-1)).toBe(-1);
    expect(normalizeKeepAlive(3600)).toBe(3600);
    expect(normalizeKeepAlive(300)).toBe(300);
  });

  it('returns undefined for undefined input', () => {
    expect(normalizeKeepAlive(undefined)).toBeUndefined();
  });

  it('is referentially transparent: sugar and raw sentinels produce equal wire values', () => {
    // Callers using the sugar literal and callers using the raw sentinel
    // produce identical wire payloads — no behavior divergence at the
    // HTTP layer.
    expect(normalizeKeepAlive('unload')).toBe(normalizeKeepAlive(0));
    expect(normalizeKeepAlive('indefinite')).toBe(normalizeKeepAlive(-1));
  });
});

describe('keep-alive: isKeepAliveSugar', () => {
  it('returns true for the SDK-level sugar literals', () => {
    const sugar: KeepAlive[] = ['unload', 'indefinite'];
    for (const s of sugar) {
      expect(isKeepAliveSugar(s)).toBe(true);
    }
  });

  it('returns false for raw strings, numbers, and undefined', () => {
    expect(isKeepAliveSugar('5m')).toBe(false);
    expect(isKeepAliveSugar('0s')).toBe(false);
    expect(isKeepAliveSugar('-1m')).toBe(false);
    expect(isKeepAliveSugar(0)).toBe(false);
    expect(isKeepAliveSugar(-1)).toBe(false);
    expect(isKeepAliveSugar(3600)).toBe(false);
    expect(isKeepAliveSugar(undefined)).toBe(false);
    expect(isKeepAliveSugar('')).toBe(false);
  });
});

describe('keep-alive: sentinel constants', () => {
  it('KEEP_ALIVE_UNLOAD is exactly 0 (not a string)', () => {
    expect(KEEP_ALIVE_UNLOAD).toBe(0);
    expect(typeof KEEP_ALIVE_UNLOAD).toBe('number');
  });

  it('KEEP_ALIVE_INDEFINITE is exactly -1 (not a string)', () => {
    expect(KEEP_ALIVE_INDEFINITE).toBe(-1);
    expect(typeof KEEP_ALIVE_INDEFINITE).toBe('number');
  });
});
