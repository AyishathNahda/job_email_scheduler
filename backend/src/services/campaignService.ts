import { z } from 'zod';
import { env } from '../config/env';
import { AppError } from '../lib/errors';
import { planSendTime } from '../lib/planner';
import { prisma } from '../lib/prisma';
import { enqueueEmailJobs, type PlannedEmailJob, removeEmailJobs } from '../queue/emailQueue';

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

// ───────────────────────────────────────────────────────────────────────────
// Read + lifecycle operations (dashboard queries and cancellation).
//
// Every function is scoped by userId; a campaign that isn't the caller's is
// indistinguishable from one that doesn't exist (404) — never a 403 that would
// confirm its existence to a stranger.
// ───────────────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const EMAIL_STATUSES = ['SCHEDULED', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED'] as const;
type EmailStatusValue = (typeof EMAIL_STATUSES)[number];

/** Per-status tallies of a campaign's EmailJob rows. */
export interface StatusCounts {
  scheduled: number;
  processing: number;
  sent: number;
  failed: number;
  cancelled: number;
}

function emptyCounts(): StatusCounts {
  return { scheduled: 0, processing: 0, sent: 0, failed: 0, cancelled: 0 };
}

export const ListCampaignsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type ListCampaignsQuery = z.infer<typeof ListCampaignsQuerySchema>;

export const ListJobsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  status: z.enum(EMAIL_STATUSES).optional(),
});
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CampaignListItem {
  id: string;
  subject: string;
  status: string;
  totalCount: number;
  startAt: Date;
  createdAt: Date;
  counts: StatusCounts;
}

/**
 * List a user's campaigns, newest first, with per-status job tallies. Keyset
 * (not offset) pagination on (createdAt, id): stable under concurrent inserts
 * and O(page) no matter how deep the caller scrolls. The cursor is an opaque
 * campaign id resolved back to its (createdAt, id) anchor within the user's own
 * rows, so a cursor pointing at someone else's campaign just yields a fresh
 * first page rather than leaking its existence.
 */
