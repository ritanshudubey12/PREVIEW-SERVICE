/** Generates postman/preview-api.postman_collection.json (no secrets inside; tokens come from the environment file). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const COLLECTION_SUCCESS_FILE = 'postman/preview-api.success.postman_collection.json';
export const COLLECTION_NEGATIVE_FILE = 'postman/preview-api.negative.postman_collection.json';

interface Spec {
  name: string;
  method?: string;
  path: string;
  /** undefined = inherit collection Bearer {{jwt_editor}}; null = no auth; string = env var holding the JWT */
  auth?: string | null;
  headers?: Record<string, string>;
  body?: string;
  pre?: string[];
  test: string[];
}

// ---- reusable assertions (plain JS that runs inside Postman's sandbox) -------------------------
const status = (n: number) => `pm.test('status is ${n}', function () { pm.response.to.have.status(${n}); });`;
const err = (code: string, message?: string) => `
pm.test('error envelope is ${code}', function () {
  const b = pm.response.json();
  pm.expect(b.success).to.eql(false);
  pm.expect(b.error.code).to.eql('${code}');
  ${message ? `pm.expect(b.error.message).to.eql(${JSON.stringify(message)});` : `pm.expect(b.error.message).to.be.a('string').and.not.empty;`}
  pm.expect(b.meta.requestId).to.eql(pm.response.headers.get('X-Request-Id'));
});`;
const validation = () => [status(400), err('VALIDATION_ERROR')].join('\n');
const unauth = () => [status(401), err('UNAUTHENTICATED', 'Authentication is required.')].join('\n');
const forbidden = () => [status(403), err('FORBIDDEN')].join('\n');
const notFound = () => [status(404), err('NOT_FOUND')].join('\n');
const gone = () => `
${status(410)}
pm.test('uniform PREVIEW_UNAVAILABLE body (no token enumeration)', function () {
  const e = pm.response.json().error;
  pm.expect(e).to.eql({ code: 'PREVIEW_UNAVAILABLE', message: 'This preview is no longer available.' });
});`;
const saveToken = (v: string) => `
pm.test('returns opaque preview URL; token saved as ${v}', function () {
  const url = pm.response.json().data.previewUrl;
  pm.expect(url).to.match(/\\/p\\/[A-Za-z0-9_-]{43}$/);
  pm.environment.set('${v}', url.split('/p/')[1]);
});`;
const resolveIs = (page: string, rev: string) => `
pm.test('resolve returns exact page/revision, read-only', function () {
  const d = pm.response.json().data;
  pm.expect(d.pageId).to.eql(pm.environment.get('${page}'));
  pm.expect(d.revisionId).to.eql(pm.environment.get('${rev}'));
  pm.expect(d.readOnly).to.eql(true);
});`;
const stillResolves = (tokVar: string, name: string): Spec => ({
  name, path: `/api/v1/previews/{{${tokVar}}}`, auth: null,
  test: [status(200), `pm.test('preview is still live', function(){ pm.expect(pm.response.json().data.readOnly).to.eql(true); });`],
});
const resolveGone = (tokVar: string, name: string): Spec => ({
  name, path: `/api/v1/previews/{{${tokVar}}}`, auth: null, test: [gone()],
});

const J = (o: string) => o; // readability marker for raw JSON bodies
const body = (extra = '') => J(`{"revisionId":"{{revisionA}}"${extra}}`);
const CREATE = '/api/v1/pages/{{pageA}}/previews';
const create = (name: string, test: string[], o: Partial<Spec> = {}): Spec => ({ name, method: 'POST', path: CREATE, body: body(), test, ...o });
const del = (name: string, tokVar: string, auth: string | null | undefined, test: string[], o: Partial<Spec> = {}): Spec => ({
  name, method: 'DELETE', path: `/api/v1/previews/{{${tokVar}}}`, auth, test, ...o,
});
const rawAuth = (value: string) => ({ auth: null as null, headers: { Authorization: value } });

