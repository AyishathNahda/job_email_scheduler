import { logger } from '../lib/logger';
import { closeTransports } from '../lib/mailer';
import { prisma } from '../lib/prisma';
import { newRedis } from '../queue/connection';
import { closeQueue } from '../queue/emailQueue';
import { createEmailWorker } from '../queue/emailWorker';
import { createCampaign } from '../services/campaignService';

/**
 * Manual end-to-end smoke test (NOT part of the automated suite).
 *
 *   pnpm --filter backend exec tsx --env-file=../.env src/scripts/smokeTest.ts
 *
 * Creates a tiny real campaign against seeded senders, runs the actual worker
 * wiring, waits for the jobs to reach a terminal state, and prints the Ethereal
 * preview URLs — exercising the whole pipeline (queue → four gates → real SMTP →
 * DB) against live MySQL/Redis/Ethereal. Cleans up the campaign afterwards.
 */

const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
const RECIPIENTS = ['smoke-1@example.com', 'smoke-2@example.com'];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // Pick up to two active senders belonging to a single user.
  const active = await prisma.sender.findMany({
    where: { isActive: true },
    select: { id: true, userId: true, fromEmail: true },
    orderBy: { createdAt: 'asc' },
  });
  if (active.length === 0) {
    throw new Error('No active senders. Run `pnpm --filter backend seed:senders` first.');
  }
  const userId = active[0]!.userId;
  const senders = active.filter((s) => s.userId === userId).slice(0, 2);
  logger.info({ userId, senders: senders.map((s) => s.fromEmail) }, 'Smoke test: using senders');

  // Create a campaign that is due immediately.
  const campaign = await createCampaign(userId, {
    subject: 'Outbox smoke test',
    bodyHtml: '<p>Hello from the Outbox smoke test.</p>',
    startAt: new Date(),
    delayMs: 0,
    hourlyLimit: 100,
    recipients: RECIPIENTS.map((email) => ({ email })),
    senderIds: senders.map((s) => s.id),
  });
  logger.info({ campaignId: campaign.id, totalCount: campaign.totalCount }, 'Smoke test: campaign created');

  // Boot the real worker wiring.
  const opsRedis = newRedis();
  const worker = createEmailWorker(opsRedis);

  // Poll until every job is terminal (SENT/FAILED) or we time out.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let jobs = await prisma.emailJob.findMany({ where: { campaignId: campaign.id } });
  while (Date.now() < deadline && jobs.some((j) => j.status === 'SCHEDULED' || j.status === 'PROCESSING')) {
    await sleep(POLL_INTERVAL_MS);
    jobs = await prisma.emailJob.findMany({ where: { campaignId: campaign.id } });
  }

  // Report.
  for (const j of jobs) {
    logger.info(
      { to: j.toEmail, status: j.status, messageId: j.messageId, previewUrl: j.previewUrl, error: j.error },
      `  → ${j.toEmail}: ${j.status}`,
    );
  }
  const sent = jobs.filter((j) => j.status === 'SENT').length;
  const campaignRow = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
  logger.info(
    { sent, total: jobs.length, campaignStatus: campaignRow.status },
    'Smoke test: result',
  );

  // Clean up the smoke campaign (leave senders in place).
  await prisma.emailJob.deleteMany({ where: { campaignId: campaign.id } });
  await prisma.campaign.delete({ where: { id: campaign.id } });

  // Tear down.
  await worker.close();
  await closeQueue();
  closeTransports();
  await opsRedis.quit();
  await prisma.$disconnect();

  const ok = sent === jobs.length && jobs.length === RECIPIENTS.length;
  if (!ok) {
    logger.error('Smoke test FAILED: not all recipients were sent');
    process.exit(1);
  }
  logger.info('Smoke test PASSED');
  process.exit(0);
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Smoke test crashed');
  process.exit(1);
});
