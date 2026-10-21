import express, { type Express } from 'express';
import type pg from 'pg';
import type { Config } from './config/env.js';
import type { PageRevisionClient } from './integrations/pageRevisionClient.js';
import { createJwtVerifier, type JwtVerifier } from './middleware/authenticate.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestId.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { createPreviewRouter } from './modules/preview/preview.routes.js';
import { PreviewRepository } from './modules/preview/preview.repository.js';
import { PreviewService } from './modules/preview/preview.service.js';
import type { Logger } from './observability/logger.js';
import './types.js';

export interface AppDeps {
  config: Config;
  pool: pg.Pool;
  pageRevisions: PageRevisionClient;
  logger: Logger;
  verifyJwt?: JwtVerifier;
}

export function createApp(deps: AppDeps): Express {
  const { config, pool, pageRevisions, logger } = deps;
  const verifyJwt = deps.verifyJwt ?? createJwtVerifier(config.jwt);

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(requestId);
  app.use(securityHeaders);
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info({
        event: 'http.request',
        requestId: req.requestId,
        method: req.method,
        route: req.route?.path ?? 'unmatched', // template only: the raw URL contains the preview token
        status: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - start) / 1e6,
      });
    });
    next();
  });

  // Liveness: process is up. Readiness: required dependencies reachable. Neither leaks detail.
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', async (_req, res) => {
    try {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000).unref()),
      ]);
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not_ready' });
    }
  });

  app.use(express.json({ limit: '16kb' }));
  const service = new PreviewService(config, new PreviewRepository(pool), pageRevisions, logger);
  app.use('/api/v1', createPreviewRouter(config, service, verifyJwt));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
