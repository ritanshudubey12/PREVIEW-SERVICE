CREATE TABLE preview_sessions (
  id                 UUID PRIMARY KEY,
  tenant_id          UUID NOT NULL,
  organization_id    UUID NOT NULL,
  workspace_id       UUID NULL,
  software_id        UUID NULL,
  website_id         UUID NOT NULL,
  page_id            UUID NOT NULL,
  revision_id        UUID NOT NULL,
  token_hash         BYTEA NOT NULL UNIQUE,
  created_by_user_id UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ NULL,
  last_accessed_at   TIMESTAMPTZ NULL,
  CONSTRAINT preview_expiry_after_create CHECK (expires_at > created_at),
  CONSTRAINT preview_token_hash_len CHECK (octet_length(token_hash) = 32)
);

CREATE INDEX preview_scope_idx ON preview_sessions
  (tenant_id, organization_id, website_id, page_id);

CREATE INDEX preview_expiry_idx ON preview_sessions (expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX preview_creator_idx ON preview_sessions
  (tenant_id, organization_id, created_by_user_id, created_at DESC);
