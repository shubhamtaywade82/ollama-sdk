import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { emitSchemaRegistry } from '../../generator/emitters/typescript/schema-registry.js';
import { normalizeContract } from '../../generator/normalize/contract-normalizer.js';
import { requestSchemas, getRequestSchema } from '../../src/generated/runtime/schema-registry.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');

/**
 * Wave 12 (P1 #6): the runtime schema-registry is now generated from the
 * canonical IR. Previously hand-maintained, which meant new operations
 * could be added to the IR without their schema being registered —
 * silently disabling request validation for those operations.
 *
 * These tests pin the generated registry's contract:
 *   - Every operation whose IR entry carries `request.$ref` appears.
 *   - Operations without a request schema do NOT appear (the runtime
 *     skips validation for them by design).
 *   - The generated file's contents match what the emitter produces
 *     from the live IR (catches drift if someone hand-edits the file).
 */
describe('Wave 12: schema-registry is generated from the IR', () => {
  const contract = normalizeContract(PROJECT_ROOT, { write: false });

  it('the generated registry includes every operation with a request schema', () => {
    const expected = contract.operations
      .filter((op) => op.request?.$ref)
      .map((op) => op.id)
      .sort();
    const actual = Object.keys(requestSchemas).sort();
    expect(actual).toEqual(expected);
  });

  it('systemOne is registered (it was missing from the hand-maintained version)', () => {
    expect(requestSchemas.systemOne).toBeDefined();
    expect(getRequestSchema('systemOne')).toBeDefined();
  });

  it('chat, generate, embed, show are all registered', () => {
    expect(getRequestSchema('chat')).toBeDefined();
    expect(getRequestSchema('generate')).toBeDefined();
    expect(getRequestSchema('embed')).toBeDefined();
    expect(getRequestSchema('show')).toBeDefined();
  });

  it('operations without a request schema return undefined (validation is skipped)', () => {
    // GET/HEAD operations have no request body schema in the IR.
    expect(getRequestSchema('version')).toBeUndefined();
    expect(getRequestSchema('tags')).toBeUndefined();
    expect(getRequestSchema('ps')).toBeUndefined();
    expect(getRequestSchema('blobs')).toBeUndefined();
    expect(getRequestSchema('openaiModels')).toBeUndefined();
    // OpenAI/Anthropic compat operations don't have IR schema refs yet.
    expect(getRequestSchema('openaiChatCompletions')).toBeUndefined();
    expect(getRequestSchema('anthropicMessages')).toBeUndefined();
  });

  it('the committed registry file matches what the emitter produces from the live IR', () => {
    // Regenerate the file content from the current IR and compare against
    // the committed file. Drift here means someone hand-edited the
    // generated file, or the generator changed without re-running
    // `npm run contract:generate`.
    const fresh = emitSchemaRegistry('src/generated/runtime', contract.operations);
    const committed = readFileSync(
      resolve(PROJECT_ROOT, 'src/generated/runtime/schema-registry.ts'),
      'utf8',
    );
    expect(committed).toBe(fresh.content);
  });
});
