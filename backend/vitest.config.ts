import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/__tests__/**/*.test.ts'],
    // Loads repo-root .env and forces NODE_ENV=test before any module (and thus
    // config/env.ts) is imported.
    setupFiles: ['./vitest.setup.ts'],
    // Rate-limiter and idempotency tests hit real Redis/MySQL and mutate shared
    // keys/rows, so they must not run in parallel against each other.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
