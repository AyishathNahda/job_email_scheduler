import { z } from 'zod';
import { env } from '../config/env';
import { AppError } from '../lib/errors';
import { planSendTime } from '../lib/planner';
import { prisma } from '../lib/prisma';
import { enqueueEmailJobs, type PlannedEmailJob } from '../queue/emailQueue';

/**
 * Campaign creation — turn a request into durable EmailJob rows and scheduled
 * BullMQ jobs.
 *
 * Ordering is deliberate and is the system's core safety property:
 *   1. Validate (never trust the client; re-check sender ownership here).
 *   2. Write Campaign + EmailJob rows to MySQL and COMMIT.  ← source of truth
 *   3. Only then enqueue delayed BullMQ jobs.
 *
 * Writing to the database first means a crash between (2) and (3) leaves rows
 * in a recoverable SCHEDULED state that the worker's boot-time reconciler will
 * re-enqueue. The reverse order could enqueue a send for a row that was never
 * durably recorded. Enqueue is idempotent (deterministic job id), so a partial
 * failure in (3) is safe to leave for the reconciler.
 */

const RecipientSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().max(200).optional(),
});

/** Upper bound on the HTML body, to bound row size and request cost. */
const MAX_BODY_BYTES = 256 * 1024;
/** A campaign may not be scheduled with a spacing longer than a day. */
const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

export const CreateCampaignInputSchema = z.object({
  subject: z.string().trim().min(1, 'subject is required').max(500),
  bodyHtml: z.string().min(1, 'bodyHtml is required').max(MAX_BODY_BYTES, 'bodyHtml is too large'),
  // Accepts an ISO string or Date; a past time simply means "send immediately".
  startAt: z.coerce.date(),
  delayMs: z.coerce.number().int().min(0).max(MAX_DELAY_MS),
  hourlyLimit: z.coerce.number().int().min(1),
  recipients: z.array(RecipientSchema).min(1).max(env.MAX_RECIPIENTS_PER_CAMPAIGN),
  senderIds: z.array(z.string().min(1)).min(1),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

export type CreateCampaignInput = z.infer<typeof CreateCampaignInputSchema>;

export interface CreateCampaignResult {
  id: string;
  status: string;
  totalCount: number;
  startAt: Date;
  delayMs: number;
  hourlyLimit: number;
  firstScheduledAt: Date | null;
  lastScheduledAt: Date | null;
  /** True when an existing campaign was returned via the idempotency key. */
  deduplicated: boolean;
}

/** How many EmailJob rows to insert per createMany call inside the transaction. */
const INSERT_CHUNK_SIZE = 5000;

/**
 * Create a campaign for `userId`. Input must already be parsed with
 * {@link CreateCampaignInputSchema}; sender ownership is verified here because
 * it needs the database and the authenticated user.
 */
export async function createCampaign(
  userId: string,
  input: CreateCampaignInput,
): Promise<CreateCampaignResult> {
  // ── Idempotency short-circuit ───────────────────────────────────────────
  // If the client replays a request with the same key, return the original
  // campaign instead of creating a duplicate. The unique index is the real
  // guard against races; this is just the fast path.
  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(userId, input.idempotencyKey);
    if (existing) return existing;
  }

  // ── Verify senders belong to the caller and are active ──────────────────
  const senderIds = [...new Set(input.senderIds)];
  const senders = await prisma.sender.findMany({
    where: { id: { in: senderIds }, userId, isActive: true },
    select: { id: true },
  });
  const foundIds = new Set(senders.map((s) => s.id));
  const missing = senderIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw AppError.validation('One or more senders are unknown or inactive', { senderIds: missing });
  }

  // ── Normalise + dedupe recipients ───────────────────────────────────────
  // Emails are case-insensitive; lowercasing also matches the @@unique(
  // campaignId, toEmail) constraint so duplicates in the upload never collide
  // at insert time.
  const seen = new Set<string>();
  const recipients: { email: string; name: string | null }[] = [];
  for (const r of input.recipients) {
    const email = r.email.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    const name = r.name?.trim();
    recipients.push({ email, name: name ? name : null });
  }

  // ── Apply operator-wide policy floors/ceilings ──────────────────────────
  // The campaign's own knobs are bounded by the global env limits, and the
  // per-email spacing can never dip below the operator's minimum. The values
  // actually used are persisted on the campaign so the schedule is auditable.
  const effectiveDelayMs = Math.max(input.delayMs, env.MIN_DELAY_MS_BETWEEN_EMAILS);
  const effectiveHourlyLimit = Math.min(input.hourlyLimit, env.MAX_EMAILS_PER_HOUR);

  // ── Plan each job's send time and round-robin its sender ────────────────
  const plannedRows = recipients.map((r, sequenceNumber) => ({
    senderId: senderIds[sequenceNumber % senderIds.length] as string,
    toEmail: r.email,
    toName: r.name,
    sequenceNumber,
    scheduledAt: planSendTime(input.startAt, sequenceNumber, effectiveDelayMs, effectiveHourlyLimit),
  }));

  // ── Write campaign + jobs atomically ────────────────────────────────────
  let campaignId: string;
  try {
    campaignId = await prisma.$transaction(
      async (txn) => {
        const campaign = await txn.campaign.create({
          data: {
            userId,
            subject: input.subject,
            bodyHtml: input.bodyHtml,
            startAt: input.startAt,
            delayMs: effectiveDelayMs,
            hourlyLimit: effectiveHourlyLimit,
            totalCount: recipients.length,
            idempotencyKey: input.idempotencyKey ?? null,
          },
          select: { id: true },
        });

        for (let i = 0; i < plannedRows.length; i += INSERT_CHUNK_SIZE) {
          const chunk = plannedRows.slice(i, i + INSERT_CHUNK_SIZE);
          await txn.emailJob.createMany({
            data: chunk.map((row) => ({ campaignId: campaign.id, ...row })),
          });
        }
        return campaign.id;
      },
      // Generous window: a large campaign inserts tens of thousands of rows.
      { timeout: 30_000, maxWait: 10_000 },
    );
  } catch (err) {
    // Lost an idempotency-key race: another request with the same key committed
    // first. Return that campaign rather than surfacing a raw unique violation.
    if (isUniqueViolation(err) && input.idempotencyKey) {
      const existing = await findByIdempotencyKey(userId, input.idempotencyKey);
      if (existing) return existing;
    }
    throw err;
  }

  // ── Enqueue AFTER commit (idempotent; reconciler is the backstop) ───────
  // createMany does not return ids, so read them back (ordered by sequence to
  // match insertion order) and pair each with its planned time.
  const inserted = await prisma.emailJob.findMany({
    where: { campaignId },
    select: { id: true, scheduledAt: true },
    orderBy: { sequenceNumber: 'asc' },
  });
  const planned: PlannedEmailJob[] = inserted.map((row) => ({
    emailJobId: row.id,
    scheduledAt: row.scheduledAt,
  }));
  await enqueueEmailJobs(planned);

  const first = plannedRows[0]?.scheduledAt ?? null;
  const last = plannedRows[plannedRows.length - 1]?.scheduledAt ?? null;
  return {
    id: campaignId,
    status: 'SCHEDULED',
    totalCount: recipients.length,
    startAt: input.startAt,
    delayMs: effectiveDelayMs,
    hourlyLimit: effectiveHourlyLimit,
    firstScheduledAt: first,
    lastScheduledAt: last,
    deduplicated: false,
  };
}

