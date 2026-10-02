import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OllamaContract } from '../../generator/types.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const IR_PATH = resolve(PROJECT_ROOT, 'contracts/ir/ollama.ir.json');

function loadIR(): OllamaContract {
  return JSON.parse(readFileSync(IR_PATH, 'utf8')) as OllamaContract;
}

/**
 * Wave 12 (P1): the IR's top-level version field was previously named
 * `observedOllamaVersion`, which was misleading — the value is the
 * OpenAPI source document's `info.version` (currently "0.1.0"), NOT
 * the Ollama server version. The two concepts are unrelated:
 *
 *   - `sourceVersion` (renamed) = OpenAPI doc version, source-tracking
 *   - server version = what `constraints.minOllamaVersion` is checked
 *     against, obtained at runtime via GET /api/version
 *
 * This rename makes the IR honest about what the field actually carries.
 * The old name is kept (deprecated) for backwards-compat readers.
 */
describe('Wave 12: IR uses sourceVersion (not observedOllamaVersion) for the OpenAPI doc version', () => {
  it('the committed IR carries sourceVersion', () => {
    const ir = loadIR();
    expect(ir.sourceVersion).toBeDefined();
    expect(typeof ir.sourceVersion).toBe('string');
  });

  it('sourceVersion matches the OpenAPI info.version (currently 0.1.0)', () => {
    const ir = loadIR();
    expect(ir.sourceVersion).toBe('0.1.0');
  });

  it('observedOllamaVersion is kept for backwards-compat readers (deprecated)', () => {
    // The old field name is still emitted so older readers don't break,
    // but new readers should prefer sourceVersion. Both fields carry
    // the same value during the migration window.
    const ir = loadIR();
    expect(ir.observedOllamaVersion).toBe(ir.sourceVersion);
  });

  it('sourceVersion is the OpenAPI doc version, not the Ollama server version', () => {
    // This is the bug the rename fixes: callers might assume
    // observedOllamaVersion reflects the actual Ollama server. It
    // doesn't — it's the OpenAPI doc version. The Ollama server version
    // is obtained at runtime via GET /api/version (cached on
    // OllamaRuntime). 0.1.0 is the OpenAPI doc version; Ollama's actual
    // server versions look like 0.35.0, 0.36.0, etc. The pinned value
    // (0.1.0) is suspiciously low for a real Ollama server version,
    // which is the tell that this is a doc version, not a server version.
    const ir = loadIR();
    expect(ir.sourceVersion).toBe('0.1.0');
    // The Ollama server version is NOT in the IR — it's a runtime concept.
    // constraints.minOllamaVersion (e.g. "0.35.0" for systemOne) is the
    // server-side check, obtained via GET /api/version.
    const systemOne = ir.operations.find((op) => op.id === 'systemOne');
    expect(systemOne?.constraints?.minOllamaVersion).toBe('0.35.0');
    // sourceVersion (0.1.0) is different from minOllamaVersion (0.35.0) —
    // proving they're independent concepts that the old name conflated.
    expect(ir.sourceVersion).not.toBe(systemOne?.constraints?.minOllamaVersion);
  });
});
