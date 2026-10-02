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
 * Wave 12 (P1 #7): Web Search and Web Fetch are officially documented
 * Ollama capability endpoints that live at https://ollama.com/api/...
 * rather than the local Ollama server. Before this wave they were
 * absent from the canonical IR — the SDK supported them via hand-written
 * OllamaClient.webSearch / webFetch methods, but the contract layer had
 * no idea they existed.
 *
 * Bringing them into the IR closes that gap: the bidirectional endpoint
 * discovery validator sees them, the MCP generator can expose them, and
 * the IR inspector lists them. They cannot be invoked through the
 * generated NativeApi class (the runtime is bound to the local Ollama
 * server's HttpClient); callers must use OllamaClient.webSearch /
 * webFetch, which spin up a dedicated cloud HttpClient pointed at the
 * right host.
 */
describe('Wave 12: Web Search / Web Fetch are in the contract', () => {
  it('declares /api/web_search and /api/web_fetch in the IR', () => {
    const ir = loadIR();
    const webSearch = ir.operations.find((op) => op.id === 'webSearch');
    const webFetch = ir.operations.find((op) => op.id === 'webFetch');
    expect(webSearch).toBeDefined();
    expect(webFetch).toBeDefined();
    expect(webSearch?.path).toBe('/api/web_search');
    expect(webFetch?.path).toBe('/api/web_fetch');
    expect(webSearch?.method).toBe('POST');
    expect(webFetch?.method).toBe('POST');
  });

  it('declares the cloud host on both operations', () => {
    const ir = loadIR();
    const webSearch = ir.operations.find((op) => op.id === 'webSearch');
    const webFetch = ir.operations.find((op) => op.id === 'webFetch');
    expect(webSearch?.host).toBe('https://ollama.com');
    expect(webFetch?.host).toBe('https://ollama.com');
  });

  it('marks both as cloud-only (local: unsupported)', () => {
    const ir = loadIR();
    for (const id of ['webSearch', 'webFetch']) {
      const op = ir.operations.find((o) => o.id === id);
      expect(op?.environment.local).toBe(false);
      expect(op?.environment.cloud).toBe(true);
    }
  });

  it('carries request and response schema refs for both operations', () => {
    const ir = loadIR();
    const webSearch = ir.operations.find((op) => op.id === 'webSearch');
    const webFetch = ir.operations.find((op) => op.id === 'webFetch');
    expect(webSearch?.request?.$ref).toBe('#/schemas/WebSearchRequest');
    expect(webSearch?.response?.$ref).toBe('#/schemas/WebSearchResponse');
    expect(webFetch?.request?.$ref).toBe('#/schemas/WebFetchRequest');
    expect(webFetch?.response?.$ref).toBe('#/schemas/WebFetchResponse');
  });

  it('the generated NativeApi class does NOT expose webSearch/webFetch', () => {
    // The generated NativeApi delegates to a runtime bound to the local
    // Ollama server. The web endpoints target a different host, so
    // exposing them on NativeApi would be misleading. Callers must use
    // OllamaClient.webSearch / webFetch instead.
    const nativeApiPath = resolve(PROJECT_ROOT, 'src/generated/api/native-api.ts');
    const source = readFileSync(nativeApiPath, 'utf8');
    expect(source).not.toMatch(/\bwebSearch\b/);
    expect(source).not.toMatch(/\bwebFetch\b/);
  });

  it('the generated operations.ts carries the host field for both ops', () => {
    // The runtime-facing OperationDefinition must include `host` so any
    // future code that consumes operations.ts (e.g. a future cloud-runtime
    // adapter) can dispatch on it.
    const opsPath = resolve(PROJECT_ROOT, 'src/generated/api/operations.ts');
    const source = readFileSync(opsPath, 'utf8');
    expect(source).toMatch(/host:\s*'https:\/\/ollama\.com'/);
  });

  it('the MCP tools.json exposes both web tools', () => {
    const toolsPath = resolve(PROJECT_ROOT, 'src/generated/mcp/tools.json');
    const tools = JSON.parse(readFileSync(toolsPath, 'utf8')) as {
      tools: ReadonlyArray<{ _operationId: string }>;
    };
    const ids = tools.tools.map((t) => t._operationId);
    expect(ids).toContain('webSearch');
    expect(ids).toContain('webFetch');
  });
});
