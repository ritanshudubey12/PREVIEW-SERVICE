/**
 * Generates the Postman environment: pre-signed JWTs for every scenario (valid roles, other
 * tenants/orgs/workspaces and deliberately broken tokens). Output is git-ignored because it holds
 * live bearer tokens. Re-run (`npm run postman:env`) when they expire (default 1 hour).
 */
import { createPrivateKey, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { generateKeyPair, SignJWT } from 'jose';
import { FIXTURE } from './mockPageRevision.js';

export const ENV_FILE = 'postman/local.postman_environment.json';

const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_A2 = '34343434-3434-4343-8343-343434343434';
const USER_B = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const ORG_A2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const WS_1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const WS_2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const SOFTWARE = '99999999-9999-4999-8999-999999999999';
const RATE_USER = 'ababcdcd-abab-4cdc-8dcd-ababcdcdabab';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

export async function buildEnvironment(baseUrl: string, ttlSeconds = 3600) {
  const { DEV_JWT_PRIVATE_KEY, JWT_ISSUER, JWT_AUDIENCE } = process.env;
  if (!DEV_JWT_PRIVATE_KEY || !JWT_ISSUER || !JWT_AUDIENCE) throw new Error('Set DEV_JWT_PRIVATE_KEY, JWT_ISSUER, JWT_AUDIENCE in .env');
  const key = createPrivateKey(DEV_JWT_PRIVATE_KEY.replace(/\\n/g, '\n'));
  const base = { tenant_id: FIXTURE.tenantA, organization_id: FIXTURE.orgA, roles: ['editor'] };

  const sign = async (o: { claims?: Record<string, unknown>; omit?: string[]; sub?: string; iss?: string; aud?: string; exp?: number; nbf?: number; key?: unknown; alg?: string } = {}) => {
    const payload: Record<string, unknown> = {
      ...base, ...o.claims, sub: o.sub ?? USER_A, iss: o.iss ?? JWT_ISSUER, aud: o.aud ?? JWT_AUDIENCE,
      iat: now(), exp: o.exp ?? now() + ttlSeconds,
    };
    if (o.nbf) payload.nbf = o.nbf;
    for (const k of o.omit ?? []) delete payload[k];
    return new SignJWT(payload as never).setProtectedHeader({ alg: o.alg ?? 'RS256', typ: 'JWT' }).sign((o.key ?? key) as never);
  };
  const other = await generateKeyPair('RS256');

  const tokens: Record<string, string> = {
    // valid identities
    jwt_editor: await sign(),
    jwt_owner: await sign({ claims: { roles: ['owner'] } }),
    jwt_viewer_creator: await sign({ claims: { roles: ['viewer'] } }), // same user as editor, demoted
    jwt_viewer_other: await sign({ sub: USER_A2, claims: { roles: ['viewer'] } }),
    jwt_editor_other: await sign({ sub: USER_A2, claims: { roles: ['editor'] } }),
    jwt_no_roles: await sign({ claims: { roles: [] } }),
    jwt_tenantB_owner: await sign({ sub: USER_B, claims: { tenant_id: FIXTURE.tenantB, organization_id: FIXTURE.orgB, roles: ['owner'] } }),
    jwt_crosstenant_sameorg: await sign({ sub: USER_B, claims: { tenant_id: FIXTURE.tenantB, roles: ['owner'] } }),
    jwt_orgA2_owner: await sign({ sub: USER_A2, claims: { organization_id: ORG_A2, roles: ['owner'] } }),
    jwt_ws1_editor: await sign({ claims: { workspace_id: WS_1, software_id: SOFTWARE } }),
    jwt_ws2_owner: await sign({ sub: USER_A2, claims: { workspace_id: WS_2, roles: ['owner'] } }),
    jwt_rate_user: await sign({ sub: RATE_USER }),
    // broken tokens - every one must be rejected with 401
    jwt_expired: await sign({ exp: now() - 3600 }),
    jwt_nbf_future: await sign({ nbf: now() + 3600 }),
    jwt_wrong_issuer: await sign({ iss: 'https://evil.invalid' }),
    jwt_wrong_audience: await sign({ aud: 'another-api' }),
    jwt_bad_signature: await sign({ key: other.privateKey }),
    jwt_missing_tenant: await sign({ omit: ['tenant_id'] }),
    jwt_missing_org: await sign({ omit: ['organization_id'] }),
    jwt_missing_sub: await sign({ omit: ['sub'] }),
    jwt_missing_exp: await sign({ exp: undefined, omit: ['exp'] }),
    jwt_non_uuid_tenant: await sign({ claims: { tenant_id: 'tenant-1' } }),
  };
  tokens.jwt_alg_none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...base, sub: USER_A, iss: JWT_ISSUER, aud: JWT_AUDIENCE, exp: now() + 3600 })}.`;
  const [h, , s] = tokens.jwt_editor!.split('.');
  tokens.jwt_tampered_payload = `${h}.${b64({ ...base, tenant_id: FIXTURE.tenantB, sub: USER_A, iss: JWT_ISSUER, aud: JWT_AUDIENCE, exp: now() + 3600 })}.${s}`;

  const ids: Record<string, string> = {
    baseUrl,
    tenantA: FIXTURE.tenantA, orgA: FIXTURE.orgA, userA: USER_A, tenantB: FIXTURE.tenantB, orgA2: ORG_A2,
    pageA: FIXTURE.pageA, revisionA: FIXTURE.revisionA, revisionA2: FIXTURE.revisionA2,
    pageA2: FIXTURE.pageA2, revisionOfPageA2: FIXTURE.revisionOfPageA2,
    pageB: FIXTURE.pageB, revisionB: FIXTURE.revisionB, websiteId: FIXTURE.websiteId,
    ws1: WS_1, ws2: WS_2, unknownPage: randomUUID(), unknownToken: 'A'.repeat(43),
  };
  const values = Object.entries({ ...ids, ...tokens }).map(([key, value]) => ({
    key, value, type: key.startsWith('jwt_') ? 'secret' : 'default', enabled: true,
  }));
  return { id: 'preview-local-env', name: 'Preview API - local', values, _postman_variable_scope: 'environment' };
}

export async function writeEnvironment(baseUrl: string) {
  mkdirSync('postman', { recursive: true });
  writeFileSync(ENV_FILE, JSON.stringify(await buildEnvironment(baseUrl), null, 2));
  return ENV_FILE;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeEnvironment(process.env.POSTMAN_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).then(
    (f) => console.log(`Wrote ${f} (import it into Postman together with postman/preview-api.postman_collection.json)`),
    (e: Error) => { console.error(e.message); process.exitCode = 1; },
  );
}
