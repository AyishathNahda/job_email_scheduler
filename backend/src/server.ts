import { env } from './config/env';
import { buildApp } from './http/app';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { newRedis } from './queue/connection';
import { closeQueue } from './queue/emailQueue';

/**
 * API process entry. Deliberately separate from worker.ts: the HTTP layer never
 * runs scheduling logic, and the two scale independently. This file owns exactly
 * the things a test's buildApp() must not — the listening socket, the health
 * check's Redis client, and graceful shutdown.
 */
const opsRedis = newRedis();
const app = buildApp({ redis: opsRedis });

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'API shutting down');

    // Stop accepting connections, then release every held resource. The API
    // imports the queue module (campaign creation enqueues), so its Redis
    // connection must be closed here too or the process would hang on exit.
    server.close(() => {
      void (async () => {
        try {
          await closeQueue();
          await opsRedis.quit();
          await prisma.$disconnect();
        } catch (err) {
          logger.error({ err }, 'error during API shutdown');
        } finally {
          process.exit(0);
        }
      })();
    });
  });
}
