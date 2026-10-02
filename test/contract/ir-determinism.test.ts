import { describe, expect, it } from 'vitest';
import { normalizeContract } from '../../generator/normalize/contract-normalizer.js';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');

/**
 * Wave 12 (P1): the committed canonical IR must be deterministic.
 * Previously the normalizer emitted a `generatedAt: <ISO timestamp>`
 * field that changed on every run, even when nothing else changed.
 * Re-running `npm run contract:normalize` produced a diff just
 * because of the timestamp — making the IR non-reproducible and
 * creating noise in code review.
 *
 * The fix: omit `generatedAt` entirely. The `sourceHash` field already
 * provides reproducibility (it's a SHA-256 of the OpenAPI source +
 * overlay contents). Build metadata (including generation timestamp)
 * belongs in CI artifacts, not the canonical contract.
 */
describe('Wave 12: canonical IR is deterministic', () => {
  it('normalizing the same sources twice produces byte-identical IR', () => {
    const a = normalizeContract(PROJECT_ROOT, { write: false });
    const b = normalizeContract(PROJECT_ROOT, { write: false });
    expect(JSON.stringify(a, null, 2)).toBe(JSON.stringify(b, null, 2));
  });

  it('the IR does NOT carry a generatedAt field', () => {
    const ir = normalizeContract(PROJECT_ROOT, { write: false });
    // The field is gone from the emitted output. (The TypeScript type
    // still allows it for backwards-compat with older committed IRs,
    // but the current normalizer never sets it.)
    const serialized = JSON.stringify(ir);
    expect(serialized).not.toContain('"generatedAt"');
  });

  it('the sourceHash is stable across runs (proves the source inputs are the only input to the hash)', () => {
    const a = normalizeContract(PROJECT_ROOT, { write: false });
    const b = normalizeContract(PROJECT_ROOT, { write: false });
    expect(a.sourceHash).toBe(b.sourceHash);
    // Sanity: the hash is a 16-char hex prefix of SHA-256.
    expect(a.sourceHash).toMatch(/^[a-f0-9]{16}$/);
  });
});
