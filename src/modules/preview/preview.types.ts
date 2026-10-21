export interface PreviewSessionRow {
  id: string;
  tenantId: string;
  organizationId: string;
  workspaceId: string | null;
  websiteId: string;
  pageId: string;
  revisionId: string;
  createdByUserId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface NewPreviewSession {
  id: string;
  tenantId: string;
  organizationId: string;
  workspaceId: string | null;
  softwareId: string | null;
  websiteId: string;
  pageId: string;
  revisionId: string;
  tokenHash: Buffer;
  createdByUserId: string;
  ttlSeconds: number;
}

/** The only shape ever returned to a preview-token holder. */
export interface RendererContext {
  websiteId: string;
  pageId: string;
  revisionId: string;
  expiresAt: string;
  readOnly: true;
}
