import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import { createHarness, ID, truncate, type Harness, type SignOptions } from '../helpers/harness.js';

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
afterAll(async () => { await h.close(); });
beforeEach(async () => { await truncate(h.pool); });

const A: SignOptions = {}; // default: tenant A / org A1 / user A / editor
const tokenOf = (res: request.Response): string => res.body.data.previewUrl.split('/p/')[1];

async function create(opts: SignOptions = A, body: unknown = { revisionId: ID.revision }, pageId = ID.page) {
  return request(h.app).post(`/api/v1/pages/${pageId}/previews`).set('Authorization', await h.bearer(opts)).send(body as object);
}
const resolve = (token: string) => request(h.app).get(`/api/v1/previews/${token}`);
async function revoke(token: string, opts: SignOptions = A) {
  return request(h.app).delete(`/api/v1/previews/${token}`).set('Authorization', await h.bearer(opts));
}

describe('create', () => {
  it('returns 201 with the standard envelope, an opaque URL and an expiry', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.previewUrl).toMatch(/^https:\/\/preview\.test\.invalid\/p\/[A-Za-z0-9_-]{43}$/);
    const ttl = (Date.parse(res.body.data.expiresAt) - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(1780);
    expect(ttl).toBeLessThanOrEqual(1800);
    expect(res.body.meta.requestId).toBe(res.headers['x-request-id']);
    expect(Object.keys(res.body.data).sort()).toEqual(['expiresAt', 'previewUrl']);
  });

  it('honours a bounded expiresInSeconds', async () => {
    const res = await create(A, { revisionId: ID.revision, expiresInSeconds: 120 });
    const ttl = (Date.parse(res.body.data.expiresAt) - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(100);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('stores only the SHA-256 hash and the creator scope, never the raw token', async () => {
    const token = tokenOf(await create());
    const { rows } = await h.pool.query('SELECT * FROM preview_sessions');
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].token_hash).equals(createHash('sha256').update(token).digest())).toBe(true);
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(rows[0]).toMatchObject({
      tenant_id: ID.tenantA, organization_id: ID.orgA1, created_by_user_id: ID.userA,
      website_id: ID.website, page_id: ID.page, revision_id: ID.revision, revoked_at: null,
    });
  });

  it('issues a different token for every session', async () => {
    const a = tokenOf(await create());
    const b = tokenOf(await create());
    expect(a).not.toBe(b);
  });

  it.each([
    ['non-UUID page id', ID.page.slice(0, 10), { revisionId: ID.revision }],
    ['missing revisionId', ID.page, {}],
    ['non-UUID revisionId', ID.page, { revisionId: 'abc' }],
    ['ttl below minimum', ID.page, { revisionId: ID.revision, expiresInSeconds: 5 }],
    ['ttl above maximum', ID.page, { revisionId: ID.revision, expiresInSeconds: 86401 }],
    ['non-integer ttl', ID.page, { revisionId: ID.revision, expiresInSeconds: 90.5 }],
    ['string ttl', ID.page, { revisionId: ID.revision, expiresInSeconds: '600' }],
    ['unknown field', ID.page, { revisionId: ID.revision, extra: true }],
  ])('400 VALIDATION_ERROR for %s', async (_name, pageId, body) => {
    const res = await create(A, body, pageId);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.success).toBe(false);
  });

  it('400 for malformed JSON and for a non-JSON content type', async () => {
    const auth = await h.bearer();
    const bad = await request(h.app).post(`/api/v1/pages/${ID.page}/previews`)
      .set('Authorization', auth).set('Content-Type', 'application/json').send('{"revisionId": ');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const text = await request(h.app).post(`/api/v1/pages/${ID.page}/previews`)
      .set('Authorization', auth).set('Content-Type', 'text/plain').send('hello');
    expect(text.status).toBe(400);
  });

  it('413 for an oversized body', async () => {
    const res = await create(A, { revisionId: ID.revision, pad: 'x'.repeat(20000) });
    expect(res.status).toBe(413);
  });

  it('404 when the revision does not belong to the page / is not visible to the caller', async () => {
    const res = await create(A, { revisionId: ID.revision2 }, ID.page2);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await h.pool.query('SELECT 1 FROM preview_sessions')).rowCount).toBe(0);
  });

  it.each([[['viewer']], [[]], [['guest', 'commenter']]])('403 for roles %j (read-only roles cannot create)', async (roles) => {
    const res = await create({ claims: { roles } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('does not call the Page/Revision authority for unauthorised roles', async () => {
    const before = h.fake.calls;
    await create({ claims: { roles: ['viewer'] } });
    expect(h.fake.calls).toBe(before);
  });
});

describe('resolve', () => {
  it('returns only renderer-safe context with no-store / noindex / no-referrer headers', async () => {
    const token = tokenOf(await create());
    const res = await resolve(token);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['expiresAt', 'pageId', 'readOnly', 'revisionId', 'websiteId']);
    expect(res.body.data).toMatchObject({ pageId: ID.page, revisionId: ID.revision, websiteId: ID.website, readOnly: true });
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const raw = JSON.stringify(res.body);
    for (const leaked of [ID.tenantA, ID.orgA1, ID.userA]) expect(raw).not.toContain(leaked);
  });

  it('does not require (or accept) a JWT: the preview token is the credential', async () => {
    const token = tokenOf(await create());
    expect((await resolve(token).set('Authorization', 'Bearer garbage')).status).toBe(200);
  });

  it('records last_accessed_at', async () => {
    const token = tokenOf(await create());
    expect((await h.pool.query('SELECT last_accessed_at FROM preview_sessions')).rows[0].last_accessed_at).toBeNull();
    await resolve(token);
    expect((await h.pool.query('SELECT last_accessed_at FROM preview_sessions')).rows[0].last_accessed_at).not.toBeNull();
  });

  it('returns an identical 410 for unknown, malformed, expired and revoked tokens (no enumeration)', async () => {
    const expiredTok = tokenOf(await create());
    await h.pool.query(`UPDATE preview_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'`);
    const revokedTok = tokenOf(await create());
    expect((await revoke(revokedTok)).status).toBe(204);

    const bodies = [];
    for (const t of [expiredTok, revokedTok, 'A'.repeat(43), 'short', 'x'.repeat(200)]) {
      const res = await resolve(t);
      expect(res.status, t).toBe(410);
      bodies.push({ code: res.body.error.code, message: res.body.error.message });
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toEqual({ code: 'PREVIEW_UNAVAILABLE', message: 'This preview is no longer available.' });
  });

  it('checks expiry on every resolution (works, then stops working at the boundary)', async () => {
    const token = tokenOf(await create());
    expect((await resolve(token)).status).toBe(200);
    await h.pool.query(`UPDATE preview_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second'`);
    expect((await resolve(token)).status).toBe(410);
  });
});

describe('revoke', () => {
  it('204, then the token stops resolving; revoking again is idempotent and keeps the first revoked_at', async () => {
    const token = tokenOf(await create());
    expect((await revoke(token)).status).toBe(204);
    expect((await resolve(token)).status).toBe(410);
    const first = (await h.pool.query('SELECT revoked_at FROM preview_sessions')).rows[0].revoked_at;
    expect((await revoke(token)).status).toBe(204);
    const second = (await h.pool.query('SELECT revoked_at FROM preview_sessions')).rows[0].revoked_at;
    expect(second).toEqual(first);
  });

  it('possession of the preview token alone cannot revoke it', async () => {
    const token = tokenOf(await create());
    const res = await request(h.app).delete(`/api/v1/previews/${token}`);
    expect(res.status).toBe(401);
    expect((await resolve(token)).status).toBe(200);
  });

  it('the creator may revoke even after losing manager roles', async () => {
    const token = tokenOf(await create());
    expect((await revoke(token, { claims: { roles: ['viewer'] } })).status).toBe(204);
  });

  it('another user in the same org without a manager role gets 403 and the preview stays live', async () => {
    const token = tokenOf(await create());
    const res = await revoke(token, { claims: { sub: ID.userA2, roles: ['viewer'] } });
    expect(res.status).toBe(403);
    expect((await resolve(token)).status).toBe(200);
  });

  it('another editor in the same org may revoke', async () => {
    const token = tokenOf(await create());
    expect((await revoke(token, { claims: { sub: ID.userA2, roles: ['editor'] } })).status).toBe(204);
  });

  it('404 for unknown or malformed tokens', async () => {
    expect((await revoke('A'.repeat(43))).status).toBe(404);
    expect((await revoke('nope')).status).toBe(404);
  });
});

describe('tenant / organization / workspace isolation', () => {
  const tenantB: SignOptions = { claims: { sub: ID.userB, tenant_id: ID.tenantB, organization_id: ID.orgB1, roles: ['owner'] } };

  it("tenant B cannot create a preview for tenant A's page", async () => {
    const res = await create(tenantB, { revisionId: ID.revision }, ID.page);
    expect(res.status).toBe(404);
    expect((await h.pool.query('SELECT 1 FROM preview_sessions')).rowCount).toBe(0);
  });

  it("tenant B cannot revoke tenant A's preview (404, not 403) and it keeps working", async () => {
    const token = tokenOf(await create());
    const res = await revoke(token, tenantB);
    expect(res.status).toBe(404);
    expect((await resolve(token)).status).toBe(200);
    expect((await h.pool.query('SELECT revoked_at FROM preview_sessions')).rows[0].revoked_at).toBeNull();
  });

  it('tenant is enforced independently of organization (same org id, different tenant)', async () => {
    const token = tokenOf(await create());
    const crossTenantSameOrg = { claims: { sub: ID.userB, tenant_id: ID.tenantB, organization_id: ID.orgA1, roles: ['owner'] } };
    expect((await revoke(token, crossTenantSameOrg)).status).toBe(404);
    expect((await resolve(token)).status).toBe(200);
    expect((await h.pool.query('SELECT revoked_at FROM preview_sessions')).rows[0].revoked_at).toBeNull();
  });

  it('organization is enforced independently of tenant (same tenant, different org)', async () => {
    const token = tokenOf(await create());
    const res = await revoke(token, { claims: { sub: ID.userA2, organization_id: ID.orgA2, roles: ['owner'] } });
    expect(res.status).toBe(404);
  });

  it('a different organization in the same tenant cannot revoke', async () => {
    const token = tokenOf(await create());
    const res = await revoke(token, { claims: { sub: ID.userA2, organization_id: ID.orgA2, roles: ['owner'] } });
    expect(res.status).toBe(404);
    expect((await resolve(token)).status).toBe(200);
  });

  it('tenant B has its own working flow with its own data', async () => {
    const res = await create(tenantB, { revisionId: ID.revision2 }, ID.page2);
    expect(res.status).toBe(201);
    const token = tokenOf(res);
    expect((await resolve(token)).body.data.pageId).toBe(ID.page2);
    expect((await revoke(token, tenantB)).status).toBe(204);
  });

  it('workspace is an enforced boundary on revoke', async () => {
    const ws = { claims: { workspace_id: ID.wsA } };
    const token = tokenOf(await create(ws));
    expect((await revoke(token, { claims: { workspace_id: ID.wsB, sub: ID.userA2, roles: ['owner'] } })).status).toBe(404);
    expect((await revoke(token, { claims: { sub: ID.userA2, roles: ['owner'] } })).status).toBe(404); // no workspace
    expect((await resolve(token)).status).toBe(200);
    expect((await revoke(token, ws)).status).toBe(204);
  });

  it('a workspace-scoped caller cannot revoke a session that has no workspace', async () => {
    const token = tokenOf(await create());
    expect((await revoke(token, { claims: { workspace_id: ID.wsA } })).status).toBe(404);
  });
});

describe('concurrency', () => {
  it('concurrent resolve + revoke never errors, and nothing resolves after the revoke has completed', async () => {
    const token = tokenOf(await create());
    const results = await Promise.all([
      ...Array.from({ length: 15 }, () => resolve(token)),
      revoke(token),
      ...Array.from({ length: 15 }, () => resolve(token)),
    ]);
    for (const r of results) expect([200, 204, 410]).toContain(r.status);
    expect((await resolve(token)).status).toBe(410);
  });

  it('parallel creates all succeed with distinct tokens', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => create()));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map(tokenOf)).size).toBe(20);
  });
});