// ---- the test suite ----------------------------------------------------------------------------
const folders: Array<{ name: string; items: Spec[] }> = [
  {
    name: '0. Health & routing',
    items: [
      { name: 'GET /health/live', path: '/health/live', auth: null, test: [status(200), `pm.test('liveness body', function(){ pm.expect(pm.response.json()).to.eql({ status: 'ok' }); });`] },
      { name: 'GET /health/ready (DB reachable)', path: '/health/ready', auth: null, test: [status(200), `pm.test('readiness body has no internals', function(){ pm.expect(pm.response.json()).to.eql({ status: 'ready' }); });`] },
      { name: 'Unknown route -> 404 envelope', path: '/api/v1/does-not-exist', auth: null, test: [notFound()] },
      { name: 'No singular create alias: POST /api/v1/pages/:id/preview', method: 'POST', path: '/api/v1/pages/{{pageA}}/preview', body: body(), test: [notFound()] },
      { name: 'No collection-level create: POST /api/v1/previews', method: 'POST', path: '/api/v1/previews', body: body(), test: [notFound()] },
    ],
  },
  {
    name: '1. Create preview - success',
    items: [
      create('Create (editor, default TTL)', [status(201), saveToken('tok_main'), `
pm.test('envelope + only previewUrl/expiresAt returned', function () {
  const b = pm.response.json();
  pm.expect(b.success).to.eql(true);
  pm.expect(Object.keys(b.data).sort()).to.eql(['expiresAt', 'previewUrl']);
  pm.expect(b.meta.requestId).to.eql(pm.response.headers.get('X-Request-Id'));
});
pm.test('default TTL is ~1800s', function () {
  const secs = (Date.parse(pm.response.json().data.expiresAt) - Date.now()) / 1000;
  pm.expect(secs).to.be.within(1700, 1801);
});`]),
      create('Create with custom TTL 120s', [status(201), saveToken('tok_short'), `
pm.test('TTL honoured (<=120s)', function () {
  const secs = (Date.parse(pm.response.json().data.expiresAt) - Date.now()) / 1000;
  pm.expect(secs).to.be.within(90, 121);
});`], { body: body(',"expiresInSeconds":120') }),
      create('Create as owner', [status(201), saveToken('tok_owner')], { auth: 'jwt_owner' }),
      create('Create for a second revision of the same page', [status(201), saveToken('tok_a2')], { body: `{"revisionId":"{{revisionA2}}"}` }),
      create('TTL lower bound (60s) accepted', [status(201)], { body: body(',"expiresInSeconds":60') }),
      create('TTL upper bound (86400s) accepted', [status(201)], { body: body(',"expiresInSeconds":86400') }),
      create('Caller X-Request-Id is echoed', [status(201), `pm.test('request id echoed', function(){ pm.expect(pm.response.headers.get('X-Request-Id')).to.eql('postman-trace-0001'); pm.expect(pm.response.json().meta.requestId).to.eql('postman-trace-0001'); });`], { headers: { 'X-Request-Id': 'postman-trace-0001' } }),
      create('Invalid X-Request-Id is replaced', [status(201), `pm.test('generated req_<uuid>', function(){ pm.expect(pm.response.headers.get('X-Request-Id')).to.match(/^req_[0-9a-f-]{36}$/); });`], { headers: { 'X-Request-Id': 'bad id!!' } }),
      create('Two creates yield different tokens', [status(201), `
pm.test('token differs from tok_main', function () {
  pm.expect(pm.response.json().data.previewUrl.split('/p/')[1]).to.not.eql(pm.environment.get('tok_main'));
});`]),
    ],
  },
  {
    name: '2. Create preview - validation (400)',
    items: [
      create('Non-UUID pageId', [validation()], { path: '/api/v1/pages/not-a-uuid/previews' }),
      create('Missing revisionId', [validation()], { body: '{}' }),
      create('Empty body', [validation()], { body: '' }),
      create('Array body', [validation()], { body: '[]' }),
      create('Non-UUID revisionId', [validation()], { body: '{"revisionId":"abc"}' }),
      create('revisionId is a number', [validation()], { body: '{"revisionId":123}' }),
      create('TTL below minimum (59)', [validation()], { body: body(',"expiresInSeconds":59') }),
      create('TTL zero', [validation()], { body: body(',"expiresInSeconds":0') }),
      create('TTL negative', [validation()], { body: body(',"expiresInSeconds":-100') }),
      create('TTL above maximum (86401)', [validation()], { body: body(',"expiresInSeconds":86401') }),
      create('TTL fractional', [validation()], { body: body(',"expiresInSeconds":90.5') }),
      create('TTL as string', [validation()], { body: body(',"expiresInSeconds":"600"') }),
      create('TTL null', [validation()], { body: body(',"expiresInSeconds":null') }),
      create('Body tries to set tenantId', [validation()], { body: body(`,"tenantId":"{{tenantB}}"`) }),
      create('Body tries to set userId / role', [validation()], { body: body(',"userId":"x","role":"owner"') }),
      create('Malformed JSON', [validation()], { body: '{"revisionId": ', headers: { 'Content-Type': 'application/json' } }),
      create('Wrong content type (text/plain)', [validation()], { body: 'hello', headers: { 'Content-Type': 'text/plain' } }),
      create('Oversized body -> 413', [status(413), err('VALIDATION_ERROR')], {
        pre: [`pm.variables.set('big', 'x'.repeat(20000));`], body: body(',"pad":"{{big}}"'),
      }),
    ],
  },
  {
    name: '3. Create preview - resource ownership & roles',
    items: [
      create('Revision does not belong to the page -> 404', [notFound()], { body: `{"revisionId":"{{revisionOfPageA2}}"}` }),
      create('Unknown page -> 404', [notFound()], { path: '/api/v1/pages/{{unknownPage}}/previews' }),
      create("Tenant A editor cannot preview tenant B's page -> 404", [notFound()], { path: '/api/v1/pages/{{pageB}}/previews', body: '{"revisionId":"{{revisionB}}"}' }),
      create("Tenant B owner cannot preview tenant A's page -> 404", [notFound()], { auth: 'jwt_tenantB_owner' }),
      create('Viewer role cannot create -> 403', [forbidden()], { auth: 'jwt_viewer_other' }),
      create('Empty roles cannot create -> 403', [forbidden()], { auth: 'jwt_no_roles' }),
    ],
  },
  {
    name: '4. Authentication (JWT / Bearer)',
    items: [
      create('No Authorization header', [unauth()], { auth: null }),
      create('Basic scheme', [unauth()], rawAuth('Basic dXNlcjpwYXNz')),
      create('"Bearer" with empty token', [unauth()], rawAuth('Bearer ')),
      create('Garbage token', [unauth()], rawAuth('Bearer not-a-jwt')),
      create('Three dots garbage (a.b.c)', [unauth()], rawAuth('Bearer a.b.c')),
      create('Expired token', [unauth()], { auth: 'jwt_expired' }),
      create('Not-yet-valid token (nbf)', [unauth()], { auth: 'jwt_nbf_future' }),
      create('Wrong issuer', [unauth()], { auth: 'jwt_wrong_issuer' }),
      create('Wrong audience', [unauth()], { auth: 'jwt_wrong_audience' }),
      create('Invalid signature (other key)', [unauth()], { auth: 'jwt_bad_signature' }),
      create('Unsigned token (alg=none)', [unauth()], { auth: 'jwt_alg_none' }),
      create('Tampered payload (tenant swapped)', [unauth()], { auth: 'jwt_tampered_payload' }),
      create('Missing tenant_id claim', [unauth()], { auth: 'jwt_missing_tenant' }),
      create('Missing organization_id claim', [unauth()], { auth: 'jwt_missing_org' }),
      create('Missing sub claim', [unauth()], { auth: 'jwt_missing_sub' }),
      create('Missing exp claim', [unauth()], { auth: 'jwt_missing_exp' }),
      create('Non-UUID tenant_id claim', [unauth()], { auth: 'jwt_non_uuid_tenant' }),
      create('Opaque preview token used as Bearer', [unauth()], rawAuth('Bearer {{tok_main}}')),
      del('DELETE without Authorization', 'tok_main', null, [unauth()]),
      del('DELETE with expired token', 'tok_main', 'jwt_expired', [unauth()]),
      del('DELETE with token signed by another key', 'tok_main', 'jwt_bad_signature', [unauth()]),
      { name: 'Preview token alone is still live after all rejected attempts', path: '/api/v1/previews/{{tok_main}}', auth: null, test: [status(200)] },
    ],
  },
  {
    name: '5. Trusted context (spoofed X-* headers)',
    items: [
      create('X-Tenant-Id of another tenant -> 403', [forbidden()], { headers: { 'X-Tenant-Id': '{{tenantB}}' } }),
      create('X-Organization-Id of another org -> 403', [forbidden()], { headers: { 'X-Organization-Id': '{{orgA2}}' } }),
      create('X-User-Id of another user -> 403', [forbidden()], { headers: { 'X-User-Id': '99999999-9999-4999-8999-999999999999' } }),
      create('X-Workspace-Id when token has none -> 403', [forbidden()], { headers: { 'X-Workspace-Id': '{{ws1}}' } }),
      create('X-Software-Id when token has none -> 403', [forbidden()], { headers: { 'X-Software-Id': '{{ws1}}' } }),
      create('Spoofed header on DELETE -> 403', [forbidden()], { method: 'DELETE', path: '/api/v1/previews/{{tok_main}}', body: undefined, headers: { 'X-Tenant-Id': '{{tenantB}}' } }),
      create('Headers that agree with the JWT are accepted', [status(201)], { headers: { 'X-Tenant-Id': '{{tenantA}}', 'X-Organization-Id': '{{orgA}}', 'X-User-Id': '{{userA}}' } }),
      create('?tenantId= in query is ignored (scope comes from JWT)', [status(201)], { path: `${CREATE}?tenantId={{tenantB}}&organizationId={{orgA2}}` }),
      stillResolves('tok_main', 'tok_main still live (no spoof side effects)'),
    ],
  },
  {
    name: '6. Resolve preview token',
    items: [
      { name: 'Resolve (no JWT needed)', path: '/api/v1/previews/{{tok_main}}', auth: null, test: [status(200), resolveIs('pageA', 'revisionA'), `
pm.test('only renderer-safe fields', function () {
  const b = pm.response.json();
  pm.expect(b.success).to.eql(true);
  pm.expect(Object.keys(b.data).sort()).to.eql(['expiresAt', 'pageId', 'readOnly', 'revisionId', 'websiteId']);
  pm.expect(b.data.websiteId).to.eql(pm.environment.get('websiteId'));
});
pm.test('no tenant / org / user identifiers leaked', function () {
  const t = pm.response.text();
  ['tenantA', 'orgA', 'userA'].forEach(function (k) { pm.expect(t).to.not.include(pm.environment.get(k)); });
});
pm.test('no-store, noindex, no-referrer headers', function () {
  pm.expect(pm.response.headers.get('Cache-Control')).to.eql('private, no-store');
  pm.expect(pm.response.headers.get('X-Robots-Tag')).to.include('noindex');
  pm.expect(pm.response.headers.get('Referrer-Policy')).to.eql('no-referrer');
});`] },
      { name: 'Resolve ignores a garbage Authorization header', path: '/api/v1/previews/{{tok_main}}', auth: null, headers: { Authorization: 'Bearer garbage' }, test: [status(200)] },
      { name: 'Resolve second revision returns that revision', path: '/api/v1/previews/{{tok_a2}}', auth: null, test: [status(200), resolveIs('pageA', 'revisionA2')] },
      { name: 'Unknown (well-formed) token -> 410', path: '/api/v1/previews/{{unknownToken}}', auth: null, test: [gone()] },
      { name: 'Too-short token -> 410', path: '/api/v1/previews/short', auth: null, test: [gone()] },
      { name: 'Over-long token -> 410', path: `/api/v1/previews/${'x'.repeat(200)}`, auth: null, test: [gone()] },
      { name: 'SQL-injection style token -> 410', path: "/api/v1/previews/%27%20OR%201%3D1--", auth: null, test: [gone()] },
      { name: 'Path-traversal style token -> 410', path: '/api/v1/previews/..%2F..%2Fetc%2Fpasswd', auth: null, test: [gone()] },
      ...['POST', 'PUT', 'PATCH'].map((m): Spec => ({ name: `Preview token is read-only: ${m} -> 404`, method: m, path: '/api/v1/previews/{{tok_main}}', auth: null, body: '{}', test: [notFound()] })),
      { name: 'Preview token cannot hit builder routes (no publish/edit surface)', method: 'POST', path: '/api/v1/pages/{{pageA}}/publish', auth: null, body: '{}', test: [notFound()] },
    ],
  },
  {
    name: '7. Revoke - authorization & isolation',
    items: [
      del('Non-creator viewer in same org -> 403', 'tok_main', 'jwt_viewer_other', [forbidden()]),
      del('Tenant B owner -> 404 (existence hidden)', 'tok_main', 'jwt_tenantB_owner', [notFound()]),
      del('Same org id but different tenant -> 404', 'tok_main', 'jwt_crosstenant_sameorg', [notFound()]),
      del('Different org in same tenant (owner) -> 404', 'tok_main', 'jwt_orgA2_owner', [notFound()]),
      del('Unknown well-formed token -> 404', 'unknownToken', undefined, [notFound()]),
      { name: 'Malformed token -> 404', method: 'DELETE', path: '/api/v1/previews/short', test: [notFound()] },
      stillResolves('tok_main', 'tok_main survived every unauthorised revoke'),
      del('Creator (demoted to viewer) revokes -> 204', 'tok_main', 'jwt_viewer_creator', [status(204), `pm.test('empty body', function(){ pm.expect(pm.response.text()).to.eql(''); });`]),
      resolveGone('tok_main', 'Revoked token -> 410'),
      del('Revoke again is idempotent -> 204', 'tok_main', 'jwt_viewer_creator', [status(204)]),
      del('Other editor in same org revokes tok_short -> 204', 'tok_short', 'jwt_editor_other', [status(204)]),
      resolveGone('tok_short', 'tok_short -> 410'),
      del('Owner revokes tok_owner -> 204', 'tok_owner', 'jwt_owner', [status(204)]),
      resolveGone('tok_owner', 'tok_owner -> 410'),
      del('Editor revokes tok_a2 -> 204', 'tok_a2', undefined, [status(204)]),
      resolveGone('tok_a2', 'tok_a2 -> 410'),
    ],
  },
  {
    name: '8. Workspace & software boundary',
    items: [
      create('Create inside workspace 1 (with software id)', [status(201), saveToken('tok_ws')], { auth: 'jwt_ws1_editor' }),
      create('Create outside any workspace', [status(201), saveToken('tok_nows')]),
      stillResolves('tok_ws', 'Workspace preview resolves'),
      del('Other workspace owner -> 404', 'tok_ws', 'jwt_ws2_owner', [notFound()]),
      del('Same user, no workspace in token -> 404', 'tok_ws', 'jwt_owner', [notFound()]),
      del('Workspace-scoped caller vs non-workspace session -> 404', 'tok_nows', 'jwt_ws1_editor', [notFound()]),
      stillResolves('tok_ws', 'Workspace preview still live'),
      del('Matching workspace revokes -> 204', 'tok_ws', 'jwt_ws1_editor', [status(204)]),
      resolveGone('tok_ws', 'Workspace preview -> 410'),
      del('Cleanup non-workspace preview', 'tok_nows', undefined, [status(204)]),
    ],
  },
  {
    name: '9. Tenant B has an isolated working flow',
    items: [
      create('Tenant B creates for its own page', [status(201), saveToken('tok_b')], { auth: 'jwt_tenantB_owner', path: '/api/v1/pages/{{pageB}}/previews', body: '{"revisionId":"{{revisionB}}"}' }),
      { name: 'Resolve tenant B preview', path: '/api/v1/previews/{{tok_b}}', auth: null, test: [status(200), resolveIs('pageB', 'revisionB')] },
      del('Tenant A owner cannot revoke it -> 404', 'tok_b', 'jwt_owner', [notFound()]),
      stillResolves('tok_b', 'Tenant B preview unaffected'),
      del('Tenant B revokes -> 204', 'tok_b', 'jwt_tenantB_owner', [status(204)]),
      resolveGone('tok_b', 'Tenant B preview -> 410'),
    ],
  },
  {
    name: '10a. Real-time expiry (waits ~62s on the live service clock)',
    items: [
      create('Create with the minimum TTL (60s)', [status(201), saveToken('tok_exp')], { body: body(',"expiresInSeconds":60') }),
      stillResolves('tok_exp', 'Resolves while within its TTL'),
      {
        name: 'After the TTL elapses the same token returns 410',
        path: '/api/v1/previews/{{tok_exp}}',
        auth: null,
        pre: [`
// Hold the request until the 60s TTL has passed (setTimeout keeps the sandbox alive).
setTimeout(function () {}, 62000);`],
        test: [gone()],
      },
      del('Revoking an already-expired preview is idempotent -> 204', 'tok_exp', undefined, [status(204)]),
    ],
  },
  {
    name: '10. Rate limiting (dedicated user, limit 100/min)',
    items: [
      create('Burst of creates: first 100 succeed, the rest are 429', [`
const limit = 100, extra = 5;
const results = [pm.response.code];
function next(i, done) {
  if (i >= limit + extra) { return done(); }
  pm.sendRequest({
    url: pm.environment.get('baseUrl') + '/api/v1/pages/' + pm.environment.get('pageA') + '/previews',
    method: 'POST',
    header: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pm.environment.get('jwt_rate_user') },
    body: { mode: 'raw', raw: JSON.stringify({ revisionId: pm.environment.get('revisionA') }) },
  }, function (e, res) {
    results.push(e ? 'error' : res.code);
    if (!e && res.code === 429 && !pm.environment.get('rl_body')) { pm.environment.set('rl_body', JSON.stringify(res.json())); pm.environment.set('rl_has_header', String(!!(res.headers.get('RateLimit') || res.headers.get('RateLimit-Policy')))); }
    next(i + 1, done);
  });
}
next(1, function () {
  pm.test('first ' + limit + ' requests are 201', function () { pm.expect(results.slice(0, limit).every(function (c) { return c === 201; })).to.eql(true); });
  pm.test('requests beyond the limit are 429', function () { pm.expect(results.slice(limit)).to.eql(new Array(extra).fill(429)); });
  pm.test('429 uses the standard envelope', function () {
    const b = JSON.parse(pm.environment.get('rl_body'));
    pm.expect(b.success).to.eql(false);
    pm.expect(b.error.code).to.eql('RATE_LIMITED');
    pm.expect(b.meta.requestId).to.be.a('string');
  });
  pm.test('standard RateLimit headers are present', function () { pm.expect(pm.environment.get('rl_has_header')).to.eql('true'); });
});`], { auth: 'jwt_rate_user' }),
      create('A different user is not throttled by that user\'s burst', [status(201)], { auth: 'jwt_editor_other' }),
    ],
  },
];

