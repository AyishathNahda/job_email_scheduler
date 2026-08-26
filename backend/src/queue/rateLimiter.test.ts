import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { newRedis } from './connection';
import { checkSenderRateLimit } from './rateLimiter';

/**
 * Integration test against the real Docker Redis. Uses an injected clock
 * (`nowMs`) so the hourly-window and gap arithmetic is fully deterministic and
 * never sleeps.
 */

const redis: Redis = newRedis();

// Fixed instant well inside a UTC hour (12:00:00Z) so there is no boundary edge.
const T = Date.UTC(2026, 0, 1, 12, 0, 0);

const SENDERS = ['rltest-a', 'rltest-b', 'rltest-c', 'rltest-d'];

async function wipeKeys(): Promise<void> {
  const keys = await redis.keys('rl:rltest-*');
  const gaps = await redis.keys('gap:rltest-*');
  const all = [...keys, ...gaps];
  if (all.length) await redis.del(...all);
}

beforeEach(wipeKeys);

afterAll(async () => {
  await wipeKeys();
  await redis.quit();
});

describe('checkSenderRateLimit', () => {
  it('enforces the per-sender hourly cap and only consumes quota on allow', async () => {
    const sender = SENDERS[0]!;
    const opts = { maxPerHour: 3, minGapMs: 0, nowMs: T };

    for (let i = 0; i < 3; i++) {
      const d = await checkSenderRateLimit(redis, sender, opts);
      expect(d.allowed, `send ${i + 1} of 3 should be allowed`).toBe(true);
    }

    const denied = await checkSenderRateLimit(redis, sender, opts);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);

    // A second denied attempt must not consume quota either.
    await checkSenderRateLimit(redis, sender, opts);

    // The hour counter reflects exactly the 3 allowed sends — denials never
    // incremented it.
    const d = new Date(T);
    const p = (n: number, len = 2) => String(n).padStart(len, '0');
    const bucket = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
    const count = await redis.get(`rl:${sender}:${bucket}`);
    expect(count).toBe('3');
  });

  it('enforces the minimum gap between consecutive sends', async () => {
    const sender = SENDERS[1]!;
    const minGapMs = 60_000; // large enough that real-time key expiry can't race the test

    const first = await checkSenderRateLimit(redis, sender, { maxPerHour: 100, minGapMs, nowMs: T });
    expect(first.allowed).toBe(true);

    // Too soon (only 30s of virtual time elapsed).
    const tooSoon = await checkSenderRateLimit(redis, sender, { maxPerHour: 100, minGapMs, nowMs: T + 30_000 });
    expect(tooSoon.allowed).toBe(false);
    expect(tooSoon.retryAfterMs).toBe(30_000);

    // Exactly one gap later: allowed.
    const later = await checkSenderRateLimit(redis, sender, { maxPerHour: 100, minGapMs, nowMs: T + 60_000 });
    expect(later.allowed).toBe(true);
  });

  it('isolates senders: one hitting its cap does not block another', async () => {
    const a = SENDERS[2]!;
    const b = SENDERS[3]!;
    const opts = { maxPerHour: 1, minGapMs: 0, nowMs: T };

    expect((await checkSenderRateLimit(redis, a, opts)).allowed).toBe(true);
    // A is now exhausted.
    expect((await checkSenderRateLimit(redis, a, opts)).allowed).toBe(false);
    // B is completely unaffected.
    expect((await checkSenderRateLimit(redis, b, opts)).allowed).toBe(true);
  });

  it('resets hourly quota when advancing to the next UTC hour window', async () => {
    const sender = SENDERS[0]!;
    const MS_PER_HOUR = 3600_000;
    const opts = { maxPerHour: 2, minGapMs: 0, nowMs: T };

    // Consume all 2 slots in hour 0
    expect((await checkSenderRateLimit(redis, sender, opts)).allowed).toBe(true);
    expect((await checkSenderRateLimit(redis, sender, opts)).allowed).toBe(true);
    expect((await checkSenderRateLimit(redis, sender, opts)).allowed).toBe(false);

    // Advance virtual clock to next hour: quota resets
    const nextHourOpts = { maxPerHour: 2, minGapMs: 0, nowMs: T + MS_PER_HOUR };
    const nextHourAttempt = await checkSenderRateLimit(redis, sender, nextHourOpts);
    expect(nextHourAttempt.allowed).toBe(true);
  });
});

