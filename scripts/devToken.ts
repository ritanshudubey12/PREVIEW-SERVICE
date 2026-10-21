/**
 * DEVELOPMENT ONLY. Mints a JWT signed with DEV_JWT_PRIVATE_KEY from .env so the service can be
 * exercised locally. In real deployments tokens come from the platform's identity service; this
 * file (and the private key) must never ship to production.
 */
import { pathToFileURL } from 'node:url';
import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import type { TokenProvider } from '../src/client/previewClient.js';

export const DEV_IDS = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
  pageId: '44444444-4444-4444-8444-444444444444',
  revisionId: '55555555-5555-4555-8555-555555555555',
};

export interface DevTokenOptions {
  roles?: string[];
  ttlSeconds?: number;
  userId?: string;
  tenantId?: string;
  organizationId?: string;
  workspaceId?: string;
  softwareId?: string;
}

export async function mintDevToken(opts: DevTokenOptions = {}): Promise<string> {
  const { DEV_JWT_PRIVATE_KEY, JWT_ISSUER, JWT_AUDIENCE, JWT_ALGORITHMS } = process.env;
  if (!DEV_JWT_PRIVATE_KEY || !JWT_ISSUER || !JWT_AUDIENCE) {
    throw new Error('DEV_JWT_PRIVATE_KEY, JWT_ISSUER and JWT_AUDIENCE must be set in .env');
  }
  const alg = (JWT_ALGORITHMS ?? 'RS256').split(',')[0]!.trim();
  const key = createPrivateKey(DEV_JWT_PRIVATE_KEY.replace(/\\n/g, '\n'));
  const claims: Record<string, unknown> = {
    tenant_id: opts.tenantId ?? DEV_IDS.tenantId,
    organization_id: opts.organizationId ?? DEV_IDS.organizationId,
    roles: opts.roles ?? ['editor'],
  };
  if (opts.workspaceId) claims.workspace_id = opts.workspaceId;
  if (opts.softwareId) claims.software_id = opts.softwareId;
  return new SignJWT(claims)
    .setProtectedHeader({ alg, typ: 'JWT' })
    .setSubject(opts.userId ?? DEV_IDS.userId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${opts.ttlSeconds ?? 900}s`)
    .sign(key);
}

/** Token provider for PreviewApiClient: caches the JWT and re-mints it shortly before expiry. */
export function devTokenProvider(opts: DevTokenOptions = {}): TokenProvider {
  const ttl = opts.ttlSeconds ?? 900;
  let cached: { token: string; refreshAt: number } | null = null;
  return async () => {
    if (!cached || Date.now() >= cached.refreshAt) {
      cached = { token: await mintDevToken(opts), refreshAt: Date.now() + Math.max(ttl - 30, 1) * 1000 };
    }
    return cached.token;
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const roles = process.argv[2] ? process.argv[2].split(',') : undefined;
  mintDevToken({ roles }).then(
    (t) => console.log(t),
    (e: Error) => {
      console.error(e.message);
      process.exitCode = 1;
    },
  );
}
