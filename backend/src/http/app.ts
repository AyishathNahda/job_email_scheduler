import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import type { Redis } from 'ioredis';
import pinoHttp from 'pino-http';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { asyncHandler } from './asyncHandler';
import { errorHandler, notFound } from './middleware/error';
import { authRouter } from './routes/auth';
import { campaignsRouter } from './routes/campaigns';
import { sendersRouter } from './routes/senders';

/**
 * Build the Express application. Kept as a pure factory (no `listen`, no
 * process-level wiring) so tests can mount it with supertest and the process
 * entry (server.ts) owns the socket and shutdown. All configuration comes from
 * `env`; nothing here is hardcoded.
 */
export interface AppDeps {
  /** Optional Redis client, used only by /healthz to prove connectivity. */
  redis?: Redis;
}

export function buildApp(deps: AppDeps = {}): Express {
  const app = express();

  // Sit behind one proxy/LB in most deploys; trust it so `secure` cookies and
  // req.protocol reflect the original client connection.
  app.set('trust proxy', 1);

  app.use(pinoHttp({ logger }));
  // Cookies carry the session, so CORS must allow credentials and echo the
  // single configured frontend origin (a wildcard is illegal with credentials).
  app.use(cors({ origin: env.FRONTEND_ORIGIN, credentials: true }));
  app.use(express.json({ limit: env.MAX_UPLOAD_BYTES }));
  app.use(cookieParser());

  // Liveness + dependency check: pings MySQL, and Redis when a client is wired.
  app.get(
    '/healthz',
    asyncHandler(async (_req, res) => {
      const checks: { db: boolean; redis?: boolean } = { db: false };
      try {
        await prisma.$queryRaw`SELECT 1`;
        checks.db = true;
      } catch {
        checks.db = false;
      }
      if (deps.redis) {
        try {
          checks.redis = (await deps.redis.ping()) === 'PONG';
        } catch {
          checks.redis = false;
        }
      }
      const ok = checks.db && (checks.redis ?? true);
      res.status(ok ? 200 : 503).json({ ok, service: 'api', checks });
    }),
  );

  app.use('/api/auth', authRouter);
  app.use('/api/senders', sendersRouter);
  app.use('/api/campaigns', campaignsRouter);

  // Unmatched route → 404 in the shared envelope; then the central error handler.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
