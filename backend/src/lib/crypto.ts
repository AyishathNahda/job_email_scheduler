import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config/env';

/**
 * Symmetric encryption for SMTP passwords at rest.
 *
 * We never store an SMTP password in plaintext. Each password is sealed with
 * AES-256-GCM, an authenticated cipher: decryption fails loudly if the
 * ciphertext (or its associated IV/tag) has been tampered with, so a corrupted
 * or altered row can never be silently decrypted into a wrong-but-plausible
 * secret.
 *
 * Wire format (all hex, colon-separated):  iv:authTag:ciphertext
 *   - iv         12 bytes — the GCM nonce, random per encryption
 *   - authTag    16 bytes — GCM authentication tag
 *   - ciphertext variable  — the encrypted UTF-8 plaintext
 *
 * A fresh random IV per call means encrypting the same password twice yields
 * different ciphertexts, which is exactly what we want.
 */

const ALGORITHM = 'aes-256-gcm';
// GCM's standard nonce length. 96-bit IVs are the recommended size and let the
// cipher use its most efficient counter construction.
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// env.ENCRYPTION_KEY is validated at boot as exactly 64 hex chars => 32 bytes,
// the key size AES-256 requires. Decoded once at module load.
const KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');

/** Seal a UTF-8 string. Returns `iv:authTag:ciphertext`, hex-encoded. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Open a value produced by {@link encrypt}. Throws if the payload is malformed
 * or fails GCM authentication (tampering, wrong key, truncation).
 */
export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext: expected "iv:authTag:ciphertext"');
  }
  const [ivHex, authTagHex, dataHex] = parts as [string, string, string];

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(dataHex, 'hex');

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Invalid ciphertext: malformed IV or authentication tag');
  }

  const decipher = createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  // .final() throws if the auth tag does not verify — that is our tamper check.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Constant-time equality for two secrets of the same byte length. Not used by
 * encrypt/decrypt, but handy for comparing decrypted secrets without leaking
 * length-independent timing. Exposed for reuse by auth code.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