async function findByIdempotencyKey(
  userId: string,
  idempotencyKey: string,
): Promise<CreateCampaignResult | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    select: {
      id: true,
      status: true,
      totalCount: true,
      startAt: true,
      delayMs: true,
      hourlyLimit: true,
    },
  });
  if (!campaign) return null;

  const bounds = await scheduledBounds(campaign.id);
  return {
    id: campaign.id,
    status: campaign.status,
    totalCount: campaign.totalCount,
    startAt: campaign.startAt,
    delayMs: campaign.delayMs,
    hourlyLimit: campaign.hourlyLimit,
    firstScheduledAt: bounds.first,
    lastScheduledAt: bounds.last,
    deduplicated: true,
  };
}

async function scheduledBounds(campaignId: string): Promise<{ first: Date | null; last: Date | null }> {
  const [min, max] = await Promise.all([
    prisma.emailJob.findFirst({
      where: { campaignId },
      orderBy: { scheduledAt: 'asc' },
      select: { scheduledAt: true },
    }),
    prisma.emailJob.findFirst({
      where: { campaignId },
      orderBy: { scheduledAt: 'desc' },
      select: { scheduledAt: true },
    }),
  ]);
  return { first: min?.scheduledAt ?? null, last: max?.scheduledAt ?? null };
}

/** Prisma P2002 = unique constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2002'
  );
}
