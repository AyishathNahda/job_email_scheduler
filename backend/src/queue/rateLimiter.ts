import type { Redis } from 'ioredis';

/**
 * Per-sender rate limiting, enforced atomically in Redis.
 *
 * Two independent constraints per sender, checked together in one Lua script so
 * the check-and-commit is atomic across all worker processes (no
 * read-then-write race, no in-memory counters that would diverge between
 * workers):
 *
 *   1. Hourly cap  — at most `maxPerHour` sends per wall-clock UTC hour, counted
 *      in `rl:{senderId}:{YYYYMMDDHH}`. The key name carries the hour, so the
 *      count resets automatically at the top of each hour.
 *   2. Minimum gap — at least `minGapMs` between two consecutive sends, tracked
 *      by `gap:{senderId}` holding the last send time (auto-expiring after the
 *      gap).
 *
 * Crucially the script mutates state ONLY when it allows the send, so a denied
 * attempt never consumes quota. Keys are namespaced per sender, so one sender
 * hitting its limit cannot delay another — the breach is isolated.
 *
 * The global, queue-wide throughput limit is a separate concern handled by
 * BullMQ's built-in worker limiter; this module is strictly per-sender.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** When denied, how long to wait before the send could succeed. 0 if allowed. */
  retryAfterMs: number;
}

export interface RateLimitOptions {
  maxPerHour: number;
  minGapMs: number;
  /** Injectable clock for deterministic tests; defaults to the wall clock. */
  nowMs?: number;
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * KEYS[1] hourly counter, KEYS[2] gap marker.
 * ARGV: maxPerHour, minGapMs, nowMs, hourTtlSeconds.
 * Returns { allowedFlag (1/0), retryAfterMs }.
 */
const RATE_LIMIT_LUA = `
local hourKey = KEYS[1]
local gapKey = KEYS[2]
local maxPerHour = tonumber(ARGV[1])
local minGapMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local hourTtl = tonumber(ARGV[4])

-- 1. Minimum-gap check (uses the injected clock, not Redis time).
if minGapMs > 0 then
  local last = redis.call('GET', gapKey)
  if last then
    local elapsed = now - tonumber(last)
    if elapsed < minGapMs then
      return { 0, minGapMs - elapsed }
    end
  end
end

-- 2. Hourly-cap check.
local count = tonumber(redis.call('GET', hourKey) or '0')
if count >= maxPerHour then
  local pttl = redis.call('PTTL', hourKey)
  if pttl < 0 then pttl = hourTtl * 1000 end
  return { 0, pttl }
end

-- Allowed: commit both counters (this is the only mutating path).
redis.call('INCR', hourKey)
redis.call('EXPIRE', hourKey, hourTtl)
if minGapMs > 0 then
  redis.call('SET', gapKey, now, 'PX', minGapMs)
end
return { 1, 0 }
`;

/** Redis augmented with the registered custom command (avoids `any`). */
interface RedisWithRateLimit extends Redis {
  senderRateLimit(
    hourKey: string,
    gapKey: string,
    maxPerHour: number,
    minGapMs: number,
    nowMs: number,
    hourTtlSeconds: number,
  ): Promise<[number, number]>;
}

// Register the script once per client. defineCommand is idempotent-safe but we
// track registration to avoid redundant work.
const registered = new WeakSet<Redis>();
function ensureRegistered(redis: Redis): RedisWithRateLimit {
  if (!registered.has(redis)) {
    redis.defineCommand('senderRateLimit', { numberOfKeys: 2, lua: RATE_LIMIT_LUA });
    registered.add(redis);
  }
  return redis as RedisWithRateLimit;
}

/** UTC YYYYMMDDHH bucket for `nowMs`. */
function hourBucket(nowMs: number): string {
  const d = new Date(nowMs);
  const p = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
}

/** Whole seconds remaining until the end of `nowMs`'s UTC hour, plus a buffer. */
function secondsToEndOfHour(nowMs: number): number {
  const msIntoHour = nowMs % MS_PER_HOUR;
  return Math.ceil((MS_PER_HOUR - msIntoHour) / 1000) + 5;
}

/**
 * Atomically decide whether `senderId` may send right now. Consumes quota only
 * when it returns `allowed: true`.
 */
export async function checkSenderRateLimit(
  redis: Redis,
  senderId: string,
  opts: RateLimitOptions,
): Promise<RateLimitDecision> {
  const client = ensureRegistered(redis);
  const now = opts.nowMs ?? Date.now();
  const hourKey = `rl:${senderId}:${hourBucket(now)}`;
  const gapKey = `gap:${senderId}`;

  const [allowedFlag, retryAfterMs] = await client.senderRateLimit(
    hourKey,
    gapKey,
    opts.maxPerHour,
    opts.minGapMs,
    now,
    secondsToEndOfHour(now),
  );

  return { allowed: allowedFlag === 1, retryAfterMs };
}
