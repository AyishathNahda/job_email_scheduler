import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, safeEqual } from '../lib/crypto';

describe('crypto (AES-256-GCM)', () => {
  it('round-trips a value back to the original plaintext', () => {
    const secret = 'super-secret-smtp-password-123';
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it('round-trips empty and unicode strings', () => {
    for (const secret of ['', 'password with spaces', '🔐 пароль 密码', 'a'.repeat(4096)]) {
      expect(decrypt(encrypt(secret))).toBe(secret);
    }
  });

  it('produces a distinct ciphertext each time (random IV)', () => {
    const secret = 'same-input';
    const a = encrypt(secret);
    const b = encrypt(secret);
    expect(a).not.toBe(b);
    // ...yet both decrypt back to the same plaintext.
    expect(decrypt(a)).toBe(secret);
    expect(decrypt(b)).toBe(secret);
  });

  it('emits the iv:authTag:ciphertext hex layout', () => {
    const parts = encrypt('x').split(':');
    expect(parts).toHaveLength(3);
    const [iv, tag] = parts as [string, string, string];
    expect(iv).toMatch(/^[0-9a-f]{24}$/); // 12 bytes
    expect(tag).toMatch(/^[0-9a-f]{32}$/); // 16 bytes
  });

  it('rejects a tampered ciphertext (GCM auth failure)', () => {
    const token = encrypt('do-not-alter');
    const [iv, tag, data] = token.split(':') as [string, string, string];
    // Flip the last nibble of the ciphertext body.
    const lastChar = data.at(-1)!;
    const flipped = data.slice(0, -1) + (lastChar === '0' ? '1' : '0');
    expect(() => decrypt(`${iv}:${tag}:${flipped}`)).toThrow();
  });

  it('rejects a tampered authentication tag', () => {
    const token = encrypt('do-not-alter');
    const [iv, tag, data] = token.split(':') as [string, string, string];
    const lastChar = tag.at(-1)!;
    const flipped = tag.slice(0, -1) + (lastChar === '0' ? '1' : '0');
    expect(() => decrypt(`${iv}:${flipped}:${data}`)).toThrow();
  });

  it('rejects malformed payloads', () => {
    expect(() => decrypt('not-a-valid-token')).toThrow();
    expect(() => decrypt('only:two')).toThrow();
  });

  describe('safeEqual', () => {
    it('is true for identical strings and false otherwise', () => {
      expect(safeEqual('token', 'token')).toBe(true);
      expect(safeEqual('token', 'tokeN')).toBe(false);
      expect(safeEqual('short', 'longer-value')).toBe(false);
    });
  });
});
