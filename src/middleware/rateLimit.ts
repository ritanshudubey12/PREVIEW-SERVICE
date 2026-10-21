import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Config } from '../config/env.js';

function limiter(config: Config, limit: number, keyGenerator?: (req: Parameters<RequestHandler>[0]) => string) {
  return rateLimit({
    windowMs: config.rateLimit.windowSeconds * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (req, res) => {
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please retry later.' },
        meta: { requestId: req.requestId },
      });
    },
  });
}

/** Create/revoke: keyed per authenticated actor (runs after `authenticate`). */
export const writeRateLimit = (config: Config): RequestHandler =>
  limiter(config, config.rateLimit.writeMax, (req) => `${req.auth!.tenantId}:${req.auth!.userId}`);

/** Resolve is unauthenticated (token is the credential): keyed per client IP. */
export const resolveRateLimit = (config: Config): RequestHandler => limiter(config, config.rateLimit.resolveMax);
