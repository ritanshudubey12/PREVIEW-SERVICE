import { createHash, randomBytes } from 'node:crypto';

/** 256 bits of CSPRNG output, base64url => always 43 chars. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is ever persisted. SHA-256 is appropriate: the input is already high-entropy. */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
