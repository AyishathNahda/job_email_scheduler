import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../config/env';

/**
 * Redis connection factory for BullMQ.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on any connection it uses for
 * blocking commands, and it wants each long-lived construct (Queue, Worker,
 * QueueEvents) to own its own connection rather than share one — a Worker's
 * blocking BRPOPLPUSH would otherwise stall commands from a Queue on the same
 * socket. So every construct calls this to get a fresh, correctly-configured
 * client and is responsible for closing it on shutdown.
 */
export function newRedis(overrides?: RedisOptions): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    ...overrides,
  });
}
