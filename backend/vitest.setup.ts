import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vitest global setup — runs before any test module is imported, which matters
 * because config/env.ts validates process.env at import time.
 *
 * We load the repo-root .env so integration tests (rate limiter, reconciler,
 * idempotency) talk to the real Docker MySQL/Redis, then force NODE_ENV=test
 * to quiet logging and flip the isTest flag. loadEnvFile does not overwrite
 * variables already present in the environment, so CI can inject its own.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const rootEnv = path.resolve(here, '../.env');

try {
  process.loadEnvFile(rootEnv);
} catch {
  // .env is optional; a CI environment may provide the variables directly.
}

process.env.NODE_ENV = 'test';
