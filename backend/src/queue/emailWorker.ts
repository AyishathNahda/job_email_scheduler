import { DelayedError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { env } from '../config/env';
import { newRedis } from './connection';
import { EMAIL_QUEUE_NAME, type EmailJobData } from './emailQueue';
import { processEmailJob, RateLimitDeferral } from './emailProcessor';

/**
 * Construct the BullMQ Worker that drains the email queue. Factored out of the
 * process entry point so the worker's exact wiring — concurrency, the global
 * throughput limiter, and the RateLimitDeferral→DelayedError translation — is
 * defined once and reused by both `worker.ts` (the long-running process) and the
 * smoke-test script, with no risk of the two drifting apart.
 *
 * @param opsRedis a connection used by the processor's per-sender rate-limit
 *                 script; the Worker gets its own separate blocking connection.
 */
export function createEmailWorker(opsRedis: Redis): Worker<EmailJobData> {
  return new Worker<EmailJobData>(
    EMAIL_QUEUE_NAME,
    async (job, token) => {
      try {
        return await processEmailJob(job, token, { redis: opsRedis });
      } catch (err) {
        if (err instanceof RateLimitDeferral) {
          // The job was already moved to delayed inside the processor; signal
          // BullMQ that it is delayed (not failed) so no attempt is consumed.
          throw new DelayedError();
        }
        throw err;
      }
    },
    {
      connection: newRedis(),
      concurrency: env.WORKER_CONCURRENCY,
      // Global, queue-wide throughput ceiling (a WORKER option). Per-sender
      // limits are enforced separately inside the processor.
      limiter: { max: env.GLOBAL_MAX_PER_INTERVAL, duration: env.GLOBAL_INTERVAL_MS },
    },
  );
}
