import express from 'express';
import { env } from './config/env';
import { logger } from './lib/logger';

/**
 * API process entry. Deliberately separate from worker.ts: the HTTP layer never
 * runs scheduling logic, and the two scale independently. Fleshed out in later
 * phases (auth, campaigns, emails, senders). For now it validates env at boot
 * and exposes a liveness probe.
 */
const app = express();

app.get('/healthz', (_req, res) => {
  // Phase 6 upgrades this to actually ping Redis + MySQL.
  res.json({ ok: true, service: 'api' });
});

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
});

// Clean shutdown so nodemon/tsx restarts and container stops don't leak the port.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'API shutting down');
    server.close(() => process.exit(0));
  });
}
