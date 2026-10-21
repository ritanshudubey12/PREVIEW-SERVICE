# TriostackOne Preview API

Creates, resolves and revokes temporary previews of an exact page revision, without publishing.
Node.js + TypeScript + Express 5 + PostgreSQL. See the technical report for the full specification.

## Quick start

```bash
cp .env.example .env            # then fill in values (.env is git-ignored)
docker compose up -d db         # PostgreSQL 16
npm install
npm run migrate                 # applies ./migrations
npm run dev                     # http://localhost:3000
npm run smoke                   # create -> resolve -> revoke against the running service
npm test                        # uses a separate "<DB_NAME>_test" database
```

## API (`/api/v1`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/pages/:pageId/previews` | Bearer JWT | body `{ revisionId, expiresInSeconds? }` -> `201 { previewUrl, expiresAt }` |
| GET | `/previews/:token` | preview token | renderer-safe context only; uniform `410` for unknown/expired/revoked |
| DELETE | `/previews/:token` | Bearer JWT | creator or owner/admin/editor in the same tenant/org/workspace -> `204` |
| GET | `/health/live`, `/health/ready` | none | liveness / readiness (DB reachable) |

Spec: [openapi/openapi.yaml](openapi/openapi.yaml) (OpenAPI 3.1). Errors use
`{ success:false, error:{code,message}, meta:{requestId} }`.

## Authentication

The service validates the JWT itself (`Authorization: Bearer <jwt>`): signature, allow-listed
asymmetric algorithm, `iss`, `aud`, `exp`, `nbf`, and required claims `sub`, `tenant_id`,
`organization_id` (UUIDs); optional `workspace_id`, `software_id`, `roles[]`.
Identity comes **only** from the verified token. `X-Tenant-Id` / `X-Organization-Id` / `X-User-Id` /
`X-Workspace-Id` / `X-Software-Id` are never trusted: a value that disagrees with the token is
rejected (403); agreeing values are stripped.

Roles `owner`, `admin`, `editor` may create previews; revoke needs the same roles or being the creator.

### Bearer token is attached automatically
`src/client/previewClient.ts` (`PreviewApiClient`) calls `getToken()` before every protected request and
sets `Authorization: Bearer ...` (plus `X-Request-Id`). For local development `scripts/devToken.ts`
supplies a provider that signs a short-lived JWT with the dev private key and re-mints it before expiry.
`npm run dev:token [roles]` prints one for curl/Postman.

## Postman

```bash
npm run test:postman           # both collections: mock Page/Revision API + service on :3001 + Newman, then log-leak checks
npm run test:postman:success   # success flows only; also asserts every response is 200/201/204
npm run test:postman:negative  # security/error cases only (4xx/410/413/429 are the CORRECT results here)
npm run postman:env            # only (re)generate postman/local.postman_environment.json for the Postman app
npm run postman:build          # only regenerate the two collection files
```

Two collections are generated:
- `postman/preview-api.success.postman_collection.json` - happy paths only, every request returns 2xx.
- `postman/preview-api.negative.postman_collection.json` - the full suite, including its setup steps.
  Rejections here are intentional (e.g. no token -> 401, revoked preview -> 410); a green test means
  the API refused correctly. The API does not return 200 for errors: that would break the spec's
  status contract and hide real failures from clients.

To use the Postman app: start the service (`npm run dev`, with `PAGE_REVISION_MODE=stub`), run
`npm run postman:env`, then import a collection plus `postman/local.postman_environment.json`
and select that environment. The collection sets
`Authorization: Bearer {{jwt_editor}}` on every request automatically; individual requests override it
with other pre-signed tokens (viewer, other tenant, expired, wrong audience, ...). The environment file
holds live tokens (valid 1 hour) and is git-ignored. Cases that need a real Page/Revision authority
(revision/page ownership 404s) only pass under `npm run postman`, which supplies the mock.

## Configuration and secrets

All credentials live in `.env`, which is listed in `.gitignore` (as are `.env.*`, `*.pem`, `*.key`);
only `.env.example` (no values) is committed. The container image contains no `.env`; `docker-compose.yml`
reads credentials from it at runtime. The service refuses to start on missing/invalid settings.

Set exactly one of `JWT_PUBLIC_KEY` (PEM, `\n`-escaped on one line) or `JWT_JWKS_URL` (supports key rotation).
`DEV_JWT_PRIVATE_KEY` is for local token minting only and must not exist outside development.

## Open decisions from the report (§15)

1. **IDs** — UUID columns, generated as v4. Switch to UUIDv7 (or BIGINT) once the platform decides.
2. **JWT validation** — implemented service-side. If a trusted gateway validates instead, replace
   `authenticate` with a gateway-header reader that is only reachable on private ingress.
3. **Page/Revision & renderer contracts** — `src/integrations/pageRevisionClient.ts` implements an
   *assumed* HTTP contract (documented in the file). `PAGE_REVISION_MODE=stub` (dev only, refused in
   production) accepts any page/revision. Adjust this one file when the real contract exists.
4. **workspaceId / softwareId** — optional. When present in the JWT they are stored, and workspace is
   enforced as a boundary on revoke.

## Not implemented (by design or pending)

- `Idempotency-Key`: recommended, not required. Replaying a create would need the raw token, which is
  deliberately never stored, so retries create a new session.
- Expired-row cleanup job (resolution checks expiry synchronously regardless).
- Metrics endpoint, Redis cache, least-privilege DB role/mTLS (deployment concerns).
