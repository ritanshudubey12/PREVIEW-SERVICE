import { Writable } from 'node:stream';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import pg from 'pg';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import type { PageRevisionClient } from '../../src/integrations/pageRevisionClient.js';
import { createLogger } from '../../src/observability/logger.js';

export const ID = {
  tenantA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenantB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  orgA1: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
  orgA2: 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2',
  orgB1: 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1',
  userA: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
  userA2: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a02',
  userB: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
  wsA: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1',
  wsB: 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2',
  website: 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0',
  page: 'e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0',
  page2: 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1',
  revision: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0',
  revision2: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1',
};

export const ISSUER = 'https://issuer.test.invalid';
export const AUDIENCE = 'preview-api-test';

export interface SignOptions {
  claims?: Record<string, unknown>;
  omit?: string[];
  iss?: string;
  aud?: string;
  exp?: number;
  nbf?: number;
  key?: CryptoKey;
  alg?: string;
  kid?: string;
}

const now = () => Math.floor(Date.now() / 1000);

export async function generateKeys(alg = 'RS256') {
  return generateKeyPair(alg, { extractable: true });
}

export function defaultClaims(): Record<string, unknown> {
  return {
    sub: ID.userA,
    tenant_id: ID.tenantA,
    organization_id: ID.orgA1,
    roles: ['editor'],
  };
}

/** Fully manual payload so tests can omit/alter any claim. */
export async function signJwt(key: CryptoKey, opts: SignOptions = {}): Promise<string> {
  const payload: Record<string, unknown> = {
    ...defaultClaims(),
    iss: opts.iss ?? ISSUER,
    aud: opts.aud ?? AUDIENCE,
    iat: now(),
    exp: opts.exp ?? now() + 600,
    ...opts.claims,
  };
  if (opts.nbf !== undefined) payload.nbf = opts.nbf;
  for (const k of opts.omit ?? []) delete payload[k];
  return new SignJWT(payload as never)
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', ...(opts.kid ? { kid: opts.kid } : {}) })
    .sign(opts.key ?? key);
}

export function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** In-memory authority: only registered (tenant, org, page, revision) tuples are accessible. */
export class FakePageRevisions implements PageRevisionClient {
  private readonly allowed = new Map<string, string>();
  calls = 0;
  key(t: string, o: string, p: string, r: string) {
    return `${t}|${o}|${p}|${r}`;
  }
  allow(t: string, o: string, p: string, r: string, websiteId = ID.website) {
    this.allowed.set(this.key(t, o, p, r), websiteId);
  }
  async resolve(i: { ctx: { tenantId: string; organizationId: string }; pageId: string; revisionId: string }) {
    this.calls++;
    const websiteId = this.allowed.get(this.key(i.ctx.tenantId, i.ctx.organizationId, i.pageId, i.revisionId));
    return websiteId ? { websiteId } : null;
  }
}

export function envFor(publicKeyPem: string, overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_NAME: process.env.DB_NAME,
    JWT_ISSUER: ISSUER,
    JWT_AUDIENCE: AUDIENCE,
    JWT_ALGORITHMS: 'RS256',
    JWT_PUBLIC_KEY: publicKeyPem,
    PREVIEW_ORIGIN: 'https://preview.test.invalid',
    PAGE_REVISION_MODE: 'stub',
    RATE_LIMIT_WRITE_MAX: '10000',
    RATE_LIMIT_RESOLVE_MAX: '10000',
    ...overrides,
  };
}

export interface Harness {
  app: Express;
  pool: pg.Pool;
  fake: FakePageRevisions;
  keys: Awaited<ReturnType<typeof generateKeys>>;
  logLines: () => string;
  sign: (opts?: SignOptions) => Promise<string>;
  bearer: (opts?: SignOptions) => Promise<string>;
  close: () => Promise<void>;
}

export async function createHarness(envOverrides: Record<string, string> = {}): Promise<Harness> {
  const keys = await generateKeys();
  const config = loadConfig(envFor(await exportSPKI(keys.publicKey), envOverrides));
  const pool = new pg.Pool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    max: 10,
  });

  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const fake = new FakePageRevisions();
  fake.allow(ID.tenantA, ID.orgA1, ID.page, ID.revision);
  fake.allow(ID.tenantA, ID.orgA1, ID.page, ID.revision2);
  fake.allow(ID.tenantB, ID.orgB1, ID.page2, ID.revision2);

  const app = createApp({ config, pool, pageRevisions: fake, logger: createLogger('info', sink) });
  const sign = (opts?: SignOptions) => signJwt(keys.privateKey, opts);
  return {
    app,
    pool,
    fake,
    keys,
    logLines: () => chunks.join(''),
    sign,
    bearer: async (opts) => `Bearer ${await sign(opts)}`,
    close: () => pool.end(),
  };
}

export async function truncate(pool: pg.Pool) {
  await pool.query('TRUNCATE preview_sessions');
}
