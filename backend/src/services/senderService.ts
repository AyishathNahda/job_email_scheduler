import { z } from 'zod';
import { env } from '../config/env';
import { encrypt } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { type SenderCredentials, verifyTransport } from '../lib/mailer';
import { prisma } from '../lib/prisma';

/**
 * Sender management — the SMTP accounts a user sends through.
 *
 * Two invariants this module enforces:
 *   1. The plaintext SMTP password never leaves this boundary. It is encrypted
 *      with AES-256-GCM on the way in and is never selected back out or returned
 *      to a client — {@link SenderSummary} has no password field, and the read
 *      queries never request the column.
 *   2. Every query is scoped by `userId`, so one user can never see or mutate
 *      another user's senders. Ownership is checked in the same statement, not
 *      as a separate read-then-write that could race.
 */

/** The safe, client-facing view of a sender. Deliberately omits `smtpPass`. */
export interface SenderSummary {
  id: string;
  fromEmail: string;
  fromName: string | null;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  maxPerHour: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Select mask that structurally guarantees `smtpPass` is never read out. */
const senderSelect = {
  id: true,
  fromEmail: true,
  fromName: true,
  smtpHost: true,
  smtpPort: true,
  smtpUser: true,
  maxPerHour: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const PORT_MIN = 1;
const PORT_MAX = 65_535;

export const CreateSenderInputSchema = z.object({
  fromEmail: z.string().trim().email().max(320),
  fromName: z.string().trim().min(1).max(200).optional(),
  smtpHost: z.string().trim().min(1).max(255),
  smtpPort: z.coerce.number().int().min(PORT_MIN).max(PORT_MAX),
  smtpUser: z.string().trim().min(1).max(320),
  smtpPass: z.string().min(1).max(1024),
  // A per-sender hourly cap, bounded by the operator-wide ceiling. Omitted means
  // "fall back to the campaign / global limit" — stored as NULL.
  maxPerHour: z.coerce.number().int().positive().max(env.MAX_EMAILS_PER_HOUR).optional(),
});

export type CreateSenderInput = z.infer<typeof CreateSenderInputSchema>;

// Partial update: any subset of the create fields, plus toggling active state.
// `maxPerHour` is nullable here so a client can explicitly clear an override.
// `.strict()` rejects unknown keys; `.refine` rejects an empty patch.
export const UpdateSenderInputSchema = z
  .object({
    fromEmail: z.string().trim().email().max(320),
    fromName: z.string().trim().min(1).max(200),
    smtpHost: z.string().trim().min(1).max(255),
    smtpPort: z.coerce.number().int().min(PORT_MIN).max(PORT_MAX),
    smtpUser: z.string().trim().min(1).max(320),
    smtpPass: z.string().min(1).max(1024),
    maxPerHour: z.coerce.number().int().positive().max(env.MAX_EMAILS_PER_HOUR).nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'No fields to update' });

export type UpdateSenderInput = z.infer<typeof UpdateSenderInputSchema>;

/** List a user's senders, newest first. Never includes the password. */
export async function listSenders(userId: string): Promise<SenderSummary[]> {
  return prisma.sender.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: senderSelect,
  });
}

/** Create a sender for the user. The SMTP password is encrypted at rest. */
export async function createSender(
  userId: string,
  input: CreateSenderInput,
): Promise<SenderSummary> {
  try {
    return await prisma.sender.create({
      data: {
        userId,
        fromEmail: input.fromEmail.toLowerCase(),
        fromName: input.fromName ?? null,
        smtpHost: input.smtpHost,
        smtpPort: input.smtpPort,
        smtpUser: input.smtpUser,
        smtpPass: encrypt(input.smtpPass),
        maxPerHour: input.maxPerHour ?? null,
      },
      select: senderSelect,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict('A sender with this from-address already exists');
    }
    throw err;
  }
}

/** Update a sender the user owns. Only the provided fields change. */
export async function updateSender(
  userId: string,
  senderId: string,
  input: UpdateSenderInput,
): Promise<SenderSummary> {
  await requireOwnedSender(userId, senderId);

  // Build the patch from only the keys actually present. The password, if being
  // changed, is re-encrypted here; a fresh IV means the ciphertext differs even
  // for an unchanged secret.
  const data: {
    fromEmail?: string;
    fromName?: string | null;
    smtpHost?: string;
    smtpPort?: number;
    smtpUser?: string;
    smtpPass?: string;
    maxPerHour?: number | null;
    isActive?: boolean;
  } = {};
  if (input.fromEmail !== undefined) data.fromEmail = input.fromEmail.toLowerCase();
  if (input.fromName !== undefined) data.fromName = input.fromName;
  if (input.smtpHost !== undefined) data.smtpHost = input.smtpHost;
  if (input.smtpPort !== undefined) data.smtpPort = input.smtpPort;
  if (input.smtpUser !== undefined) data.smtpUser = input.smtpUser;
  if (input.smtpPass !== undefined) data.smtpPass = encrypt(input.smtpPass);
  if (input.maxPerHour !== undefined) data.maxPerHour = input.maxPerHour;
  if (input.isActive !== undefined) data.isActive = input.isActive;

  try {
    return await prisma.sender.update({
      where: { id: senderId },
      data,
      select: senderSelect,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict('A sender with this from-address already exists');
    }
    throw err;
  }
}

/**
 * Deactivate a sender (soft delete). We never hard-delete: EmailJob.senderId is
 * ON DELETE RESTRICT precisely so a sender with send history cannot vanish and
 * orphan the audit trail. Deactivating hides it from new campaigns (createCampaign
 * only accepts active senders) while leaving past jobs intact.
 */
export async function deactivateSender(userId: string, senderId: string): Promise<SenderSummary> {
  await requireOwnedSender(userId, senderId);
  return prisma.sender.update({
    where: { id: senderId },
    data: { isActive: false },
    select: senderSelect,
  });
}

export interface VerifySenderResult {
  ok: true;
}

/**
 * Open a real SMTP connection with the sender's stored credentials and check the
 * handshake, without sending anything. Surfaces bad host/port/credentials as a
 * 400 rather than letting them fail silently at send time.
 */
export async function verifySender(userId: string, senderId: string): Promise<VerifySenderResult> {
  const sender = await prisma.sender.findFirst({
    where: { id: senderId, userId },
    select: {
      fromEmail: true,
      fromName: true,
      smtpHost: true,
      smtpPort: true,
      smtpUser: true,
      smtpPass: true,
    },
  });
  if (!sender) throw AppError.notFound('Sender not found');

  const credentials: SenderCredentials = {
    smtpHost: sender.smtpHost,
    smtpPort: sender.smtpPort,
    smtpUser: sender.smtpUser,
    smtpPass: sender.smtpPass,
    fromEmail: sender.fromEmail,
    fromName: sender.fromName,
  };
  try {
    await verifyTransport(credentials);
    return { ok: true };
  } catch {
    // Do not echo the raw SMTP error (may include host internals); a clear,
    // generic message is enough for the operator to re-check the settings.
    throw AppError.validation('Could not connect to the SMTP server with these credentials');
  }
}

/** Throw 404 unless the sender exists and belongs to the user. */
async function requireOwnedSender(userId: string, senderId: string): Promise<void> {
  const found = await prisma.sender.findFirst({
    where: { id: senderId, userId },
    select: { id: true },
  });
  if (!found) throw AppError.notFound('Sender not found');
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
