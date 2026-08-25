import type { Request } from 'express';
import { AppError } from '../lib/errors';

/**
 * Read a required route parameter as a definite string.
 *
 * `noUncheckedIndexedAccess` types index-signature access (`req.params[name]`)
 * as `string | undefined`. For a matched route the param is always present, so
 * a miss here is a programming error — we surface it as a 400 rather than let an
 * `undefined` leak into a service call typed for `string`.
 */
export function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw AppError.validation(`Missing route parameter: ${name}`);
  }
  return value;
}
