import { z } from 'zod';

/**
 * The ONE source of configuration for the whole backend.
 *
 * Every tuning value (concurrency, delays, limits) is read here from the
 * environment and nowhere else — there are no hardcoded knobs elsewhere in the
 * codebase. We parse `process.env` exactly once, at import time, and throw if
 * anything is missing or malformed so a misconfigured process dies loudly at
 * boot instead of misbehaving silently at 3am.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // mysql://user:pass@host:port/db
  DATABASE_URL: z.string().url(),
  // redis://host:port
  REDIS_URL: z.string().url(),

  PORT: z.coerce.number().int().positive().default(4000),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),

  // AES-256-GCM needs a 32-byte key; we store it as 64 hex chars.
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters'),

  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),

  FRONTEND_ORIGIN: z.string().url().default('http://localhost:3000'),

  // ── scheduling / rate-limiting knobs ──────────────────────────────────────
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  MIN_DELAY_MS_BETWEEN_EMAILS: z.coerce.number().int().nonnegative().default(2000),
  MAX_EMAILS_PER_HOUR: z.coerce.number().int().positive().default(200),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().positive().default(100),
  GLOBAL_MAX_PER_INTERVAL: z.coerce.number().int().positive().default(10),
  GLOBAL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  // BullMQ per-job retry policy for transient send failures (exponential backoff).
  EMAIL_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  EMAIL_JOB_BACKOFF_MS: z.coerce.number().int().positive().default(5000),
  // How long an EmailJob may sit in PROCESSING before the reconciler treats it
  // as stranded by a crashed worker and marks it FAILED. Must be comfortably
  // longer than a legitimate send (SMTP connect + handshake + send).
  STALE_PROCESSING_THRESHOLD_MS: z.coerce.number().int().positive().default(600_000),
  MAX_RECIPIENTS_PER_CAMPAIGN: z.coerce.number().int().positive().default(50_000),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5_242_880),
});

type RawEnv = z.infer<typeof EnvSchema>;

function loadEnv(): Readonly<RawEnv & { isProd: boolean; isTest: boolean }> {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    // Human-readable, one line per bad field — this is the message a stranger
    // running the project for the first time will see, so make it actionable.
    const details = parsed.error.issues
      .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return Object.freeze({
    ...parsed.data,
    isProd: parsed.data.NODE_ENV === 'production',
    isTest: parsed.data.NODE_ENV === 'test',
  });
}

export const env = loadEnv();
export type Env = typeof env;