describe('request ids, errors, health, logs', () => {
  it('echoes a valid X-Request-Id and replaces an invalid one', async () => {
    const ok = await request(h.app).get('/health/live').set('X-Request-Id', 'trace-1234-abcd');
    expect(ok.headers['x-request-id']).toBe('trace-1234-abcd');
    const bad = await request(h.app).get('/health/live').set('X-Request-Id', 'bad id with spaces!!');
    expect(bad.headers['x-request-id']).toMatch(/^req_[0-9a-f-]{36}$/);
  });

  it('errors use the standard envelope with the request id', async () => {
    const res = await request(h.app).get('/api/v1/nope').set('X-Request-Id', 'trace-1234-abcd');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
      meta: { requestId: 'trace-1234-abcd' },
    });
  });

  it('exposes only the canonical routes (no singular aliases)', async () => {
    const auth = await h.bearer();
    expect((await request(h.app).post(`/api/v1/pages/${ID.page}/preview`).set('Authorization', auth).send({})).status).toBe(404);
    expect((await request(h.app).post('/api/v1/previews').set('Authorization', auth).send({})).status).toBe(404);
  });

  it('health: live and ready', async () => {
    expect((await request(h.app).get('/health/live')).body).toEqual({ status: 'ok' });
    expect((await request(h.app).get('/health/ready')).body).toEqual({ status: 'ready' });
  });

  it('never writes JWTs, preview tokens or the Authorization header to logs, but audits create/revoke/denials', async () => {
    const jwt = await h.sign();
    const created = await request(h.app).post(`/api/v1/pages/${ID.page}/previews`)
      .set('Authorization', `Bearer ${jwt}`).send({ revisionId: ID.revision });
    const token = tokenOf(created);
    await resolve(token);
    await request(h.app).delete(`/api/v1/previews/${token}`).set('Authorization', `Bearer ${jwt}`);
    await resolve(token);
    await request(h.app).post(`/api/v1/pages/${ID.page}/previews`).set('Authorization', 'Bearer bad.jwt.value').send({});

    const logs = h.logLines();
    expect(logs).not.toContain(jwt);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain('Bearer ');
    expect(logs).toContain('"event":"preview.created"');
    expect(logs).toContain('"event":"preview.revoked"');
    expect(logs).toContain('"event":"security.denied"');
  });

  it('500 responses are generic: no stack, SQL or internal message', async () => {
    const original = h.fake.resolve.bind(h.fake);
    h.fake.resolve = async () => { throw new Error('SELECT * FROM secret_table failed at /srv/app.ts'); };
    const res = await create();
    h.fake.resolve = original;
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' });
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|secret_table|app\.ts|stack/);
  });

  it('surfaces upstream failures as 502 UPSTREAM_UNAVAILABLE without detail', async () => {
    const original = h.fake.resolve.bind(h.fake);
    h.fake.resolve = async () => { throw new AppError(502, 'UPSTREAM_UNAVAILABLE', 'A required upstream service is unavailable.', 'internal-detail'); };
    const res = await create();
    h.fake.resolve = original;
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('internal-detail');
  });
});

