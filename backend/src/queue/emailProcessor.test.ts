import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { encrypt } from '../lib/crypto';
import { prisma } from '../lib/prisma';
import { newRedis } from './connection';
import { processEmailJob, RateLimitDeferral, type ProcessableJob } from './emailProcessor';

/**
 * Integration test against real MySQL + Redis, with SMTP mocked so no mail is
 * actually sent. Proves the four gates — most importantly that the atomic
 * SCHEDULED→PROCESSING claim makes double-sends impossible even under
 * concurrency.
 */

vi.mock('../lib/mailer', () => ({
  sendEmail: vi.fn(async () => ({ messageId: 'mock-message-id', previewUrl: 'https://preview/mock' })),
  verifyTransport: vi.fn(async () => {}),
  closeTransports: vi.fn(() => {}),
}));
// Imported AFTER the mock so this is the mocked fn.
import { sendEmail } from '../lib/mailer';
const mockedSend = vi.mocked(sendEmail);

const redis: Redis = newRedis();
const TEST_EMAIL = 'processor-test@reachinbox.test';

let userId: string;
let senderId: string;
let blockedSenderId: string; // maxPerHour = 0 → every send is rate-limited

function fakeJob(emailJobId: string, over: Partial<ProcessableJob> = {}) {
  const moveToDelayed = vi.fn(async (_ts: number, _token?: string) => {});
  const job: ProcessableJob = {
    data: { emailJobId },
    attemptsMade: 0,
    opts: { attempts: 3 },
    moveToDelayed,
    ...over,
  };
  return { job, moveToDelayed };
}

async function createRow(status: 'SCHEDULED' | 'SENT', useSender = senderId): Promise<string> {
  const campaign = await prisma.campaign.create({
    data: {
      userId,
      subject: 'Subject',
      bodyHtml: '<p>Body</p>',
      startAt: new Date(),
      delayMs: 0,
      hourlyLimit: 100,
      totalCount: 1,
    },
    select: { id: true },
  });
  const job = await prisma.emailJob.create({
    data: {
      campaignId: campaign.id,
      senderId: useSender,
      toEmail: 'recipient@example.com',
      sequenceNumber: 0,
      scheduledAt: new Date(),
      status,
    },
    select: { id: true },
  });
  return job.id;
}

async function wipeRateKeys(): Promise<void> {
  const keys = [...(await redis.keys('rl:*')), ...(await redis.keys('gap:*'))].filter((k) =>
    k.includes(senderId) || k.includes(blockedSenderId),
  );
  if (keys.length) await redis.del(...keys);
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
  const user = await prisma.user.create({
    data: { googleId: `test-${TEST_EMAIL}`, email: TEST_EMAIL, name: 'Processor Test' },
  });
  userId = user.id;

  const base = {
    userId,
    smtpHost: 'smtp.ethereal.email',
    smtpPort: 587,
    smtpUser: 'user@ethereal.test',
    smtpPass: encrypt('password'),
  };
  const sender = await prisma.sender.create({
    data: { ...base, fromEmail: 'ok@ethereal.test' },
    select: { id: true },
  });
  const blocked = await prisma.sender.create({
    data: { ...base, fromEmail: 'blocked@ethereal.test', maxPerHour: 0 },
    select: { id: true },
  });
  senderId = sender.id;
  blockedSenderId = blocked.id;
});

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.emailJob.deleteMany({ where: { campaign: { userId } } });
  await prisma.campaign.deleteMany({ where: { userId } });
  await wipeRateKeys();
});

afterAll(async () => {
  await prisma.emailJob.deleteMany({ where: { campaign: { userId } } });
  await prisma.campaign.deleteMany({ where: { userId } });
  await prisma.sender.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await redis.quit();
  await prisma.$disconnect();
});

