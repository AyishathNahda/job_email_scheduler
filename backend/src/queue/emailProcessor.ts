import type { Redis } from 'ioredis';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { sendEmail } from '../lib/mailer';
import { prisma } from '../lib/prisma';
import type { EmailJobData } from './emailQueue';
import { checkSenderRateLimit } from './rateLimiter';

/**
 * The heart of the worker: turning one BullMQ job into (at most) one sent email,
 * durably and without duplicates.
 *
 * Four gates run in order. The ORDER is the correctness argument:
 *
 *   1. LOAD         — read the row + its sender/campaign. Bail early if the row
 *                     is gone, cancelled, or already sent.
 *   2. ATOMIC CLAIM — flip SCHEDULED→PROCESSING with a single conditional UPDATE
 *                     (compare-and-swap). This is the ONLY duplicate-send guard:
 *                     if two workers (or a retry racing a stalled re-run) touch
 *                     the same row, exactly one wins the CAS; the loser sees
 *                     count === 0 and does nothing. Claiming BEFORE the rate
 *                     check means quota is only ever consumed by the worker that
 *                     actually owns the send.
 *   3. RATE LIMIT   — per-sender Redis check. If denied, roll the claim back to
 *                     SCHEDULED and defer THIS job (moveToDelayed); deferring one
 *                     sender's job never blocks another sender's jobs.
 *   4. SEND         — hand the message to SMTP and record the result.
 *
 * On SMTP acceptance we record SENT. Note carefully: SMTP *acceptance* is not
 * final delivery, and a worker can be killed after SMTP accepts but before this
 * row is updated. That gap is exactly why this system provides durable,
 * idempotent processing with strong duplicate-send protection — NOT
 * exactly-once external delivery, which is impossible against a third-party SMTP
 * server. The conservative recovery choice (see the reconciler) is to prefer a
 * possible lost send over a possible duplicate.
 */

/** Truncate stored error text so a pathological SMTP error can't bloat a row. */
const MAX_ERROR_LEN = 2000;

/**
 * The slice of a BullMQ `Job` this processor needs. A real `Job` satisfies it
 * structurally; tests can pass a lightweight stub.
 */
export interface ProcessableJob {
  data: EmailJobData;
  /** Completed (finished) attempts so far — 0 on the first run. Rate-limit
   *  deferrals do NOT increment this, so it is the reliable basis for the
   *  retry-vs-terminal decision. */
  attemptsMade: number;
  opts: { attempts?: number };
  /** Reschedule this job to an absolute epoch-ms timestamp (BullMQ semantics). */
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

export interface ProcessorDeps {
  /** Client used for the per-sender rate-limit Lua script. */
  redis: Redis;
  /** Injectable clock; defaults to the wall clock. */
  now?: () => number;
}

export type ProcessOutcome =
  | { outcome: 'sent'; messageId: string }
  | { outcome: 'failed'; error: string }
  | { outcome: 'skipped'; reason: string };

/**
 * Signals a rate-limit deferral to the worker layer. The worker translates this
 * into BullMQ's `DelayedError` so the job is treated as delayed, not failed
 * (the job was already moved to delayed before this is thrown). Kept internal so
 * this module has no direct BullMQ dependency.
 */
export class RateLimitDeferral extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('rate-limited: deferred');
    this.name = 'RateLimitDeferral';
  }
}

