/** End-to-end check against a RUNNING service: create -> resolve -> revoke -> resolve (expect 410). */
import { PreviewApiClient, PreviewApiError } from '../src/client/previewClient.js';
import { DEV_IDS, devTokenProvider } from './devToken.js';

const baseUrl = process.env.SMOKE_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
// The Authorization: Bearer header is attached automatically by the client on every protected call.
const client = new PreviewApiClient({ baseUrl, getToken: devTokenProvider({ roles: ['editor'] }) });

const created = await client.createPreview(DEV_IDS.pageId, { revisionId: DEV_IDS.revisionId, expiresInSeconds: 300 });
console.log('created  ->', { expiresAt: created.expiresAt, previewUrl: created.previewUrl.replace(/\/p\/.+$/, '/p/<redacted>') });

const token = created.previewUrl.split('/p/')[1]!;
console.log('resolved ->', await client.resolvePreview(token));

await client.revokePreview(token);
console.log('revoked');

try {
  await client.resolvePreview(token);
  throw new Error('Revoked preview still resolves!');
} catch (e) {
  if (e instanceof PreviewApiError && e.status === 410) console.log('after revoke ->', e.status, e.code);
  else throw e;
}
console.log('SMOKE OK');
