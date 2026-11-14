import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const CI_PATH = resolve(PROJECT_ROOT, '.github/workflows/ci.yml');
const DRIFT_PATH = resolve(PROJECT_ROOT, 'scripts/upstream-drift.ts');

/**
 * The conformance job tests the SDK against a real Ollama server. Two places
 * name the server version: the job's installer pin and the drift watch's
 * comparator. They used to disagree (the job installed the latest stable while
 * the drift report compared against v0.40.0), so the drift report described a
 * server that CI never ran. These assertions keep the two in lockstep.
 */
describe('conformance Ollama pin', () => {
  const ciText = readFileSync(CI_PATH, 'utf8');
  const driftText = readFileSync(DRIFT_PATH, 'utf8');

  // The conformance job is the one that runs `npm run test:conformance`.
  const conformanceJob = ciText.slice(
    ciText.indexOf('  conformance:'),
    ciText.indexOf('  benchmarks:'),
  );

  it('the conformance job pins the Ollama installer to an explicit version', () => {
    expect(conformanceJob).toMatch(/OLLAMA_VERSION=\d+\.\d+\.\d+ sh/);
  });

  it('the pinned installer version equals the drift watch comparator', () => {
    const installed = conformanceJob.match(/OLLAMA_VERSION=(\d+\.\d+\.\d+)/)?.[1];
    const comparator = driftText.match(/CONFORMANCE_OLLAMA_VERSION = 'v(\d+\.\d+\.\d+)'/)?.[1];
    expect(installed).toBeDefined();
    expect(comparator).toBe(installed);
  });

  it('the job asserts the installed version equals the pin', () => {
    expect(conformanceJob).toMatch(/if \[ "\$VERSION" != "\d+\.\d+\.\d+" \]/);
  });

  it('the job no longer downloads a raw Ollama binary from GitHub releases', () => {
    // That fallback pointed at a release asset that does not exist under that name.
    expect(conformanceJob).not.toMatch(/releases\/download\/v[\d.]+\/ollama-linux-amd64/);
  });
});
