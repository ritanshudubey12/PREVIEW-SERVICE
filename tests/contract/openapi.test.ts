import { readFileSync } from 'node:fs';
import request from 'supertest';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, ID, truncate, type Harness } from '../helpers/harness.js';

const spec = parse(readFileSync('openapi/openapi.yaml', 'utf8'));
let h: Harness;
beforeAll(async () => { h = await createHarness(); await truncate(h.pool); });
afterAll(async () => { await truncate(h.pool); await h.close(); });

const documented = (path: string, method: string): string[] => Object.keys(spec.paths[path][method].responses);

describe('OpenAPI contract', () => {
  it('is OpenAPI 3.1 and documents exactly the canonical routes', () => {
    expect(spec.openapi).toMatch(/^3\.1/);
    const ops = Object.entries<Record<string, unknown>>(spec.paths).flatMap(([p, o]) =>
      Object.keys(o).map((m) => `${m.toUpperCase()} ${p}`));
    expect(ops.sort()).toEqual([
      'DELETE /api/v1/previews/{token}',
      'GET /api/v1/previews/{token}',
      'GET /health/live',
      'GET /health/ready',
      'POST /api/v1/pages/{pageId}/previews',
    ]);
  });

  it('declares Bearer JWT auth globally and no auth on the token-credential resolve route', () => {
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.paths['/api/v1/previews/{token}'].get.security).toEqual([]);
  });

  it('every status the live service returns for the main flow is documented', async () => {
    const auth = await h.bearer();
    const created = await request(h.app).post(`/api/v1/pages/${ID.page}/previews`).set('Authorization', auth).send({ revisionId: ID.revision });
    const token = created.body.data.previewUrl.split('/p/')[1];
    const seen: Array<[string, string, request.Response]> = [
      ['/api/v1/pages/{pageId}/previews', 'post', created],
      ['/api/v1/pages/{pageId}/previews', 'post', await request(h.app).post(`/api/v1/pages/${ID.page}/previews`).send({})],
      ['/api/v1/pages/{pageId}/previews', 'post', await request(h.app).post(`/api/v1/pages/${ID.page}/previews`).set('Authorization', auth).send({})],
      ['/api/v1/pages/{pageId}/previews', 'post', await request(h.app).post(`/api/v1/pages/${ID.page2}/previews`).set('Authorization', auth).send({ revisionId: ID.revision2 })],
      ['/api/v1/previews/{token}', 'get', await request(h.app).get(`/api/v1/previews/${token}`)],
      ['/api/v1/previews/{token}', 'delete', await request(h.app).delete(`/api/v1/previews/${token}`).set('Authorization', auth)],
      ['/api/v1/previews/{token}', 'get', await request(h.app).get(`/api/v1/previews/${token}`)],
    ];
    for (const [path, method, res] of seen) {
      expect(documented(path, method), `${method} ${path} -> ${res.status}`).toContain(String(res.status));
    }
  });

  it('response bodies match the documented shapes', async () => {
    const auth = await h.bearer();
    const created = await request(h.app).post(`/api/v1/pages/${ID.page}/previews`).set('Authorization', auth).send({ revisionId: ID.revision });
    const token = created.body.data.previewUrl.split('/p/')[1];
    const resolved = await request(h.app).get(`/api/v1/previews/${token}`);
    const err = await request(h.app).get(`/api/v1/previews/${'A'.repeat(43)}`);

    const required = (name: string) => spec.components.schemas[name].required as string[];
    expect(Object.keys(created.body)).toEqual(expect.arrayContaining(required('CreatePreviewResponse')));
    expect(Object.keys(created.body.data).sort()).toEqual([...spec.components.schemas.CreatePreviewResponse.properties.data.required].sort());
    expect(Object.keys(resolved.body.data).sort()).toEqual([...spec.components.schemas.ResolvePreviewResponse.properties.data.required].sort());
    expect(Object.keys(err.body).sort()).toEqual([...required('ErrorEnvelope')].sort());
    expect(spec.components.schemas.ErrorEnvelope.properties.error.properties.code.enum).toContain(err.body.error.code);
  });
});
