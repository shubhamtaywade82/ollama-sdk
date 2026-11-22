import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@nemesis-oss/ollama-sdk': path.resolve(import.meta.dirname, '../../dist/index.js'),
    },
  },
});
