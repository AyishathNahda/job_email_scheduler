import { logger } from '../lib/logger';
import { closeTransports, sendEmail, verifyTransport } from '../lib/mailer';
import { prisma } from '../lib/prisma';

/**
 * Manual end-to-end check for the crypto + mailer path:
 *
 *   pnpm --filter backend exec tsx --env-file=../.env src/scripts/testSend.ts [toEmail]
 *
 * Picks the first active seeded sender, verifies its (decrypted) SMTP
 * credentials, sends one message, and prints the Ethereal preview URL. Proves
 * the stored ciphertext decrypts to a working password without involving the
 * queue or worker.
 */

async function main(): Promise<void> {
  const to = process.argv[2] ?? 'recipient@example.com';

  const sender = await prisma.sender.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!sender) {
    throw new Error('No active sender found. Run `pnpm --filter backend seed:senders` first.');
  }

  logger.info({ senderId: sender.id, fromEmail: sender.fromEmail }, 'testSend: verifying SMTP credentials');
  await verifyTransport(sender);

  const result = await sendEmail(sender, {
    to,
    subject: 'ReachInbox test send',
    html: '<h1>It works</h1><p>This message was sent through the mailer service.</p>',
  });

  logger.info(
    { messageId: result.messageId, previewUrl: result.previewUrl },
    'testSend: sent — open previewUrl to view the message',
  );
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'testSend: failed');
    process.exitCode = 1;
  })
  .finally(() => {
    closeTransports();
    void prisma.$disconnect();
  });
