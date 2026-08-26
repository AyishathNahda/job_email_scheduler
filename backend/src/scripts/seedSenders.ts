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
 * Prefers ETHEREAL_USER / ETHEREAL_PASS from .env so you can reuse a specific
 * mailbox (e.g. the one shown in the Ethereal UI) instead of creating a new
 * random account each run. Falls back to nodemailer.createTestAccount() when
 * those vars are absent.
 *
 * SMTP passwords are stored AES-256-GCM encrypted, never in plaintext.
 * Idempotent: re-running with enough senders already present is a no-op.
 */

const DEV_USER_EMAIL = 'dev@reachinbox.local';
const DEV_USER_GOOGLE_ID = 'dev-seed-user';
const DEFAULT_SENDER_COUNT = 3;
const CREATE_ACCOUNT_ATTEMPTS = 3;

/** Use env-provided Ethereal creds or fall back to creating a random account. */
async function provisionAccount(): Promise<TestAccount> {
  const user = process.env.ETHEREAL_USER;
  const pass = process.env.ETHEREAL_PASS;

  if (user && pass) {
    const host = process.env.ETHEREAL_HOST ?? 'smtp.ethereal.email';
    const port = Number(process.env.ETHEREAL_PORT ?? 587);
    logger.info({ user, host, port }, 'seed: using env-provided Ethereal account');
    return {
      user,
      pass,
      smtp: { host, port, secure: false },
      imap: { host: 'imap.ethereal.email', port: 993, secure: true },
      pop3: { host: 'pop3.ethereal.email', port: 995, secure: true },
      web: 'https://ethereal.email',
    } as unknown as TestAccount;
  }

  // Fall back to creating a fresh random account
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
