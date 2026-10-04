import { describe, expect, it } from 'vitest';
import {
  MAX_SYSTEM_ONE_IMAGES_BYTES,
  MAX_SYSTEM_ONE_REQUEST_BYTES,
  estimateSystemOneRequestBytes,
} from '../src/system-one.js';

/**
 * System One image-support ergonomics — see `src/system-one.ts`.
 *
 * The generated `SystemOneRequest` type already carries an optional
 * `images?: readonly string[]` field; the SDK layer adds:
 *   - documented size constants for the 64 KiB / 32 MiB caps
 *   - a pre-flight byte estimator so callers can fail fast before
 *     sending an oversized payload
 */
describe('system-one: size caps', () => {
  it('MAX_SYSTEM_ONE_REQUEST_BYTES is 64 KiB (no-images limit)', () => {
    expect(MAX_SYSTEM_ONE_REQUEST_BYTES).toBe(64 * 1024);
  });

  it('MAX_SYSTEM_ONE_IMAGES_BYTES is 32 MiB (with-images limit)', () => {
    expect(MAX_SYSTEM_ONE_IMAGES_BYTES).toBe(32 * 1024 * 1024);
  });

  it('images limit is strictly larger than the no-images limit', () => {
    expect(MAX_SYSTEM_ONE_IMAGES_BYTES).toBeGreaterThan(MAX_SYSTEM_ONE_REQUEST_BYTES);
  });
});

describe('system-one: estimateSystemOneRequestBytes', () => {
  it('returns the UTF-8 byte length of the JSON-serialized request', () => {
    const request = {
      model: 'tev1:4b',
      state: 'test',
      questions: { q1: { type: 'noul', instructions: '?' } },
    };
    const expected = new TextEncoder().encode(JSON.stringify(request)).byteLength;
    expect(estimateSystemOneRequestBytes(request)).toBe(expected);
  });

  it('accounts for non-ASCII characters in the state field (UTF-8 multibyte)', () => {
    // Each emoji is 4 bytes in UTF-8; the JSON wrapper adds a few
    // ASCII bytes around it. The estimator must reflect the actual
    // wire byte count, not the JS string length.
    const state = '😀'.repeat(100);
    const request = {
      model: 'tev1:4b',
      state,
      questions: { q1: { type: 'noul', instructions: '?' } },
    };
    const bytes = estimateSystemOneRequestBytes(request);
    // The 100 emojis alone are 400 bytes; the rest of the JSON
    // structure adds at least 80 bytes (model + questions wrapper).
    expect(bytes).toBeGreaterThan(400);
    expect(bytes).toBe(new TextEncoder().encode(JSON.stringify(request)).byteLength);
  });

  it('includes image bytes in the estimate', () => {
    const noImages = {
      model: 'tev1:4b',
      state: 'test',
      questions: { q1: { type: 'noul', instructions: '?' } },
    };
    const withImages = {
      ...noImages,
      images: ['a'.repeat(1024)],
    };
    const noImagesBytes = estimateSystemOneRequestBytes(noImages);
    const withImagesBytes = estimateSystemOneRequestBytes(withImages);
    // The 1024-byte base64 image string should be reflected nearly
    // 1:1 in the estimate (plus a few bytes for the JSON key/quotes).
    expect(withImagesBytes - noImagesBytes).toBeGreaterThanOrEqual(1024);
  });

  it('exceeds MAX_SYSTEM_ONE_REQUEST_BYTES when images push payload past 64 KiB', () => {
    const request = {
      model: 'tev1:4b',
      state: 'test',
      questions: { q1: { type: 'noul', instructions: '?' } },
      // 100 KB of base64 — well past the 64 KiB no-images cap but
      // under the 32 MiB images cap.
      images: ['a'.repeat(100 * 1024)],
    };
    const bytes = estimateSystemOneRequestBytes(request);
    expect(bytes).toBeGreaterThan(MAX_SYSTEM_ONE_REQUEST_BYTES);
    expect(bytes).toBeLessThan(MAX_SYSTEM_ONE_IMAGES_BYTES);
  });

  it('exceeds MAX_SYSTEM_ONE_IMAGES_BYTES when payload crosses 32 MiB', () => {
    const request = {
      model: 'tev1:4b',
      state: 'test',
      questions: { q1: { type: 'noul', instructions: '?' } },
      // 33 MB of base64 — past the 32 MiB images cap.
      images: ['a'.repeat(33 * 1024 * 1024)],
    };
    const bytes = estimateSystemOneRequestBytes(request);
    expect(bytes).toBeGreaterThan(MAX_SYSTEM_ONE_IMAGES_BYTES);
  });

  it('small text-only request stays well under the 64 KiB cap', () => {
    const request = {
      model: 'tev1:4b',
      state: 'A customer reported being charged twice on October 3rd.',
      questions: {
        intent: {
          type: 'choice' as const,
          instructions: 'Classify the primary intent.',
          criteria: {
            refund: 'Wants money back',
            duplicate_charge: 'Reports duplicate billing',
            cancellation: 'Wants to cancel',
          },
        },
        urgent: {
          type: 'noul' as const,
          instructions: 'Does this require immediate attention?',
        },
      },
    };
    const bytes = estimateSystemOneRequestBytes(request);
    expect(bytes).toBeLessThan(MAX_SYSTEM_ONE_REQUEST_BYTES);
    // A reasonable text-only System One request should be well under
    // 1 KiB; this guards against accidentally shipping large state blobs.
    expect(bytes).toBeLessThan(1024);
  });
});
