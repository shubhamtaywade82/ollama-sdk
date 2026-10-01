import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync } from 'node:fs';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    skills: 'src/skills/index.ts',
    'mcp-stdio': 'src/mcp/stdio.ts',
    'mcp-http': 'src/mcp/http.ts',
    // Contract-first generated surface (ADRs 0013-0019):
    'generated-runtime': 'src/generated/runtime/index.ts',
    'generated-api': 'src/generated/api/index.ts',
    'generated-models-schemas': 'src/generated/models/schemas.ts',
    'mcp-generated': 'src/mcp/generated-bridge.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'node20',
  // Copy the MCP tools.json (the Wave 6 generated artifact) into dist/ so
  // the published package can load it. tsup doesn't copy non-TS assets by
  // default; the loader resolves this file at runtime relative to its own
  // location (see src/mcp/generated-bridge.ts).
  async onSuccess() {
    mkdirSync('dist/mcp', { recursive: true });
    copyFileSync('src/generated/mcp/tools.json', 'dist/mcp/tools.json');
    console.log('✓ Copied src/generated/mcp/tools.json → dist/mcp/tools.json');
  },
});
