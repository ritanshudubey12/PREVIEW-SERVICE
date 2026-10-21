import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createPool } from './db/pool.js';
import { createPageRevisionClient } from './integrations/pageRevisionClient.js';
import { createLogger } from './observability/logger.js';

const config = loadConfig(); // fails fast with a readable list of missing/invalid settings
const logger = createLogger(config.logLevel);
const pool = createPool(config, logger);
const app = createApp({ config, pool, logger, pageRevisions: createPageRevisionClient(config) });

if (config.pageRevision.mode === 'stub') {
  logger.warn({ event: 'config.stub_page_revision', message: 'Page/Revision stub is active: development only.' });
}

const server = app.listen(config.port, () => {
  logger.info({ event: 'server.started', port: config.port, env: config.nodeEnv });
});

function shutdown(signal: string) {
  logger.info({ event: 'server.stopping', signal });
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
