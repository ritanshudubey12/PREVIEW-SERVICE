import type pg from 'pg';
import type { AuthContext } from '../../types.js';
import type { NewPreviewSession, PreviewSessionRow, RendererContext } from './preview.types.js';

interface SessionDbRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  workspace_id: string | null;
  website_id: string;
  page_id: string;
  revision_id: string;
  created_by_user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

const toSession = (r: SessionDbRow): PreviewSessionRow => ({
  id: r.id,
  tenantId: r.tenant_id,
  organizationId: r.organization_id,
  workspaceId: r.workspace_id,
  websiteId: r.website_id,
  pageId: r.page_id,
  revisionId: r.revision_id,
  createdByUserId: r.created_by_user_id,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
});

/** All queries are parameterized. Every caller-facing lookup is scoped by tenant + organization (+ workspace). */
export class PreviewRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insert(s: NewPreviewSession): Promise<{ expiresAt: Date }> {
    // expires_at is computed by the database clock so it is consistent with created_at (same now()).
    const { rows } = await this.pool.query<{ expires_at: Date }>(
      `INSERT INTO preview_sessions
         (id, tenant_id, organization_id, workspace_id, software_id, website_id, page_id,
          revision_id, token_hash, created_by_user_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + make_interval(secs => $11::double precision))
       RETURNING expires_at`,
      [
        s.id, s.tenantId, s.organizationId, s.workspaceId, s.softwareId, s.websiteId,
        s.pageId, s.revisionId, s.tokenHash, s.createdByUserId, s.ttlSeconds,
      ],
    );
    return { expiresAt: rows[0]!.expires_at };
  }

  /**
   * Atomic resolve: validity (not revoked, not expired) is evaluated by the database in the same
   * statement that touches last_accessed_at, so a concurrent revoke can never be raced past.
   */
  async resolveActive(tokenHash: Buffer): Promise<RendererContext | null> {
    const { rows } = await this.pool.query<{
      website_id: string; page_id: string; revision_id: string; expires_at: Date;
    }>(
      `UPDATE preview_sessions
          SET last_accessed_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
        RETURNING website_id, page_id, revision_id, expires_at`,
      [tokenHash],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      websiteId: r.website_id,
      pageId: r.page_id,
      revisionId: r.revision_id,
      expiresAt: r.expires_at.toISOString(),
      readOnly: true,
    };
  }

  /** Scoped lookup for revoke: a session outside the caller's tenant/org/workspace is simply not found. */
  async findScoped(ctx: AuthContext, tokenHash: Buffer): Promise<PreviewSessionRow | null> {
    const { rows } = await this.pool.query<SessionDbRow>(
      `SELECT id, tenant_id, organization_id, workspace_id, website_id, page_id, revision_id,
              created_by_user_id, expires_at, revoked_at
         FROM preview_sessions
        WHERE token_hash = $1
          AND tenant_id = $2
          AND organization_id = $3
          AND workspace_id IS NOT DISTINCT FROM $4`,
      [tokenHash, ctx.tenantId, ctx.organizationId, ctx.workspaceId],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  /** Idempotent: re-revoking keeps the original revoked_at. */
  async revoke(ctx: AuthContext, sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE preview_sessions
          SET revoked_at = COALESCE(revoked_at, now())
        WHERE id = $1 AND tenant_id = $2 AND organization_id = $3`,
      [sessionId, ctx.tenantId, ctx.organizationId],
    );
  }
}
