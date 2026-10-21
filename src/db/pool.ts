import pg from 'pg';
import type { Config } from '../config/env.js';
import type { Logger } from '../observability/logger.js';

export function createPool(config: Config, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    max: config.db.poolMax,
    ssl: config.db.ssl ? { rejectUnauthorized: true } : undefined,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  // An idle client erroring must not crash the process.
  pool.on('error', (err) => logger.error({ event: 'db.pool_error', message: err.message }));
  return pool;
}
