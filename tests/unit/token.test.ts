import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, TOKEN_PATTERN } from '../../src/modules/preview/preview.token.js';

describe('preview token', () => {
  it('is 256 bits of base64url (43 chars) and matches the accepted pattern', () => {
    const t = generateToken();
    expect(t).toHaveLength(43);
    expect(TOKEN_PATTERN.test(t)).toBe(true);
  });

  it('is unique across many generations (CSPRNG, no repeats)', () => {
    const seen = new Set(Array.from({ length: 5000 }, () => generateToken()));
    expect(seen.size).toBe(5000);
  });

  it('hashes with SHA-256 to 32 bytes and never equals the raw token', () => {
    const t = generateToken();
    const h = hashToken(t);
    expect(h).toHaveLength(32);
    expect(h.equals(createHash('sha256').update(t).digest())).toBe(true);
    expect(h.toString('utf8')).not.toContain(t);
  });

  it('rejects malformed tokens before any database access', () => {
    for (const bad of ['', 'short', 'x'.repeat(44), 'x'.repeat(42), `${'a'.repeat(42)}!`, ' '.repeat(43)]) {
      expect(TOKEN_PATTERN.test(bad)).toBe(false);
    }
  });
});
