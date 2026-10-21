import { randomUUID } from 'node:crypto';
import type { Config } from '../../config/env.js';
import { notFound, previewUnavailable } from '../../errors.js';
import type { PageRevisionClient } from '../../integrations/pageRevisionClient.js';
import type { Logger } from '../../observability/logger.js';
import type { AuthContext } from '../../types.js';
import { assertCanCreate, assertCanRevoke } from './preview.authorization.js';
import type { PreviewRepository } from './preview.repository.js';
import { generateToken, hashToken, TOKEN_PATTERN } from './preview.token.js';
import type { RendererContext } from './preview.types.js';

export class PreviewService {
  constructor(
    private readonly config: Config,
    private readonly repo: PreviewRepository,
    private readonly pageRevisions: PageRevisionClient,
    private readonly logger: Logger,
  ) {}

  async create(input: {
    ctx: AuthContext;
    requestId: string;
    pageId: string;
    revisionId: string;
    expiresInSeconds: number;
  }): Promise<{ previewUrl: string; expiresAt: string }> {
    const { ctx, requestId, pageId, revisionId, expiresInSeconds } = input;
    assertCanCreate(ctx);

    // Authoritative ownership + access check (page <-> revision, caller's tenant/org).
    const ref = await this.pageRevisions.resolve({ ctx, requestId, pageId, revisionId });
    if (!ref) throw notFound();

    const token = generateToken();
    const id = randomUUID(); // v4 until the platform confirms UUIDv7 vs BIGINT (report §15)
    const { expiresAt } = await this.repo.insert({
      id,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
      softwareId: ctx.softwareId,
      websiteId: ref.websiteId,
      pageId,
      revisionId,
      tokenHash: hashToken(token),
      createdByUserId: ctx.userId,
      ttlSeconds: expiresInSeconds,
    });

    this.logger.info({
      event: 'preview.created',
      requestId,
      sessionId: id,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      pageId,
      revisionId,
      expiresAt: expiresAt.toISOString(),
    });

    return { previewUrl: `${this.config.preview.origin}/p/${token}`, expiresAt: expiresAt.toISOString() };
  }

  /** Unknown, malformed, expired and revoked tokens are indistinguishable to the caller. */
  async resolve(token: string, requestId: string): Promise<RendererContext> {
    if (!TOKEN_PATTERN.test(token)) throw previewUnavailable();
    const context = await this.repo.resolveActive(hashToken(token));
    if (!context) {
      this.logger.info({ event: 'preview.resolve_unavailable', requestId });
      throw previewUnavailable();
    }
    return context;
  }

  async revoke(input: { ctx: AuthContext; requestId: string; token: string }): Promise<void> {
    const { ctx, requestId, token } = input;
    if (!TOKEN_PATTERN.test(token)) throw notFound();
    const session = await this.repo.findScoped(ctx, hashToken(token));
    if (!session) throw notFound(); // also covers other tenants/orgs: existence is not revealed
    assertCanRevoke(ctx, session);
    await this.repo.revoke(ctx, session.id);
    this.logger.info({
      event: 'preview.revoked',
      requestId,
      sessionId: session.id,
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    });
  }
}
