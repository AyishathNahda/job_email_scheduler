import { Queue } from 'bullmq';
import { env } from '../config/env';
import { newRedis } from './connection';

/**
 * The single work queue: one BullMQ job per EmailJob row, scheduled with a
 * delay so it becomes ready at its planned send time. BullMQ delayed jobs ARE
 * the scheduler — there is no cron, no polling loop, no setInterval driving
 * sends.
 *
 * The job id is a pure function of the row id (`email-{id}`), which is the
 * linchpin of recovery: re-adding a job with an existing id is a no-op, so the
 * reconciler can blindly re-enqueue anything it thinks is missing without
 * risking duplicates, and a half-finished enqueue is safe to retry. (BullMQ
 * forbids ':' in custom ids since it delimits internal keys, hence the hyphen.)
 */
export const EMAIL_QUEUE_NAME = 'email-send';

/** The payload carried by each job. Intentionally minimal: just the row id. */
export interface EmailJobData {
  emailJobId: string;
}

/** A row that needs enqueuing, with the absolute time it should fire. */
export interface PlannedEmailJob {
  emailJobId: string;
  scheduledAt: Date;
}

/** Deterministic BullMQ job id for an EmailJob row. */
export function emailJobKey(emailJobId: string): string {
  return `email-${emailJobId}`;
}

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection: newRedis(),
  defaultJobOptions: {
    attempts: env.EMAIL_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: env.EMAIL_JOB_BACKOFF_MS },
    // MySQL is the source of truth for history, so BullMQ only keeps a small
    // recent tail for debugging/introspection.
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

/** How many jobs to push per addBulk call, to keep each Redis command bounded. */
const ENQUEUE_CHUNK_SIZE = 1000;

/**
 * Enqueue planned jobs as BullMQ delayed jobs. Idempotent by construction: the
 * deterministic job id means any job already present is silently skipped, so
 * this is safe to call again after a partial failure (the reconciler relies on
 * that).
 *
 * @param nowMs reference "now" for computing relative delays; defaults to the
 *              wall clock. Injectable so tests are deterministic.
 */
export async function enqueueEmailJobs(
  jobs: readonly PlannedEmailJob[],
  nowMs: number = Date.now(),
): Promise<void> {
  for (let i = 0; i < jobs.length; i += ENQUEUE_CHUNK_SIZE) {
    const chunk = jobs.slice(i, i + ENQUEUE_CHUNK_SIZE);
    await emailQueue.addBulk(
      chunk.map((job) => ({
        name: 'send',
        data: { emailJobId: job.emailJobId },
        opts: {
          jobId: emailJobKey(job.emailJobId),
          // Relative delay; clamps to 0 for anything already due (e.g. a
          // start time in the past means "send as soon as possible").
          delay: Math.max(0, job.scheduledAt.getTime() - nowMs),
        },
      })),
    );
  }
}

/** Close the queue's Redis connection. Called on graceful shutdown. */
export async function closeQueue(): Promise<void> {
  await emailQueue.close();
}
