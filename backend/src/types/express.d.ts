import type { SessionClaims } from '../lib/jwt';

/**
 * Augment Express's Request with the authenticated user attached by the
 * requireAuth middleware. Optional here because it is only present after that
 * middleware runs; protected handlers read it via the `authed()` accessor.
 */
declare global {
  namespace Express {
    interface Request {
      user?: SessionClaims;
    }
  }
}

export {};
