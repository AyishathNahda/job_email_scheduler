import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { planSendTime } from '../lib/planner';
import { prisma } from '../lib/prisma';
import { closeQueue, emailJobKey, emailQueue } from '../queue/emailQueue';
import { createCampaign, type CreateCampaignInput } from './campaignService';

/**
 * Integration test — hits the real Docker MySQL and Redis. Proves the
 * DB-first-then-enqueue ordering, deterministic job ids, round-robin sender
 * assignment, recipient dedupe, and idempotency-key replay.
 */

const TEST_EMAIL = 'campaign-svc-test@reachinbox.test';

let userId: string;
let senderIds: string[];

async function wipeUserData(): Promise<void> {
  // Jobs before senders: EmailJob.senderId is ON DELETE RESTRICT.
  await prisma.emailJob.deleteMany({ where: { campaign: { userId } } });
  await prisma.campaign.deleteMany({ where: { userId } });
}

function buildInput(overrides: Partial<CreateCampaignInput> = {}): CreateCampaignInput {
  return {
    subject: 'Hello',
    bodyHtml: '<p>Hi</p>',
    startAt: new Date('2026-06-01T00:00:00.000Z'),
    delayMs: 2000,
    hourlyLimit: 100,
    recipients: [
      { email: 'a@example.com', name: 'A' },
      { email: 'b@example.com' },
      { email: 'c@example.com' },
    ],
    senderIds,
    ...overrides,
  };
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
  const user = await prisma.user.create({
    data: { googleId: `test-${TEST_EMAIL}`, email: TEST_EMAIL, name: 'Campaign Test' },
  });
  userId = user.id;

  const mk = (n: number) =>
    prisma.sender.create({
      data: {
        userId,
        fromEmail: `sender${n}@ethereal.test`,
        fromName: `Sender ${n}`,
        smtpHost: 'smtp.ethereal.email',
        smtpPort: 587,
        smtpUser: `sender${n}@ethereal.test`,
        smtpPass: encrypt('password'),
      },
      select: { id: true },
    });
  const [s1, s2] = await Promise.all([mk(1), mk(2)]);
  senderIds = [s1.id, s2.id];
});

beforeEach(async () => {
  await wipeUserData();
  await emailQueue.obliterate({ force: true });
});

afterAll(async () => {
  await wipeUserData();
  await prisma.sender.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await emailQueue.obliterate({ force: true });
  await closeQueue();
  await prisma.$disconnect();
});

describe('createCampaign', () => {
  it('creates the campaign, one job per recipient, and enqueues delayed jobs', async () => {
    const input = buildInput();
    const result = await createCampaign(userId, input);

    expect(result.totalCount).toBe(3);
    expect(result.status).toBe('SCHEDULED');
    expect(result.deduplicated).toBe(false);
    // Effective spacing is max(input.delayMs, env floor).
    expect(result.delayMs).toBeGreaterThanOrEqual(2000);

    const jobs = await prisma.emailJob.findMany({
      where: { campaignId: result.id },
      orderBy: { sequenceNumber: 'asc' },
    });
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.toEmail)).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    expect(jobs.every((j) => j.status === 'SCHEDULED')).toBe(true);

    // Round-robin sender assignment across two senders.
    expect(jobs[0]!.senderId).toBe(senderIds[0]);
    expect(jobs[1]!.senderId).toBe(senderIds[1]);
    expect(jobs[2]!.senderId).toBe(senderIds[0]);

    // scheduledAt matches the pure planner.
    for (const job of jobs) {
      const expected = planSendTime(input.startAt, job.sequenceNumber, result.delayMs, result.hourlyLimit);
      expect(job.scheduledAt.getTime()).toBe(expected.getTime());
    }

    // Every row has a corresponding delayed BullMQ job under its deterministic id.
    for (const job of jobs) {
      const bull = await emailQueue.getJob(emailJobKey(job.id));
      expect(bull, `job ${job.id} should be enqueued`).toBeTruthy();
      expect(bull!.data.emailJobId).toBe(job.id);
    }
  });

  it('deduplicates repeated recipient addresses (case-insensitively)', async () => {
    const result = await createCampaign(
      userId,
      buildInput({
        recipients: [
          { email: 'dup@example.com' },
          { email: 'DUP@example.com' },
          { email: 'other@example.com' },
        ],
      }),
    );
    expect(result.totalCount).toBe(2);
    const emails = await prisma.emailJob.findMany({
      where: { campaignId: result.id },
      select: { toEmail: true },
      orderBy: { sequenceNumber: 'asc' },
    });
    expect(emails.map((e) => e.toEmail)).toEqual(['dup@example.com', 'other@example.com']);
  });

  it('returns the existing campaign on idempotency-key replay without creating duplicates', async () => {
    const input = buildInput({ idempotencyKey: 'replay-key-1' });

    const first = await createCampaign(userId, input);
    expect(first.deduplicated).toBe(false);

    const second = await createCampaign(userId, input);
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);

    // Exactly one campaign and one set of jobs exist.
    const campaigns = await prisma.campaign.count({ where: { userId, idempotencyKey: 'replay-key-1' } });
    expect(campaigns).toBe(1);
    const jobCount = await prisma.emailJob.count({ where: { campaignId: first.id } });
    expect(jobCount).toBe(3);
  });

  it('rejects a sender that does not belong to the user', async () => {
    await expect(createCampaign(userId, buildInput({ senderIds: ['does-not-exist'] }))).rejects.toBeInstanceOf(
      AppError,
    );
  });
});
