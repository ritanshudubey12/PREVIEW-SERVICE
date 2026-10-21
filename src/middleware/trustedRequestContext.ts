import type { RequestHandler } from 'express';
import { forbidden } from '../errors.js';
import type { AuthContext } from '../types.js';

const CONTEXT_HEADERS = [
  ['x-tenant-id', (a: AuthContext) => a.tenantId],
  ['x-organization-id', (a: AuthContext) => a.organizationId],
  ['x-user-id', (a: AuthContext) => a.userId],
  ['x-workspace-id', (a: AuthContext) => a.workspaceId],
  ['x-software-id', (a: AuthContext) => a.softwareId],
] as const;

/**
 * X-* context headers are transport hints, not proof of identity. The authoritative context is
 * req.auth (from the verified JWT). A header that disagrees with the token is rejected as a
 * spoofing attempt; agreeing headers are removed so no downstream code can read them.
 * Must run after `authenticate`.
 */
export const trustedRequestContext: RequestHandler = (req, _res, next) => {
  const auth = req.auth!;
  for (const [name, expected] of CONTEXT_HEADERS) {
    const supplied = req.headers[name];
    if (supplied === undefined) continue;
    if (Array.isArray(supplied) || supplied !== expected(auth)) {
      throw forbidden(`context_header_mismatch:${name}`);
    }
    delete req.headers[name];
  }
  next();
};
