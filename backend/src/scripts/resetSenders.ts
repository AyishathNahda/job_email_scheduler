import { encrypt } from '../lib/crypto';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

async function main(): Promise<void> {
  const users = await prisma.user.findMany();
  if (users.length === 0) {
    logger.warn('No users found to attach senders to.');
    return;
  }

  const etherealUser = process.env.ETHEREAL_USER || 'jacinto.nader9@ethereal.email';
  const etherealPass = process.env.ETHEREAL_PASS || '3rdW93XJzUGFcsQUpE';
  const etherealHost = process.env.ETHEREAL_HOST || 'smtp.ethereal.email';
  const etherealPort = Number(process.env.ETHEREAL_PORT || 587);

  // Deactivate all existing senders that do NOT match the exact user email
  const deactivated = await prisma.sender.updateMany({
    where: {
      fromEmail: { not: etherealUser },
    },
    data: { isActive: false },
  });
  logger.info({ count: deactivated.count }, 'Deactivated all other senders');

  const encryptedPass = encrypt(etherealPass);

  // For every user, ensure they have the exact active sender
  for (const user of users) {
    const existing = await prisma.sender.findFirst({
      where: { userId: user.id, fromEmail: etherealUser },
    });

    if (existing) {
      await prisma.sender.update({
        where: { id: existing.id },
        data: {
          fromName: 'Jacinto Nader',
          smtpHost: etherealHost,
          smtpPort: etherealPort,
          smtpUser: etherealUser,
          smtpPass: encryptedPass,
          isActive: true,
        },
      });
      logger.info({ userId: user.id, email: user.email }, 'Updated existing sender to active');
    } else {
      await prisma.sender.create({
        data: {
          userId: user.id,
          fromEmail: etherealUser,
          fromName: 'Jacinto Nader',
          smtpHost: etherealHost,
          smtpPort: etherealPort,
          smtpUser: etherealUser,
          smtpPass: encryptedPass,
          isActive: true,
        },
      });
      logger.info({ userId: user.id, email: user.email }, 'Created sender');
    }
  }
}


main()
  .catch((err) => {
    logger.error({ err }, 'Failed to reset senders');
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
