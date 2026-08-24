import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

/**
 * A single PrismaClient for the process. Under `tsx watch` the module graph is
 * re-evaluated on every file change; without a global cache each reload would
 * open a fresh MySQL connection pool and eventually exhaust the server's
 * connection limit. Caching on `globalThis` keeps exactly one pool alive across
 * hot reloads in development.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.isTest ? ['error'] : ['warn', 'error'],
  });

if (!env.isProd) {
  globalForPrisma.prisma = prisma;
}