export async function processEmailJob(
  job: ProcessableJob,
  token: string | undefined,
  deps: ProcessorDeps,
): Promise<ProcessOutcome> {
  const now = deps.now ?? Date.now;
  const { emailJobId } = job.data;

  // ── Gate 1: LOAD ─────────────────────────────────────────────────────────
  const row = await prisma.emailJob.findUnique({
    where: { id: emailJobId },
    include: {
      sender: true,
      campaign: { select: { subject: true, bodyHtml: true } },
    },
  });

  if (!row) {
    // The campaign (and its jobs) was deleted out from under us. Nothing to do.
    logger.warn({ emailJobId }, 'EmailJob row not found; dropping job');
    return { outcome: 'skipped', reason: 'row-missing' };
  }
  if (row.status === 'CANCELLED') {
    return { outcome: 'skipped', reason: 'cancelled' };
  }
  if (row.status === 'SENT') {
    // A reconciler re-enqueue (or a stalled re-run) of an already-sent row.
    return { outcome: 'skipped', reason: 'already-sent' };
  }

  // ── Gate 2: ATOMIC CLAIM (SCHEDULED → PROCESSING) ────────────────────────
  const claim = await prisma.emailJob.updateMany({
    where: { id: emailJobId, status: 'SCHEDULED' },
    data: { status: 'PROCESSING', processingStartedAt: new Date(now()), attempts: { increment: 1 } },
  });
  if (claim.count === 0) {
    // Lost the CAS: someone else owns or finished this row. The duplicate-send
    // guard in action — we simply stand down.
    logger.debug({ emailJobId, observedStatus: row.status }, 'Claim lost; another worker owns this job');
    return { outcome: 'skipped', reason: 'not-claimed' };
  }

  // ── Gate 3: RATE LIMIT (per-sender, atomic in Redis) ─────────────────────
  const maxPerHour = row.sender.maxPerHour ?? env.MAX_EMAILS_PER_HOUR_PER_SENDER;
  const decision = await checkSenderRateLimit(deps.redis, row.senderId, {
    maxPerHour,
    minGapMs: env.MIN_DELAY_MS_BETWEEN_EMAILS,
    nowMs: now(),
  });
  if (!decision.allowed) {
    // Release the claim so the row is re-claimable, then defer this job. Quota
    // was NOT consumed (the limiter only mutates on allow), so nothing leaks.
    await prisma.emailJob.updateMany({
      where: { id: emailJobId, status: 'PROCESSING' },
      data: { status: 'SCHEDULED', processingStartedAt: null },
    });
    const retryAfterMs = Math.max(1, decision.retryAfterMs);
    await job.moveToDelayed(now() + retryAfterMs, token);
    logger.debug(
      { emailJobId, senderId: row.senderId, retryAfterMs },
      'Per-sender rate limit hit; job deferred',
    );
    throw new RateLimitDeferral(retryAfterMs);
  }

  // ── Gate 4: SEND ─────────────────────────────────────────────────────────
  try {
    const result = await sendEmail(
      {
        smtpHost: row.sender.smtpHost,
        smtpPort: row.sender.smtpPort,
        smtpUser: row.sender.smtpUser,
        smtpPass: row.sender.smtpPass,
        fromEmail: row.sender.fromEmail,
        fromName: row.sender.fromName,
      },
      {
        to: row.toEmail,
        toName: row.toName,
        subject: row.campaign.subject,
        html: row.campaign.bodyHtml,
      },
    );

    // SMTP accepted the message. Record it as SENT (source of truth).
    await prisma.emailJob.update({
      where: { id: emailJobId },
      data: {
        status: 'SENT',
        sentAt: new Date(now()),
        messageId: result.messageId,
        previewUrl: result.previewUrl,
        error: null,
      },
    });
    await maybeFinalizeCampaign(row.campaignId);
    logger.debug({ emailJobId, messageId: result.messageId }, 'Email sent');
    return { outcome: 'sent', messageId: result.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const totalAttempts = job.opts.attempts ?? env.EMAIL_JOB_ATTEMPTS;
    // attemptsMade is prior *finished* attempts; this run is attempt N = +1.
    const isLastAttempt = job.attemptsMade + 1 >= totalAttempts;

    if (!isLastAttempt) {
      // Transient failure with retries left: return the row to SCHEDULED so the
      // retry's atomic claim can re-acquire it, then rethrow so BullMQ applies
      // its backoff and re-runs this same job id.
      await prisma.emailJob.updateMany({
        where: { id: emailJobId, status: 'PROCESSING' },
        data: { status: 'SCHEDULED', processingStartedAt: null, error: message.slice(0, MAX_ERROR_LEN) },
      });
      logger.warn({ emailJobId, attempt: job.attemptsMade + 1, totalAttempts, err: message }, 'Send failed; will retry');
      throw err;
    }

    // Out of attempts: terminal failure. Record it and return normally so BullMQ
    // considers the job done (MySQL, not BullMQ, is the record of the failure).
    await prisma.emailJob.update({
      where: { id: emailJobId },
      data: { status: 'FAILED', error: message.slice(0, MAX_ERROR_LEN) },
    });
    await maybeFinalizeCampaign(row.campaignId);
    logger.warn({ emailJobId, totalAttempts, err: message }, 'Send failed permanently');
    return { outcome: 'failed', error: message };
  }
}

/**
 * Roll the parent campaign's status forward based on its jobs. Cheap in the hot
 * path: a single indexed COUNT of still-pending jobs, and only when none remain
 * do we do the final COMPLETED/PARTIALLY_FAILED classification.
 */
async function maybeFinalizeCampaign(campaignId: string): Promise<void> {
  const pending = await prisma.emailJob.count({
    where: { campaignId, status: { in: ['SCHEDULED', 'PROCESSING'] } },
  });

  if (pending > 0) {
    // Still in flight. Flip SCHEDULED→PROCESSING exactly once (the guard means
    // later calls match zero rows and write nothing).
    await prisma.campaign.updateMany({
      where: { id: campaignId, status: 'SCHEDULED' },
      data: { status: 'PROCESSING' },
    });
    return;
  }

  // Every job reached a terminal state. Any failure ⇒ PARTIALLY_FAILED (there is
  // deliberately no all-failed "FAILED" campaign state), else COMPLETED.
  const failed = await prisma.emailJob.count({ where: { campaignId, status: 'FAILED' } });
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: failed > 0 ? 'PARTIALLY_FAILED' : 'COMPLETED' },
  });
}
