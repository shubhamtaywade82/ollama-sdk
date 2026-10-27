import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      // Ratchet floors, enforced by the CI `coverage` job (npm run
      // test:coverage). Measured 2026-10-27 at statements 87.7 / branches
      // 78.6 / functions 87.1 / lines 89.2 — the floors sit ~2-3 points
      // under the baseline so ordinary churn doesn't trip them, but a real
      // coverage regression fails CI instead of drifting silently. Raise
      // them when the baseline moves; never lower them without a stated
      // reason.
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 85,
        lines: 87,
      },
    },
  },
});
