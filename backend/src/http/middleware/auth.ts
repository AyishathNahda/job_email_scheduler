import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { env } from '../../config/env';
import { AppError } from '../../lib/errors';
import { type SessionClaims, verifySession } from '../../lib/jwt';

/** Name of the httpOnly cookie carrying the session JWT. */
export const SESSION_COOKIE = 'session';

/** Cookie options for setting the session cookie. */
export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProd,
    path: '/',
    maxAge: env.SESSION_TTL_SECONDS * 1000,
  };
}

/** Attributes used to CLEAR the cookie — identical to the set options minus the
 *  lifetime, which the browser requires to match for the deletion to take. */
function clearCookieOptions(): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: env.isProd, path: '/' };
}

/** Set the httpOnly session cookie carrying the signed JWT. */
export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
}

/** Clear the session cookie (logout). */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, clearCookieOptions());
}

/**
 * Authenticate a request from either the session cookie or a Bearer token
 * (the latter is handy for API clients and tests). Attaches the verified claims
 * to req.user, or forwards a 401 — it never lets an unauthenticated request
 * reach a protected handler.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = readToken(req);
  if (!token) {
    next(AppError.unauthorized('Authentication required'));
    return;
  }
  try {
    req.user = verifySession(token);
    next();
  } catch {
    next(AppError.unauthorized('Invalid or expired session'));
  }
}

/**
 * Read the authenticated user off a request inside a protected handler. Throws
 * if somehow absent (i.e. requireAuth was not applied) rather than returning a
 * possibly-undefined value that callers would have to null-check.
 */
export function authed(req: Request): SessionClaims {
  if (!req.user) throw AppError.unauthorized('Authentication required');
  return req.user;
}

function readToken(req: Request): string | null {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const cookie = cookies?.[SESSION_COOKIE];
  if (typeof cookie === 'string' && cookie.length > 0) return cookie;

  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);

  return null;
}
