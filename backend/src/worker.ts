import { DelayedError } from 'bullmq';
import { env } from './config/env';
import { logger } from './lib/logger';
import { closeTransports } from './lib/mailer';
import { prisma } from './lib/prisma';
import { closeQueue } from './queue/emailQueue';
import { createEmailWorker } from './queue/emailWorker';
import { reconcile } from './queue/reconciler';
import { newRedis } from './queue/connection';

/**
 * Worker process entry — a SEPARATE process from the HTTP server. Keeping the
 * queue consumer out of the API process is what makes the reliability story
 * demonstrable: kill THIS process mid-run, restart it, and the boot reconciler
 * rebuilds the schedule from MySQL without losing or duplicating work.
 *
 * The scheduler is BullMQ's delayed-jobs mechanism alone — there is no cron, no
 * polling loop, and no setInterval driving sends anywhere in this process.
 */

async function main(): Promise<void> {
  // A dedicated connection for the per-sender rate-limit Lua script and the
  // reconciler's EXISTS probes — kept separate from the Worker's own blocking
  // connection so neither stalls the other.
  const opsRedis = newRedis();

  // ── Boot-time reconciliation (once, not a loop) ─────────────────────────
  logger.info('Worker booting — running reconciler');
  await reconcile(opsRedis);

  // ── The BullMQ Worker ───────────────────────────────────────────────────
  const worker = createEmailWorker(opsRedis);

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'Job completed');
  });
  worker.on('failed', (job, err) => {
    // A DelayedError surfaces here as the job being re-delayed; ignore it.
    if (err instanceof DelayedError) return;
    logger.error({ jobId: job?.id, err: err.message }, 'Job failed');
  });
  worker.on('error', (err) => {
    logger.error({ err: err.message }, 'Worker error');
  });

  logger.info(
    {
      concurrency: env.WORKER_CONCURRENCY,
      globalLimit: `${env.GLOBAL_MAX_PER_INTERVAL}/${env.GLOBAL_INTERVAL_MS}ms`,
    },
    'Worker ready',
  );

  // ── Graceful shutdown ───────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Worker shutting down');
    try {
      // Stop consuming and let in-flight jobs finish (close waits for them).
      await worker.close();
      await closeQueue();
      closeTransports();
      await opsRedis.quit();
      await prisma.$disconnect();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Worker failed to start');
  process.exit(1);
});
