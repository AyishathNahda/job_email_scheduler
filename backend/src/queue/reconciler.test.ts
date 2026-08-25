import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { encrypt } from '../lib/crypto';
import { prisma } from '../lib/prisma';
import { newRedis } from './connection';
import {
  closeQueue,
  EMAIL_QUEUE_NAME,
  emailJobKey,
  emailQueue,
  enqueueEmailJobs,
} from './emailQueue';
import { reconcile } from './reconciler';
import { env } from '../config/env';

/**
 * Integration test against real MySQL + BullMQ/Redis. Proves the two repairs the
 * boot reconciler performs: re-enqueuing SCHEDULED rows whose BullMQ job is gone,
 * and failing PROCESSING rows stranded past the stale threshold.
 */

const redis: Redis = newRedis();
const TEST_EMAIL = 'reconciler-test@reachinbox.test';

let userId: string;
let senderId: string;

async function makeRow(
  campaignId: string,
  seq: number,
  status: 'SCHEDULED' | 'PROCESSING',
  processingStartedAt: Date | null = null,
): Promise<string> {
  const row = await prisma.emailJob.create({
    data: {
      campaignId,
      senderId,
      toEmail: `r${seq}@example.com`,
      sequenceNumber: seq,
      scheduledAt: new Date(),
      status,
      processingStartedAt,
    },
    select: { id: true },
  });
  return row.id;
}

async function makeCampaign(): Promise<string> {
  const c = await prisma.campaign.create({
    data: {
      userId,
      subject: 'S',
      bodyHtml: '<p>B</p>',
      startAt: new Date(),
      delayMs: 0,
      hourlyLimit: 100,
      totalCount: 0,
    },
    select: { id: true },
  });
  return c.id;
}

async function jobExists(rowId: string): Promise<boolean> {
  return (await redis.exists(`bull:${EMAIL_QUEUE_NAME}:${emailJobKey(rowId)}`)) === 1;
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
  const user = await prisma.user.create({
    data: { googleId: `test-${TEST_EMAIL}`, email: TEST_EMAIL, name: 'Reconciler Test' },
  });
  userId = user.id;
  const sender = await prisma.sender.create({
    data: {
      userId,
      fromEmail: 'rec@ethereal.test',
      smtpHost: 'smtp.ethereal.email',
      smtpPort: 587,
      smtpUser: 'rec@ethereal.test',
      smtpPass: encrypt('password'),
    },
    select: { id: true },
  });
  senderId = sender.id;
});

beforeEach(async () => {
  await prisma.emailJob.deleteMany({ where: { campaign: { userId } } });
  await prisma.campaign.deleteMany({ where: { userId } });
  await emailQueue.obliterate({ force: true });
});

afterAll(async () => {
  await prisma.emailJob.deleteMany({ where: { campaign: { userId } } });
  await prisma.campaign.deleteMany({ where: { userId } });
  await prisma.sender.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await emailQueue.obliterate({ force: true });
  await closeQueue();
  await redis.quit();
  await prisma.$disconnect();
});

describe('reconcile', () => {
  it('re-enqueues SCHEDULED rows whose BullMQ job is missing, leaving present ones alone', async () => {
    const campaignId = await makeCampaign();
    const present1 = await makeRow(campaignId, 0, 'SCHEDULED');
    const missing = await makeRow(campaignId, 1, 'SCHEDULED');
    const present2 = await makeRow(campaignId, 2, 'SCHEDULED');

    // Simulate a crash after commit but before enqueue: only two of the three
    // rows got their BullMQ job.
    await enqueueEmailJobs([
      { emailJobId: present1, scheduledAt: new Date() },
      { emailJobId: present2, scheduledAt: new Date() },
    ]);
    expect(await jobExists(missing)).toBe(false);

    const report = await reconcile(redis);

    expect(report.requeued).toBe(1);
    expect(await jobExists(missing)).toBe(true);
    // All three rows now have a job.
    expect(await jobExists(present1)).toBe(true);
    expect(await jobExists(present2)).toBe(true);
  });

  it('fails PROCESSING rows stranded past the stale threshold but spares fresh ones', async () => {
    const campaignId = await makeCampaign();
    const now = Date.now();
    const stale = await makeRow(
      campaignId,
      0,
      'PROCESSING',
      new Date(now - env.STALE_PROCESSING_THRESHOLD_MS - 60_000),
    );
    const fresh = await makeRow(campaignId, 1, 'PROCESSING', new Date(now));

    const report = await reconcile(redis, now);

    expect(report.staleFailed).toBe(1);
    const staleRow = await prisma.emailJob.findUniqueOrThrow({ where: { id: stale } });
    expect(staleRow.status).toBe('FAILED');
    expect(staleRow.error).toContain('interrupted-processing');
    const freshRow = await prisma.emailJob.findUniqueOrThrow({ where: { id: fresh } });
    expect(freshRow.status).toBe('PROCESSING');
  });
});