describe('processEmailJob', () => {
  it('sends a claimed job and records SENT with the message id', async () => {
    const id = await createRow('SCHEDULED');
    const { job } = fakeJob(id);

    const result = await processEmailJob(job, 'tok', { redis });

    expect(result).toEqual({ outcome: 'sent', messageId: 'mock-message-id' });
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const row = await prisma.emailJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SENT');
    expect(row.messageId).toBe('mock-message-id');
    expect(row.previewUrl).toBe('https://preview/mock');
    expect(row.sentAt).not.toBeNull();
  });

  it('sends at most once when two workers race the same row (atomic claim)', async () => {
    const id = await createRow('SCHEDULED');
    const { job: jobA } = fakeJob(id);
    const { job: jobB } = fakeJob(id);

    const [a, b] = await Promise.all([
      processEmailJob(jobA, 'tokA', { redis }),
      processEmailJob(jobB, 'tokB', { redis }),
    ]);

    // Exactly one send happened; the loser stood down.
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['sent', 'skipped']);
    const row = await prisma.emailJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SENT');
  });

  it('proves compare-and-swap idempotency: 10 concurrent claims yield exactly one winner', async () => {
    const id = await createRow('SCHEDULED');

    // Run the atomic CAS claim operation concurrently 10 times on the exact same row.
    const claims = await Promise.all(
      Array.from({ length: 10 }, () =>
        prisma.emailJob.updateMany({
          where: { id, status: 'SCHEDULED' },
          data: { status: 'PROCESSING', processingStartedAt: new Date(), attempts: { increment: 1 } },
        }),
      ),
    );

    const winningClaims = claims.filter((c) => c.count === 1);
    const losingClaims = claims.filter((c) => c.count === 0);

    // Exactly one caller wins the atomic CAS claim; all 9 others receive count === 0.
    expect(winningClaims).toHaveLength(1);
    expect(losingClaims).toHaveLength(9);

    const row = await prisma.emailJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PROCESSING');
    expect(row.attempts).toBe(1);
  });

  it('skips an already-SENT row without re-sending', async () => {
    const id = await createRow('SENT');
    const { job } = fakeJob(id);

    const result = await processEmailJob(job, 'tok', { redis });

    expect(result).toEqual({ outcome: 'skipped', reason: 'already-sent' });
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('rolls back to SCHEDULED and rethrows on a retryable send failure', async () => {
    mockedSend.mockRejectedValueOnce(new Error('smtp 421 try later'));
    const id = await createRow('SCHEDULED');
    const { job } = fakeJob(id, { attemptsMade: 0, opts: { attempts: 3 } });

    await expect(processEmailJob(job, 'tok', { redis })).rejects.toThrow('smtp 421 try later');

    const row = await prisma.emailJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SCHEDULED'); // re-claimable by the retry
    expect(row.processingStartedAt).toBeNull();
    expect(row.error).toContain('smtp 421');
  });

  it('marks FAILED on the final attempt instead of retrying forever', async () => {
    mockedSend.mockRejectedValueOnce(new Error('smtp 550 rejected'));
    const id = await createRow('SCHEDULED');
    const { job } = fakeJob(id, { attemptsMade: 2, opts: { attempts: 3 } }); // this is attempt 3/3

    const result = await processEmailJob(job, 'tok', { redis });

    expect(result.outcome).toBe('failed');
    const row = await prisma.emailJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('FAILED');
    expect(row.error).toContain('smtp 550');
  });

  it('defers (moveToDelayed) and releases the claim when the sender is rate-limited', async () => {
    const id = await createRow('SCHEDULED', blockedSenderId);
    const { job, moveToDelayed } = fakeJob(id);

    await expect(processEmailJob(job, 'tok', { redis })).rejects.toBeInstanceOf(RateLimitDeferral);

    expect(mockedSend).not.toHaveBeenCalled();
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    // Rescheduled to a future absolute timestamp.
    expect(moveToDelayed.mock.calls[0]![0]).toBeGreaterThan(Date.now());
    // Claim released so a later run can re-acquire it.
    const row = await prisma.emailJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SCHEDULED');
    expect(row.processingStartedAt).toBeNull();
  });
});
