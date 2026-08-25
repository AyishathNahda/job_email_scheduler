import type { NextFunction, Request, Response } from 'express';
import { AppError, toErrorBody } from '../../lib/errors';
import { logger } from '../../lib/logger';

/** Terminal 404 for any unmatched route, in the shared error envelope. */
export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound('Route not found'));
}

/**
 * Central error handler. Converts anything thrown in a handler into the shared
 * `{ error: { code, message } }` envelope. Crucially, unexpected (non-AppError)
 * errors are logged in full server-side but returned to the client as a generic
 * 500 — stack traces and internal messages never cross the wire.
 *
 * Must keep all four args so Express recognises it as error middleware.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const { statusCode, body } = toErrorBody(err);
  if (statusCode >= 500) {
    logger.error({ err }, 'Unhandled request error');
  } else {
    logger.debug({ err }, 'Request error');
  }
  res.status(statusCode).json(body);
}
