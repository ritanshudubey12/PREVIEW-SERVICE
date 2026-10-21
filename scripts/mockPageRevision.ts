/**
 * TEST-ONLY stand-in for the authoritative Page/Revision service, used by the Postman run so the
 * real HTTP integration (service credentials, scope checks, 404 for foreign resources) is exercised.
 */
import http from 'node:http';

export const FIXTURE = {
  websiteId: 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0',
  tenantA: '11111111-1111-4111-8111-111111111111',
  orgA: '22222222-2222-4222-8222-222222222222',
  pageA: '44444444-4444-4444-8444-444444444444',
  revisionA: '55555555-5555-4555-8555-555555555555',
  revisionA2: '56565656-5656-4656-8656-565656565656',
  pageA2: '45454545-4545-4545-8545-454545454545',
  revisionOfPageA2: '57575757-5757-4757-8757-575757575757',
  tenantB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  orgB: 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1',
  pageB: '66666666-6666-4666-8666-666666666666',
  revisionB: '77777777-7777-4777-8777-777777777777',
};

const known = new Set([
  `${FIXTURE.tenantA}|${FIXTURE.orgA}|${FIXTURE.pageA}|${FIXTURE.revisionA}`,
  `${FIXTURE.tenantA}|${FIXTURE.orgA}|${FIXTURE.pageA}|${FIXTURE.revisionA2}`,
  `${FIXTURE.tenantA}|${FIXTURE.orgA}|${FIXTURE.pageA2}|${FIXTURE.revisionOfPageA2}`,
  `${FIXTURE.tenantB}|${FIXTURE.orgB}|${FIXTURE.pageB}|${FIXTURE.revisionB}`,
]);

export function startMockPageRevision(port: number, serviceToken?: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (serviceToken && req.headers.authorization !== `Bearer ${serviceToken}`) return send(401, { error: 'bad service credentials' });
    const m = /^\/internal\/v1\/pages\/([^/]+)\/revisions\/([^/]+)$/.exec(req.url ?? '');
    if (!m) return send(404, {});
    const [, pageId, revisionId] = m;
    const tenantId = String(req.headers['x-tenant-id'] ?? '');
    const organizationId = String(req.headers['x-organization-id'] ?? '');
    if (!known.has(`${tenantId}|${organizationId}|${pageId}|${revisionId}`)) return send(404, {});
    send(200, { data: { websiteId: FIXTURE.websiteId, pageId, revisionId, tenantId, organizationId } });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
