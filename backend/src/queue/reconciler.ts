import type { Redis } from 'ioredis';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { EMAIL_QUEUE_NAME, emailJobKey, enqueueEmailJobs, type PlannedEmailJob } from './emailQueue';

/**
 * Boot-time reconciliation between MySQL (source of truth) and BullMQ (Redis).
 *
 * This runs ONCE when the worker starts — it is NOT a polling loop, cron, or
 * setInterval. Its job is to repair the two ways the two stores can drift out of
 * sync after a crash:
 *
 *   1. Missing schedules — a row is SCHEDULED in MySQL but has no BullMQ job
 *      (e.g. the process died between the DB commit and the enqueue in
 *      campaignService, or Redis lost data). We re-enqueue it. Safe because the
 *      job id is deterministic, so re-adding an existing job is a no-op.
 *
 *   2. Stranded processing — a row is PROCESSING but its worker was hard-killed
 *      mid-send. We cannot tell whether SMTP had already accepted the message,
 *      and there is no exactly-once handshake with a third-party SMTP server, so
 *      re-sending risks a duplicate. Once such a row is older than
 *      STALE_PROCESSING_THRESHOLD_MS we mark it FAILED ("interrupted-processing")
 *      — deliberately preferring a possible lost send over a possible duplicate.
 *
 * Existence is checked with a single pipelined EXISTS per row against the job
 * hash key (`bull:{queue}:{jobId}`), never a getJob-per-row round-trip.
 */

export interface ReconcileReport {
  scheduledScanned: number;
  requeued: number;
  staleFailed: number;
}

/** Bound the size of each findMany / pipeline / addBulk batch. */
const SCAN_CHUNK_SIZE = 5000;

export async function reconcile(redis: Redis, nowMs: number = Date.now()): Promise<ReconcileReport> {
  const staleFailed = await failStaleProcessing(nowMs);
  const { scheduledScanned, requeued } = await requeueMissingScheduled(redis, nowMs);

  const report: ReconcileReport = { scheduledScanned, requeued, staleFailed };
  logger.info(report, 'Reconciler complete');
  return report;
}

/**
 * Mark PROCESSING rows that have been stranded longer than the stale threshold
 * as FAILED. Conservative by design: we never resurrect them, to avoid a
 * duplicate cold send.
 */
async function failStaleProcessing(nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - env.STALE_PROCESSING_THRESHOLD_MS);
  const result = await prisma.emailJob.updateMany({
    where: {
      status: 'PROCESSING',
      // A row claimed but never stamped shouldn't exist, but treat a null
      // processingStartedAt as stale too rather than leaving it stuck forever.
      OR: [{ processingStartedAt: { lt: cutoff } }, { processingStartedAt: null }],
    },
    data: { status: 'FAILED', error: 'interrupted-processing: worker died mid-send' },
  });
  if (result.count > 0) {
    logger.warn({ count: result.count }, 'Reconciler failed stale PROCESSING jobs');
  }
  return result.count;
}

/**
 * Re-enqueue SCHEDULED rows whose BullMQ job is missing. Chunked so a very large
 * backlog neither loads every row at once nor issues one Redis command per row.
 */
async function requeueMissingScheduled(
  redis: Redis,
  nowMs: number,
): Promise<{ scheduledScanned: number; requeued: number }> {
  let scheduledScanned = 0;
  let requeued = 0;
  let cursor: string | undefined;

  // Keyset pagination over the primary key keeps memory flat for huge backlogs.
  for (;;) {
    const rows = await prisma.emailJob.findMany({
      where: { status: 'SCHEDULED', ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, scheduledAt: true },
      orderBy: { id: 'asc' },
      take: SCAN_CHUNK_SIZE,
    });
    if (rows.length === 0) break;
    scheduledScanned += rows.length;
    cursor = rows[rows.length - 1]!.id;

    // One pipelined EXISTS per row against its deterministic job hash key.
    const pipeline = redis.pipeline();
    for (const row of rows) {
      pipeline.exists(`bull:${EMAIL_QUEUE_NAME}:${emailJobKey(row.id)}`);
    }
    const results = await pipeline.exec();

    const missing: PlannedEmailJob[] = [];
    rows.forEach((row, i) => {
      // pipeline.exec() → [[err, reply], ...]; reply 0 means the job is gone.
      const reply = results?.[i]?.[1];
      if (reply === 0) missing.push({ emailJobId: row.id, scheduledAt: row.scheduledAt });
    });

    if (missing.length > 0) {
      await enqueueEmailJobs(missing, nowMs);
      requeued += missing.length;
    }

    if (rows.length < SCAN_CHUNK_SIZE) break;
  }

  if (requeued > 0) {
    logger.warn({ requeued, scheduledScanned }, 'Reconciler re-enqueued missing scheduled jobs');
  }
  return { scheduledScanned, requeued };
}
