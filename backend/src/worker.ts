import { env } from './config/env';
import { logger } from './lib/logger';

/**
 * Worker process entry — a SEPARATE process from server.ts. This is where the
 * BullMQ Worker, the four send-gates, and the boot reconciler will live
 * (Phases 4–5). Keeping it out of the HTTP process is what makes the
 * "kill the worker, restart, watch the schedule rebuild" demo meaningful.
 *
 * For Phase 0 it only validates env at boot so the scaffold is runnable.
 */
async function main(): Promise<void> {
  logger.info(
    { concurrency: env.WORKER_CONCURRENCY, env: env.NODE_ENV },
    'Worker boot — queue + reconciler arrive in Phases 4–5',
  );
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Worker failed to start');
  process.exit(1);
});
