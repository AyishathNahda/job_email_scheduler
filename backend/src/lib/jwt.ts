import jwt from 'jsonwebtoken';
import { env } from '../config/env';

/**
 * Stateless session tokens (JWT). The token carries just enough to authorize a
 * request without a per-request DB lookup; the signature (HMAC over JWT_SECRET)
 * is what makes it unforgeable. Lifetime comes from env, never a hardcoded value.
 */

export interface SessionClaims {
  userId: string;
  email: string;
}

export function signSession(claims: SessionClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: env.SESSION_TTL_SECONDS });
}

/**
 * Verify and decode a session token. Throws (caller maps to 401) if the
 * signature is invalid, the token is expired, or the claims are malformed —
 * never trust the token's contents without this check.
 */
export function verifySession(token: string): SessionClaims {
  const decoded = jwt.verify(token, env.JWT_SECRET);
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('Malformed session token');
  }
  const { userId, email } = decoded as Record<string, unknown>;
  if (typeof userId !== 'string' || typeof email !== 'string') {
    throw new Error('Session token missing required claims');
  }
  return { userId, email };
}
