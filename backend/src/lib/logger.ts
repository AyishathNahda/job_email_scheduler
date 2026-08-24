import pino from 'pino';
import { env } from '../config/env';

/**
 * Structured logging with pino. In dev we pretty-print for readability; in
 * prod we emit line-delimited JSON so a log shipper can parse it. The reconciler
 * uses this to log its requeued count prominently on every boot.
 */
export const logger = pino(
  env.isProd
    ? { level: 'info' }
    : {
        level: env.isTest ? 'warn' : 'debug',
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      },
);