export async function listCampaigns(
  userId: string,
  query: ListCampaignsQuery,
): Promise<Page<CampaignListItem>> {
  const anchor = query.cursor ? await resolveCampaignAnchor(userId, query.cursor) : null;

  const rows = await prisma.campaign.findMany({
    where: {
      userId,
      ...(anchor
        ? {
            OR: [
              { createdAt: { lt: anchor.createdAt } },
              { createdAt: anchor.createdAt, id: { lt: anchor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    select: {
      id: true,
      subject: true,
      status: true,
      totalCount: true,
      startAt: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const counts = await statusCountsByCampaign(page.map((c) => c.id));

  return {
    items: page.map((c) => ({
      id: c.id,
      subject: c.subject,
      status: c.status,
      totalCount: c.totalCount,
      startAt: c.startAt,
      createdAt: c.createdAt,
      counts: counts.get(c.id) ?? emptyCounts(),
    })),
    nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.id : null,
  };
}

export interface CampaignDetail extends CampaignListItem {
  bodyHtml: string;
  delayMs: number;
  hourlyLimit: number;
  updatedAt: Date;
}

/** Full detail for one campaign the user owns, with status tallies. 404 if not. */
export async function getCampaign(userId: string, campaignId: string): Promise<CampaignDetail> {
  const c = await prisma.campaign.findFirst({
    where: { id: campaignId, userId },
    select: {
      id: true,
      subject: true,
      bodyHtml: true,
      status: true,
      totalCount: true,
      startAt: true,
      delayMs: true,
      hourlyLimit: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!c) throw AppError.notFound('Campaign not found');

  const counts = (await statusCountsByCampaign([c.id])).get(c.id) ?? emptyCounts();
  return { ...c, counts };
}

export interface JobListItem {
  id: string;
  senderId: string;
  toEmail: string;
  toName: string | null;
  sequenceNumber: number;
  status: string;
  scheduledAt: Date;
  sentAt: Date | null;
  messageId: string | null;
  previewUrl: string | null;
  error: string | null;
  attempts: number;
}

/**
 * List one campaign's individual EmailJob rows, ordered by send sequence, with
 * an optional status filter. Verifies campaign ownership first (404 otherwise),
 * then keyset-paginates on the campaign-unique sequenceNumber.
 */
export async function getCampaignJobs(
  userId: string,
  campaignId: string,
  query: ListJobsQuery,
): Promise<Page<JobListItem>> {
  await requireOwnedCampaign(userId, campaignId);

  const afterSeq = query.cursor ? await resolveJobAnchor(campaignId, query.cursor) : null;

  const rows = await prisma.emailJob.findMany({
    where: {
      campaignId,
      ...(query.status ? { status: query.status } : {}),
      ...(afterSeq !== null ? { sequenceNumber: { gt: afterSeq } } : {}),
    },
    orderBy: { sequenceNumber: 'asc' },
    take: query.limit + 1,
    select: {
      id: true,
      senderId: true,
      toEmail: true,
      toName: true,
      sequenceNumber: true,
      status: true,
      scheduledAt: true,
      sentAt: true,
      messageId: true,
      previewUrl: true,
      error: true,
      attempts: true,
    },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return {
    items: page,
    nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.id : null,
  };
}

export interface CancelCampaignResult {
  id: string;
  status: 'CANCELLED';
  cancelledCount: number;
}

/**
 * Cancel a campaign. Flips every still-SCHEDULED job to CANCELLED and the
 * campaign to CANCELLED atomically, then removes the corresponding delayed
 * BullMQ jobs (best-effort — the CANCELLED row is the real guard). Already-sent,
 * failed, or in-flight (PROCESSING) jobs are left untouched: cancellation stops
 * future sends, it does not recall mail already handed to SMTP.
 *
 * Idempotent for an already-cancelled campaign; rejects a terminal one
 * (COMPLETED / PARTIALLY_FAILED) since there is nothing left to stop.
 */
export async function cancelCampaign(
  userId: string,
  campaignId: string,
): Promise<CancelCampaignResult> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, userId },
    select: { id: true, status: true },
  });
  if (!campaign) throw AppError.notFound('Campaign not found');
  if (campaign.status === 'CANCELLED') {
    return { id: campaign.id, status: 'CANCELLED', cancelledCount: 0 };
  }
  if (campaign.status === 'COMPLETED' || campaign.status === 'PARTIALLY_FAILED') {
    throw AppError.conflict('Campaign has already finished and cannot be cancelled');
  }

  // Capture the ids to pull from the queue BEFORE flipping status, then flip
  // the jobs and the campaign together in one transaction.
  const toCancel = await prisma.emailJob.findMany({
    where: { campaignId, status: 'SCHEDULED' },
    select: { id: true },
  });

  await prisma.$transaction([
    prisma.emailJob.updateMany({
      where: { campaignId, status: 'SCHEDULED' },
      data: { status: 'CANCELLED' },
    }),
    prisma.campaign.update({ where: { id: campaignId }, data: { status: 'CANCELLED' } }),
  ]);

  await removeEmailJobs(toCancel.map((j) => j.id));

  return { id: campaignId, status: 'CANCELLED', cancelledCount: toCancel.length };
}

// ── internal helpers for the read/lifecycle operations ──────────────────────

async function requireOwnedCampaign(userId: string, campaignId: string): Promise<void> {
  const found = await prisma.campaign.findFirst({
    where: { id: campaignId, userId },
    select: { id: true },
  });
  if (!found) throw AppError.notFound('Campaign not found');
}

async function resolveCampaignAnchor(
  userId: string,
  cursorId: string,
): Promise<{ createdAt: Date; id: string } | null> {
  const row = await prisma.campaign.findFirst({
    where: { id: cursorId, userId },
    select: { createdAt: true, id: true },
  });
  return row ?? null;
}

async function resolveJobAnchor(campaignId: string, cursorId: string): Promise<number | null> {
  const row = await prisma.emailJob.findFirst({
    where: { id: cursorId, campaignId },
    select: { sequenceNumber: true },
  });
  return row?.sequenceNumber ?? null;
}

async function statusCountsByCampaign(
  campaignIds: readonly string[],
): Promise<Map<string, StatusCounts>> {
  const result = new Map<string, StatusCounts>();
  if (campaignIds.length === 0) return result;

  const grouped = await prisma.emailJob.groupBy({
    by: ['campaignId', 'status'],
    where: { campaignId: { in: [...campaignIds] } },
    _count: { _all: true },
  });

  for (const g of grouped) {
    const counts = result.get(g.campaignId) ?? emptyCounts();
    applyStatusCount(counts, g.status, g._count._all);
    result.set(g.campaignId, counts);
  }
  return result;
}

function applyStatusCount(counts: StatusCounts, status: EmailStatusValue, n: number): void {
  switch (status) {
    case 'SCHEDULED':
      counts.scheduled = n;
      break;
    case 'PROCESSING':
      counts.processing = n;
      break;
    case 'SENT':
      counts.sent = n;
      break;
    case 'FAILED':
      counts.failed = n;
      break;
    case 'CANCELLED':
      counts.cancelled = n;
      break;
  }
}