// ---- collection assembly -----------------------------------------------------------------------
const bearer = (v: string) => ({ type: 'bearer', bearer: [{ key: 'token', value: `{{${v}}}`, type: 'string' }] });
const exec = (lines: string[]) => ({ type: 'text/javascript', exec: lines.join('\n').split('\n') });

function toItem(s: Spec) {
  const [rawPath, query] = s.path.split('?');
  const request: Record<string, unknown> = {
    method: s.method ?? 'GET',
    header: Object.entries(s.headers ?? {}).map(([key, value]) => ({ key, value, type: 'text' })),
    url: {
      raw: `{{baseUrl}}${s.path}`,
      host: ['{{baseUrl}}'],
      path: rawPath!.split('/').filter(Boolean),
      ...(query ? { query: query.split('&').map((q) => ({ key: q.split('=')[0], value: q.split('=')[1] })) } : {}),
    },
  };
  if (s.auth === null) request.auth = { type: 'noauth' };
  else if (typeof s.auth === 'string') request.auth = bearer(s.auth);
  if (s.body !== undefined && s.body !== '') {
    request.body = { mode: 'raw', raw: s.body, options: { raw: { language: 'json' } } };
  }
  const event = [
    ...(s.pre ? [{ listen: 'prerequest', script: exec(s.pre) }] : []),
    { listen: 'test', script: exec(s.test) },
  ];
  return { name: s.name, event, request };
}

