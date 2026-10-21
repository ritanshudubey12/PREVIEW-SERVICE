/**
 * `npm run test:postman [success|negative]`
 * Starts a mock Page/Revision service and the Preview API (HTTP mode, port 3001), generates the
 * collections + environment, runs them through Newman, then checks the API's logs for leaked
 * JWTs / preview tokens. Exits non-zero on any failure.
 *   success  - only the happy-path collection; additionally verifies EVERY response was 2xx
 *   negative - only the security/error collection (4xx/410/429 are the expected results)
 *   (none)   - both, success first
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startMockPageRevision } from './mockPageRevision.js';
import { COLLECTION_NEGATIVE_FILE, COLLECTION_SUCCESS_FILE, writeCollections } from './buildPostmanCollection.js';
import { ENV_FILE, writeEnvironment } from './postmanEnv.js';

const API_PORT = 3001;
const MOCK_PORT = 4100;
const SERVICE_TOKEN = 'postman-mock-service-token';
const base = `http://localhost:${API_PORT}`;
const which = process.argv[2] ?? 'all';
if (!['all', 'success', 'negative'].includes(which)) throw new Error('Usage: test:postman [success|negative]');

async function waitReady(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${base}/health/ready`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('API did not become ready');
}

interface Execution { item: { name: string }; response?: { code: number; status: string }; assertions?: Array<{ error?: unknown }> }

function runNewman(collection: string, tmp: string, label: string): Promise<{ code: number; env: string; report: string }> {
  const env = path.join(tmp, `${label}-env.json`);
  const report = path.join(tmp, `${label}-report.json`);
  const child = spawn(
    process.execPath,
    ['node_modules/newman/bin/newman.js', 'run', collection, '-e', ENV_FILE, '--export-environment', env,
      '--reporters', 'cli,json', '--reporter-json-export', report, '--color', 'off'],
    { stdio: 'inherit' },
  );
  return new Promise((resolve) => child.on('close', (c) => resolve({ code: c ?? 1, env, report })));
}

const mock = await startMockPageRevision(MOCK_PORT, SERVICE_TOKEN);
const tmp = mkdtempSync(path.join(tmpdir(), 'preview-postman-'));
let api: ChildProcess | undefined;
let logs = '';
let exitCode = 1;
try {
  const n = writeCollections();
  console.log(`Collections: success=${n.success} requests (all 2xx), negative=${n.negative} requests`);
  api = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env,
      PORT: String(API_PORT),
      PAGE_REVISION_MODE: 'http',
      PAGE_REVISION_SERVICE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      PAGE_REVISION_SERVICE_TOKEN: SERVICE_TOKEN,
      RATE_LIMIT_WRITE_MAX: '100',
      RATE_LIMIT_RESOLVE_MAX: '1000',
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout!.on('data', (d) => (logs += d));
  api.stderr!.on('data', (d) => (logs += d));
  await waitReady();
  await writeEnvironment(base);

  exitCode = 0;
  const secrets: string[] = [];
  const runs: Array<[string, string]> = [];
  if (which !== 'negative') runs.push(['success', COLLECTION_SUCCESS_FILE]);
  if (which !== 'success') runs.push(['negative', COLLECTION_NEGATIVE_FILE]);

  for (const [label, file] of runs) {
    console.log(`\n================ ${label.toUpperCase()} COLLECTION ================`);
    const r = await runNewman(file, tmp, label);
    if (r.code !== 0) exitCode = 1;
    const values = JSON.parse(readFileSync(r.env, 'utf8')).values as Array<{ key: string; value: string }>;
    secrets.push(...values.filter((v) => /^(jwt_|tok_)/.test(v.key) && v.value).map((v) => v.value));

    if (label === 'success') {
      // Independent of the in-collection assertions: every response actually received must be 2xx.
      const execs = (JSON.parse(readFileSync(r.report, 'utf8')).run.executions as Execution[]);
      const non2xx = execs.filter((e) => !e.response || e.response.code < 200 || e.response.code >= 300);
      const tally = new Map<number, number>();
      for (const e of execs) tally.set(e.response!.code, (tally.get(e.response!.code) ?? 0) + 1);
      console.log(`\nSuccess collection response codes: ${[...tally].map(([c, k]) => `${c} x${k}`).join(', ')}`);
      console.log(`  ${non2xx.length === 0 ? 'PASS' : 'FAIL'}  every response is 2xx${non2xx.length ? ` (offenders: ${non2xx.map((e) => `${e.item.name} -> ${e.response?.code}`).join('; ')})` : ''}`);
      if (non2xx.length) exitCode = 1;
    }
  }

  // Post-run: nothing sensitive may have reached the logs.
  const leaked = secrets.filter((s) => logs.includes(s));
  const checks: Array<[string, boolean]> = [
    ['no JWT / preview token appears in API logs', leaked.length === 0],
    ['no "Bearer" header value in API logs', !/Bearer\s+\S/.test(logs)],
    ['audit events present (created/revoked)', ['preview.created', 'preview.revoked'].every((e) => logs.includes(e))],
    ['mock Page/Revision service credentials not logged', !logs.includes(SERVICE_TOKEN)],
    ['no unhandled errors in API logs', !logs.includes('"event":"internal_error"')],
  ];
  console.log('\nLog hygiene checks:');
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) exitCode = 1;
  }
  console.log(`  (${secrets.length} secrets checked against ${logs.split('\n').length} log lines)`);
} finally {
  api?.kill();
  mock.close();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);
