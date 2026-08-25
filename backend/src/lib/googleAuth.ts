import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env';
import { AppError } from './errors';

/**
 * Real, server-side Google Sign-In verification. The frontend obtains a Google
 * ID token; we verify its signature and audience against Google's public keys
 * here — the client's word is never trusted. There is no mock/bypass path.
 */

const client = new OAuth2Client(env.GOOGLE_CLIENT_ID);

export interface GoogleIdentity {
  googleId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    // Signature/audience/expiry failure — do not leak the underlying reason.
    throw AppError.unauthorized('Invalid Google credential');
  }

  if (!payload?.sub || !payload.email) {
    throw AppError.unauthorized('Google credential is missing required claims');
  }
  if (payload.email_verified === false) {
    throw AppError.unauthorized('Google email address is not verified');
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name ?? payload.email,
    avatarUrl: payload.picture ?? null,
  };
}
