import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

const valid = {
  DB_HOST: 'h', DB_PORT: '5432', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'd',
  JWT_ISSUER: 'iss', JWT_AUDIENCE: 'aud', JWT_PUBLIC_KEY: 'line1\\nline2',
  PREVIEW_ORIGIN: 'https://preview.invalid/',
  PAGE_REVISION_MODE: 'stub',
};

describe('config', () => {
  it('loads a valid environment, normalising PEM newlines and origin', () => {
    const c = loadConfig(valid);
    expect(c.jwt.publicKeyPem).toBe('line1\nline2');
    expect(c.preview.origin).toBe('https://preview.invalid');
    expect(c.jwt.algorithms).toEqual(['RS256']);
  });

  it('treats empty values (KEY=) like unset, so a copied .env.example does not break optional settings', () => {
    const c = loadConfig({ ...valid, PAGE_REVISION_SERVICE_URL: '', PAGE_REVISION_SERVICE_TOKEN: '', JWT_JWKS_URL: '  ' });
    expect(c.pageRevision.url).toBeUndefined();
    expect(c.pageRevision.serviceToken).toBeUndefined();
    // ...while an empty REQUIRED value is still reported as missing
    expect(() => loadConfig({ ...valid, JWT_ISSUER: '' })).toThrow(/JWT_ISSUER/);
  });

  it('fails fast and names every missing setting (no silent defaults for secrets)', () => {
    expect(() => loadConfig({})).toThrow(/DB_HOST[\s\S]*JWT_ISSUER[\s\S]*JWT_AUDIENCE/);
  });

  it('requires exactly one JWT key source', () => {
    expect(() => loadConfig({ ...valid, JWT_PUBLIC_KEY: undefined })).toThrow(/JWT_PUBLIC_KEY/);
    expect(() => loadConfig({ ...valid, JWT_JWKS_URL: 'https://jwks.invalid/keys' })).toThrow(/only one/);
  });

  it('refuses symmetric / unknown algorithms', () => {
    expect(() => loadConfig({ ...valid, JWT_ALGORITHMS: 'HS256' })).toThrow();
    expect(() => loadConfig({ ...valid, JWT_ALGORITHMS: 'none' })).toThrow();
  });

  it('refuses the stub Page/Revision client in production', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow(/stub mode is not allowed/);
  });

  it('requires a Page/Revision URL in http mode', () => {
    expect(() => loadConfig({ ...valid, PAGE_REVISION_MODE: 'http' })).toThrow(/PAGE_REVISION_SERVICE_URL/);
  });

  it('keeps TTL default within [min, max]', () => {
    expect(() => loadConfig({ ...valid, PREVIEW_TTL_DEFAULT_SECONDS: '999999' })).toThrow(/default must be within/);
    expect(() => loadConfig({ ...valid, PREVIEW_TTL_MIN_SECONDS: '5000', PREVIEW_TTL_MAX_SECONDS: '10' })).toThrow();
  });
});
