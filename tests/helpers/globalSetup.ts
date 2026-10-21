import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

/** Creates the "<name>_test" database if needed and applies migrations once per test run. */
export default async function setup() {
  const base = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  };
  const dbName = process.env.DB_NAME;
  if (!base.host || !base.user || !base.password || !dbName) {
    throw new Error('DB_HOST / DB_USER / DB_PASSWORD / DB_NAME must be set in .env to run the tests');
  }
  if (!/^[a-z0-9_]+_test$/i.test(dbName)) throw new Error('Refusing to run tests against a non-"_test" database');

  const admin = new pg.Pool({ ...base, database: 'postgres', max: 1 });
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({ ...base, database: dbName, max: 1 });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