describe('rate limiting', () => {
  it('limits session creation per actor with a 429 envelope', async () => {
    const limited = await createHarness({ RATE_LIMIT_WRITE_MAX: '3' });
    try {
      const statuses: number[] = [];
      let last: request.Response | undefined;
      for (let i = 0; i < 5; i++) {
        last = await request(limited.app).post(`/api/v1/pages/${ID.page}/previews`)
          .set('Authorization', await limited.bearer()).send({ revisionId: ID.revision });
        statuses.push(last.status);
      }
      expect(statuses).toEqual([201, 201, 201, 429, 429]);
      expect(last!.body.error.code).toBe('RATE_LIMITED');
      // another actor is unaffected
      const other = await request(limited.app).post(`/api/v1/pages/${ID.page}/previews`)
        .set('Authorization', await limited.bearer({ claims: { sub: ID.userA2 } })).send({ revisionId: ID.revision });
      expect(other.status).toBe(201);
    } finally {
      await limited.pool.query('TRUNCATE preview_sessions');
      await limited.close();
    }
  });

  it('limits resolution attempts', async () => {
    const limited = await createHarness({ RATE_LIMIT_RESOLVE_MAX: '2' });
    try {
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await request(limited.app).get(`/api/v1/previews/${'A'.repeat(43)}`)).status);
      expect(codes).toEqual([410, 410, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('database constraints', () => {
  const insert = (hash: Buffer, created: string, expires: string) =>
    h.pool.query(
      `INSERT INTO preview_sessions (id, tenant_id, organization_id, website_id, page_id, revision_id, token_hash, created_by_user_id, created_at, expires_at)
       VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz)`,
      [ID.tenantA, ID.orgA1, ID.website, ID.page, ID.revision, hash, ID.userA, created, expires],
    );

  it('enforces unique token_hash, hash length and expires_at > created_at', async () => {
    const hash = createHash('sha256').update('x').digest();
    await insert(hash, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z');
    await expect(insert(hash, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')).rejects.toMatchObject({ code: '23505' });
    await expect(insert(Buffer.alloc(8), '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(Buffer.alloc(32, 1), '2026-01-01T01:00:00Z', '2026-01-01T00:00:00Z')).rejects.toMatchObject({ code: '23514' });
  });

  it('has the specified indexes', async () => {
    const { rows } = await h.pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'preview_sessions'`);
    const names = rows.map((r) => r.indexname);
    expect(names).toEqual(expect.arrayContaining(['preview_scope_idx', 'preview_expiry_idx', 'preview_creator_idx']));
  });
});
