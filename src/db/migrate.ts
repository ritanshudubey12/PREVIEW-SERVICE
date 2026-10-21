import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type pg from 'pg';
import { loadConfig } from '../config/env.js';
import { createLogger } from '../observability/logger.js';
import { createPool } from './pool.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
// Arbitrary constant: serialises concurrent migrators (e.g. two replicas starting together).
const MIGRATION_LOCK_ID = 727_001;

/** Applies pending .sql files in name order, each in its own transaction. Returns applied names. */
export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const pool = createPool(config, logger);
  runMigrations(pool)
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations.');
    })
    .catch((err: Error) => {
      console.error(`Migration failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