/** Statuses a spec's own assertions expect, e.g. [201]. Empty when it asserts none (custom scripts). */
const expectedStatuses = (s: Spec) => [...s.test.join('\n').matchAll(/status is (\d{3})/g)].map((m) => Number(m[1]));
const isSuccessCase = (s: Spec) => {
  const codes = expectedStatuses(s);
  return codes.length > 0 && codes.every((c) => c >= 200 && c < 300);
};

function buildCollection(name: string, description: string, folderList: typeof folders) {
  return {
  info: {
    name,
    description,
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  // Every request inherits `Authorization: Bearer {{jwt_editor}}` unless it overrides auth.
  auth: bearer('jwt_editor'),
  event: [
    {
      listen: 'prerequest',
      script: exec([`
const t = pm.environment.get('jwt_editor');
if (!t) { throw new Error('jwt_editor missing: import the environment generated by "npm run postman:env"'); }
const decode = require('atob');
const p = JSON.parse(decode(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
if (p.exp * 1000 < Date.now() + 30000) { throw new Error('JWTs in the environment have expired - run "npm run postman:env" again'); }`]),
    },
    {
      listen: 'test',
      script: exec([`
pm.test('[global] X-Request-Id present', function () { pm.expect(pm.response.headers.get('X-Request-Id')).to.be.a('string').and.not.empty; });
pm.test('[global] responses are private, no-store', function () { pm.expect(pm.response.headers.get('Cache-Control')).to.eql('private, no-store'); });
pm.test('[global] security headers', function () {
  pm.expect(pm.response.headers.get('X-Content-Type-Options')).to.eql('nosniff');
  pm.expect(pm.response.headers.has('X-Powered-By')).to.eql(false);
});
pm.test('[global] no stack traces / SQL / JWTs in body', function () {
  pm.expect(pm.response.text()).to.not.match(/(\\bat\\s.+:\\d+:\\d+|SELECT\\s|INSERT\\s|node_modules|eyJ[A-Za-z0-9_-]{10,}\\.)/);
});
pm.test('[global] responds in < 2s', function () { pm.expect(pm.response.responseTime).to.be.below(2000); });`]),
    },
  ],
  item: folderList.map((f) => ({ name: f.name, item: f.items.map(toItem) })),
  };
}

// Folder titles borrowed from the full suite read oddly with only their 2xx requests left in them.
const SUCCESS_TITLES: Record<string, string> = {
  '0. Health & routing': '0. Health',
  '1. Create preview - success': '1. Create preview (201)',
  '4. Authentication (JWT / Bearer)': '2. Preview token works on its own (200)',
  '5. Trusted context (spoofed X-* headers)': '3. Matching context headers & query are accepted (201)',
  '6. Resolve preview token': '4. Resolve preview (200)',
  '7. Revoke - authorization & isolation': '5. Revoke preview (204)',
  '8. Workspace & software boundary': '6. Workspace-scoped preview (201 / 200 / 204)',
  '9. Tenant B has an isolated working flow': '7. Second tenant flow (201 / 200 / 204)',
  '10a. Real-time expiry (waits ~62s on the live service clock)': '8. Short-lived preview, 60s TTL (201 / 200 / 204)',
  '10. Rate limiting (dedicated user, limit 100/min)': '9. Another user creates normally (201)',
};
const successFolders = folders
  .map((f) => ({ name: SUCCESS_TITLES[f.name] ?? f.name, items: f.items.filter(isSuccessCase) }))
  .filter((f) => f.items.length > 0);

const count = (fl: typeof folders) => fl.reduce((n, f) => n + f.items.length, 0);

export function writeCollections() {
  mkdirSync('postman', { recursive: true });
  const success = buildCollection(
    'Preview API - Success flows (every request returns 2xx)',
    'Happy paths only: health, create (201), resolve (200), revoke (204), workspace and second-tenant flows. Every request is expected to return 200/201/204.',
    successFolders,
  );
  const negative = buildCollection(
    'Preview API - Security & error cases (expects 4xx by design)',
    'Full suite including the setup/success steps it depends on. Rejections (400/401/403/404/410/413/429) are the CORRECT result for these requests; a green test means the API refused correctly.',
    folders,
  );
  writeFileSync(COLLECTION_SUCCESS_FILE, JSON.stringify(success, null, 2));
  writeFileSync(COLLECTION_NEGATIVE_FILE, JSON.stringify(negative, null, 2));
  return { success: count(successFolders), negative: count(folders) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = writeCollections();
  console.log(`Wrote ${COLLECTION_SUCCESS_FILE} (${n.success} requests, all 2xx)`);
  console.log(`Wrote ${COLLECTION_NEGATIVE_FILE} (${n.negative} requests)`);
}
