import { z } from 'zod';
import type { Config } from '../config/env.js';
import { AppError } from '../errors.js';
import type { AuthContext } from '../types.js';

export interface PageRevisionRef {
  websiteId: string;
}

/**
 * Authoritative check that `revisionId` belongs to `pageId` AND that the caller may access it.
 * Returns null when the resource does not exist or is not visible to the caller (hidden, not 403,
 * so existence does not leak across scope boundaries). Throws AppError(502) if the upstream fails.
 */
export interface PageRevisionClient {
  resolve(input: {
    ctx: AuthContext;
    requestId: string;
    pageId: string;
    revisionId: string;
  }): Promise<PageRevisionRef | null>;
}

const upstreamSchema = z.object({
  data: z.object({
    websiteId: z.uuid(),
    pageId: z.uuid(),
    revisionId: z.uuid(),
    tenantId: z.uuid(),
    organizationId: z.uuid(),
  }),
});

/**
 * ASSUMED contract (the report leaves the exact Page/Revision contract as an open decision):
 *   GET {PAGE_REVISION_SERVICE_URL}/internal/v1/pages/{pageId}/revisions/{revisionId}
 *   200 { data: { websiteId, pageId, revisionId, tenantId, organizationId } }
 *   403/404 => not accessible.
 * Service credentials go in Authorization; verified (not browser-supplied) context goes in X-* headers.
 * Adjust this one file when the real contract is agreed.
 */
export function createHttpPageRevisionClient(config: Config): PageRevisionClient {
  const { url, serviceToken, timeoutMs } = config.pageRevision;
  return {
    async resolve({ ctx, requestId, pageId, revisionId }) {
      const endpoint = `${url!.replace(/\/+$/, '')}/internal/v1/pages/${encodeURIComponent(pageId)}/revisions/${encodeURIComponent(revisionId)}`;
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Request-Id': requestId,
        'X-Tenant-Id': ctx.tenantId,
        'X-Organization-Id': ctx.organizationId,
        'X-User-Id': ctx.userId,
      };
      if (ctx.workspaceId) headers['X-Workspace-Id'] = ctx.workspaceId;
      if (ctx.softwareId) headers['X-Software-Id'] = ctx.softwareId;
      if (serviceToken) headers.Authorization = `Bearer ${serviceToken}`;

      let res: Response;
      try {
        res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        throw new AppError(502, 'UPSTREAM_UNAVAILABLE', 'A required upstream service is unavailable.', 'page_revision_unreachable');
      }
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok) {
        throw new AppError(502, 'UPSTREAM_UNAVAILABLE', 'A required upstream service is unavailable.', `page_revision_status_${res.status}`);
      }
      const parsed = upstreamSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) {
        throw new AppError(502, 'UPSTREAM_UNAVAILABLE', 'A required upstream service is unavailable.', 'page_revision_bad_payload');
      }
      const d = parsed.data.data;
      // Never trust the upstream blindly: the answer must be for exactly what we asked, in the caller's scope.
      if (
        d.pageId !== pageId ||
        d.revisionId !== revisionId ||
        d.tenantId !== ctx.tenantId ||
        d.organizationId !== ctx.organizationId
      ) {
        return null;
      }
      return { websiteId: d.websiteId };
    },
  };
}

/** Local-development stand-in. Config refuses to enable it when NODE_ENV=production. */
export function createStubPageRevisionClient(): PageRevisionClient {
  return {
    async resolve() {
      return { websiteId: '00000000-0000-4000-8000-0000000000a1' };
    },
  };
}

export function createPageRevisionClient(config: Config): PageRevisionClient {
  return config.pageRevision.mode === 'stub' ? createStubPageRevisionClient() : createHttpPageRevisionClient(config);
}
