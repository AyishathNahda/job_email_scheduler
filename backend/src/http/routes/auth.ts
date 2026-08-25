import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { verifyGoogleIdToken } from '../../lib/googleAuth';
import { signSession } from '../../lib/jwt';
import { getUserById, upsertUserFromGoogle } from '../../services/authService';
import { asyncHandler } from '../asyncHandler';
import {
  authed,
  clearSessionCookie,
  requireAuth,
  setSessionCookie,
} from '../middleware/auth';

/**
 * Authentication routes.
 *
 * The only way in is a real Google ID token, verified server-side against
 * Google's public keys ({@link verifyGoogleIdToken}) — there is no mock or
 * dev-bypass login. On success we mint a short-lived JWT and hand it back as an
 * httpOnly cookie, so the token is never exposed to page JavaScript.
 */
export const authRouter: Router = Router();

// Accept the token under `idToken` or Google's own `credential` field name.
const GoogleLoginSchema = z.object({
  idToken: z.string().min(1).max(4096).optional(),
  credential: z.string().min(1).max(4096).optional(),
});

authRouter.post(
  '/google',
  asyncHandler(async (req, res) => {
    const parsed = GoogleLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation('Invalid request body', parsed.error.flatten());
    }
    const idToken = parsed.data.idToken ?? parsed.data.credential;
    if (!idToken) throw AppError.validation('A Google idToken is required');

    const identity = await verifyGoogleIdToken(idToken);
    const user = await upsertUserFromGoogle(identity);
    setSessionCookie(res, signSession({ userId: user.id, email: user.email }));
    res.status(200).json({ user });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = authed(req);
    const user = await getUserById(userId);
    // The session was valid but the account is gone (e.g. deleted) — treat as
    // logged out rather than 500.
    if (!user) throw AppError.unauthorized('Account no longer exists');
    res.json({ user });
  }),
);

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});
