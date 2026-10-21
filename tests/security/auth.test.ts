import { exportJWK, exportSPKI, generateKeyPair } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { createJwtVerifier, createLocalJWKSet } from '../../src/middleware/authenticate.js';
import {
  AUDIENCE, b64url, createHarness, defaultClaims, envFor, generateKeys, ID, ISSUER, signJwt, truncate,
  type Harness,
} from '../helpers/harness.js';

let h: Harness;
const url = `/api/v1/pages/${ID.page}/previews`;
const body = { revisionId: ID.revision };
const now = () => Math.floor(Date.now() / 1000);

beforeAll(async () => { h = await createHarness(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await truncate(h.pool); });

async function expectUnauthenticated(authorization?: string) {
  const req = request(h.app).post(url).send(body);
  const res = await (authorization === undefined ? req : req.set('Authorization', authorization));
  expect(res.status).toBe(401);
  expect(res.body.error.code).toBe('UNAUTHENTICATED');
  expect(res.body.success).toBe(false);
  // Generic message: no hint about WHY (expired vs bad signature vs wrong audience).
  expect(res.body.error.message).toBe('Authentication is required.');
  expect(res.body.meta.requestId).toBeTruthy();
}

describe('JWT validation on protected routes', () => {
  it('rejects a missing Authorization header', async () => expectUnauthenticated());
  it('rejects a non-Bearer scheme', async () => expectUnauthenticated('Basic dXNlcjpwYXNz'));
  it('rejects an empty bearer value', async () => expectUnauthenticated('Bearer '));
  it('rejects a malformed token', async () => {
    await expectUnauthenticated('Bearer not-a-jwt');
    await expectUnauthenticated('Bearer a.b.c');
    await expectUnauthenticated('Bearer ###');
  });
  it('rejects an expired token', async () =>
    expectUnauthenticated(await h.bearer({ exp: now() - 3600 })));
  it('rejects a token that is not yet valid (nbf in the future)', async () =>
    expectUnauthenticated(await h.bearer({ nbf: now() + 3600 })));
  it('rejects the wrong issuer', async () =>
    expectUnauthenticated(await h.bearer({ iss: 'https://evil.invalid' })));
  it('rejects the wrong audience', async () =>
    expectUnauthenticated(await h.bearer({ aud: 'some-other-api' })));
  it('rejects a token signed by a different key (invalid signature)', async () => {
    const other = await generateKeys();
    await expectUnauthenticated(await h.bearer({ key: other.privateKey }));
  });
  it('rejects a tampered payload', async () => {
    const [header, , sig] = (await h.sign()).split('.');
    const forged = b64url({ ...defaultClaims(), iss: ISSUER, aud: AUDIENCE, exp: now() + 600, tenant_id: ID.tenantB });
    await expectUnauthenticated(`Bearer ${header}.${forged}.${sig}`);
  });
  it('rejects unsigned tokens (alg=none)', async () => {
    const payload = { ...defaultClaims(), iss: ISSUER, aud: AUDIENCE, exp: now() + 600 };
    await expectUnauthenticated(`Bearer ${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.`);
  });
  it('rejects HS256 tokens signed with the public key as secret (algorithm confusion)', async () => {
    const { SignJWT } = await import('jose');
    const pem = await exportSPKI(h.keys.publicKey);
    const token = await new SignJWT({ ...defaultClaims(), iss: ISSUER, aud: AUDIENCE })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(pem));
    await expectUnauthenticated(`Bearer ${token}`);
  });
  it('rejects an algorithm that is not on the allow-list (ES256 when only RS256 is allowed)', async () => {
    const es = await generateKeyPair('ES256');
    await expectUnauthenticated(await h.bearer({ key: es.privateKey, alg: 'ES256' }));
  });
  it.each(['exp', 'sub', 'tenant_id', 'organization_id'])('rejects a token missing required claim %s', async (claim) =>
    expectUnauthenticated(await h.bearer({ omit: [claim] })));
  it.each([['sub'], ['tenant_id'], ['organization_id'], ['workspace_id']])(
    'rejects a non-UUID %s claim',
    async (claim) => expectUnauthenticated(await h.bearer({ claims: { [claim]: 'not-a-uuid' } })),
  );
  it('rejects the opaque preview token used as a Bearer credential', async () => {
    const created = await request(h.app).post(url).set('Authorization', await h.bearer()).send(body);
    const token = created.body.data.previewUrl.split('/p/')[1];
    await expectUnauthenticated(`Bearer ${token}`);
  });
  it('protects DELETE as well', async () => {
    const res = await request(h.app).delete(`/api/v1/previews/${'a'.repeat(43)}`);
    expect(res.status).toBe(401);
  });
  it('accepts a valid token', async () => {
    const res = await request(h.app).post(url).set('Authorization', await h.bearer()).send(body);
    expect(res.status).toBe(201);
  });
});

