import type { GoogleIdentity } from '../lib/googleAuth';
import { prisma } from '../lib/prisma';

/**
 * The authenticated user as the API exposes it — never includes anything
 * secret. Returned by login and the /me endpoint.
 */
export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

const userSelect = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
} as const;

/**
 * Find-or-create the local user for a verified Google identity.
 *
 * Keyed on the Google subject id (`googleId`), which is stable for the lifetime
 * of the Google account — unlike the email, which a user can change. On every
 * login we refresh the mutable profile fields (email, name, avatar) so a user
 * who updates their Google profile sees it reflected here without a second
 * account ever being created.
 *
 * The identity has already been cryptographically verified against Google's
 * public keys in {@link verifyGoogleIdToken}; this function never sees a raw
 * token and performs no trust decision of its own.
 */
export async function upsertUserFromGoogle(identity: GoogleIdentity): Promise<AuthedUser> {
  return prisma.user.upsert({
    where: { googleId: identity.googleId },
    update: {
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
    },
    create: {
      googleId: identity.googleId,
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
    },
    select: userSelect,
  });
}

/** Load the current user by id, or null if the account no longer exists. */
export async function getUserById(userId: string): Promise<AuthedUser | null> {
  return prisma.user.findUnique({ where: { id: userId }, select: userSelect });
}
