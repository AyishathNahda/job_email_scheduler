import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the monorepo-root `.env` so NEXT_PUBLIC_* variables defined there reach
 * the browser bundle. Next only auto-loads `.env` from this (frontend)
 * directory, but the project keeps a single root `.env`; we pull it in here at
 * config-eval time — before Next inlines NEXT_PUBLIC_ values. `loadEnvFile` does
 * not overwrite variables already set, so a CI-injected value still wins.
 * No-op if the file is absent.
 */
const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');
try {
  process.loadEnvFile(rootEnv);
} catch {
  // .env is optional in environments that inject the variables directly.
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
