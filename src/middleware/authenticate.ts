import { createPublicKey } from 'node:crypto';
import type { RequestHandler } from 'express';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';
import { z } from 'zod';
import type { Config } from '../config/env.js';
import { unauthenticated } from '../errors.js';
import type { AuthContext } from '../types.js';

export type JwtVerifier = (token: string) => Promise<AuthContext>;

const uuid = z.uuid();
const claimsSchema = z.object({
  sub: uuid,
  tenant_id: uuid,
  organization_id: uuid,
  workspace_id: uuid.optional(),
  software_id: uuid.optional(),
  roles: z.array(z.string().min(1).max(64)).max(32).default([]),
});

export type KeyResolver = JWTVerifyGetKey | ReturnType<typeof createPublicKey>;

function resolveKey(jwt: Config['jwt']): KeyResolver {
  if (jwt.jwksUrl) {
    // jose caches the JWKS and refetches on an unknown `kid`, which handles key rotation.
    return createRemoteJWKSet(new URL(jwt.jwksUrl));
  }
  return createPublicKey(jwt.publicKeyPem!);
}

/** Exposed for tests so rotation can be exercised with createLocalJWKSet. */
export { createLocalJWKSet };

export function createJwtVerifier(jwt: Config['jwt'], keyOverride?: KeyResolver): JwtVerifier {
  const key = keyOverride ?? resolveKey(jwt);
  return async (token) => {
    let payload: JWTPayload;
    const options = {
      issuer: jwt.issuer,
      audience: jwt.audience,
      algorithms: [...jwt.algorithms],
      clockTolerance: jwt.clockToleranceSeconds,
      requiredClaims: ['exp', 'sub', 'iss', 'aud'],
    };
    try {
      ({ payload } = typeof key === 'function' ? await jwtVerify(token, key, options) : await jwtVerify(token, key, options));
    } catch (err) {
      throw unauthenticated(`jwt_invalid:${(err as { code?: string }).code ?? 'unknown'}`);
    }
    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) throw unauthenticated('jwt_claims_invalid');
    const c = claims.data;
    return {
      userId: c.sub,
      tenantId: c.tenant_id,
      organizationId: c.organization_id,
      workspaceId: c.workspace_id ?? null,
      softwareId: c.software_id ?? null,
      roles: c.roles,
    };
  };
}

const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/;

/** Requires `Authorization: Bearer <JWT>`. All identity comes from the verified token. */
export function authenticate(verify: JwtVerifier): RequestHandler {
  return async (req, _res, next) => {
    const header = req.header('authorization');
    if (!header) throw unauthenticated('missing_authorization');
    const match = BEARER.exec(header);
    if (!match) throw unauthenticated('malformed_authorization');
    req.auth = await verify(match[1]!);
    next();
  };
}