describe('trusted request context (spoofed X-* headers)', () => {
  const post = async (headers: Record<string, string>) =>
    request(h.app).post(url).set('Authorization', await h.bearer()).set(headers).send(body);

  it('rejects X-Tenant-Id that differs from the JWT', async () => {
    const res = await post({ 'X-Tenant-Id': ID.tenantB });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
  it('rejects X-Organization-Id that differs from the JWT', async () => {
    expect((await post({ 'X-Organization-Id': ID.orgA2 })).status).toBe(403);
  });
  it('rejects X-User-Id that differs from the JWT', async () => {
    expect((await post({ 'X-User-Id': ID.userB })).status).toBe(403);
  });
  it('rejects X-Workspace-Id / X-Software-Id when the JWT carries none', async () => {
    expect((await post({ 'X-Workspace-Id': ID.wsA })).status).toBe(403);
    expect((await post({ 'X-Software-Id': ID.wsA })).status).toBe(403);
  });
  it('accepts context headers that agree with the JWT', async () => {
    const res = await post({ 'X-Tenant-Id': ID.tenantA, 'X-Organization-Id': ID.orgA1, 'X-User-Id': ID.userA });
    expect(res.status).toBe(201);
  });
  it('never takes identity from the body or query', async () => {
    const res = await request(h.app)
      .post(`${url}?tenantId=${ID.tenantB}`)
      .set('Authorization', await h.bearer())
      .send({ ...body, tenantId: ID.tenantB, userId: ID.userB, role: 'owner' });
    expect(res.status).toBe(400);
    const ok = await request(h.app).post(`${url}?tenantId=${ID.tenantB}`).set('Authorization', await h.bearer()).send(body);
    expect(ok.status).toBe(201);
    const row = await h.pool.query('SELECT tenant_id, created_by_user_id FROM preview_sessions');
    expect(row.rows[0]).toEqual({ tenant_id: ID.tenantA, created_by_user_id: ID.userA });
  });
});

describe('key rotation (JWKS)', () => {
  it('accepts tokens from a newly published key, rejects unknown kids, keeps honouring the old key', async () => {
    const oldPair = await generateKeyPair('RS256', { extractable: true });
    const newPair = await generateKeyPair('RS256', { extractable: true });
    const oldJwk = { ...(await exportJWK(oldPair.publicKey)), kid: 'old', alg: 'RS256', use: 'sig' };
    const newJwk = { ...(await exportJWK(newPair.publicKey)), kid: 'new', alg: 'RS256', use: 'sig' };
    const config = loadConfig(envFor(await exportSPKI(oldPair.publicKey)));

    const before = createJwtVerifier(config.jwt, createLocalJWKSet({ keys: [oldJwk] }));
    const after = createJwtVerifier(config.jwt, createLocalJWKSet({ keys: [oldJwk, newJwk] }));
    const oldToken = await signJwt(oldPair.privateKey, { kid: 'old' });
    const newToken = await signJwt(newPair.privateKey, { kid: 'new' });
    const unknownKid = await signJwt(newPair.privateKey, { kid: 'ghost' });

    await expect(before(oldToken)).resolves.toMatchObject({ userId: ID.userA });
    await expect(before(newToken)).rejects.toMatchObject({ status: 401 }); // new key not published yet
    await expect(after(newToken)).resolves.toMatchObject({ tenantId: ID.tenantA });
    await expect(after(oldToken)).resolves.toMatchObject({ userId: ID.userA }); // overlap window
    await expect(after(unknownKid)).rejects.toMatchObject({ status: 401 });
  });
});
