import nodemailer, { type TestAccount } from 'nodemailer';
import { encrypt } from '../lib/crypto';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

/**
 * Seed a development user and a few Ethereal SMTP senders so the app works
 * end-to-end without real mailboxes.
 *
 *   pnpm --filter backend seed:senders [count]   (default 3)
 *
 * Ethereal throttles new-account creation (repeated createTestAccount() calls
 * return the SAME mailbox for minutes), so we provision ONE real mailbox and
 * register several logical senders against it using plus-alias from-addresses
 * (foo@…, foo+2@…, foo+3@…). Ethereal is a catch-all, so every message —
 * whatever the alias — lands in that single inbox, which is exactly what you
 * want for a demo. Each Sender row is still a distinct entity with its own id,
 * which is what the per-sender rate limiter keys on.
 *
 * SMTP passwords are stored AES-256-GCM encrypted, never in plaintext.
 * Idempotent: re-running with enough senders already present is a no-op.
 */

const DEV_USER_EMAIL = 'dev@reachinbox.local';
const DEV_USER_GOOGLE_ID = 'dev-seed-user';
const DEFAULT_SENDER_COUNT = 3;
const CREATE_ACCOUNT_ATTEMPTS = 3;

/** Provision one Ethereal mailbox, retrying only on transient network errors. */
async function provisionAccount(): Promise<TestAccount> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= CREATE_ACCOUNT_ATTEMPTS; attempt++) {
    try {
      return await nodemailer.createTestAccount();
    } catch (err) {
      lastErr = err;
      logger.warn({ attempt, err }, 'seed: createTestAccount failed, retrying');
    }
  }
  throw new Error(`Could not provision an Ethereal account after ${CREATE_ACCOUNT_ATTEMPTS} attempts`, {
    cause: lastErr,
  });
}

async function main(): Promise<void> {
  const requested = Number(process.argv[2] ?? DEFAULT_SENDER_COUNT);
  const targetCount = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_SENDER_COUNT;

  const user = await prisma.user.upsert({
    where: { email: DEV_USER_EMAIL },
    update: {},
    create: { googleId: DEV_USER_GOOGLE_ID, email: DEV_USER_EMAIL, name: 'Dev Seed User' },
  });
  logger.info({ userId: user.id, email: user.email }, 'seed: dev user ready');

  const existingCount = await prisma.sender.count({ where: { userId: user.id, isActive: true } });
  if (existingCount >= targetCount) {
    logger.info(
      { existing: existingCount, target: targetCount },
      'seed: enough senders already exist — nothing to do (delete them to reseed)',
    );
    return;
  }

  const account = await provisionAccount();
  const [localPart, domain] = account.user.split('@') as [string, string];
  // Same secret for every alias; encrypt once (random IV still makes it opaque).
  const encryptedPass = encrypt(account.pass);

  for (let ordinal = existingCount + 1; ordinal <= targetCount; ordinal++) {
    // Sender #1 uses the bare mailbox address; the rest use +N plus-aliases.
    const fromEmail = ordinal === 1 ? account.user : `${localPart}+${ordinal}@${domain}`;

    const sender = await prisma.sender.create({
      data: {
        userId: user.id,
        fromEmail,
        fromName: `ReachInbox Sender ${ordinal}`,
        smtpHost: account.smtp.host,
        smtpPort: account.smtp.port,
        smtpUser: account.user,
        smtpPass: encryptedPass,
      },
    });
    logger.info({ senderId: sender.id, fromEmail: sender.fromEmail }, 'seed: sender created');
  }

  logger.info(
    { total: targetCount, inbox: account.web, mailbox: account.user },
    'seed: done — open `inbox` in a browser to read every message these senders send',
  );
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'seed: failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
