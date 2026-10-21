import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../errors.js';
import type { Logger } from '../observability/logger.js';

export function sendError(
  res: Parameters<RequestHandler>[1],
  requestId: string,
  status: number,
  code: string,
  message: string,
) {
  res.status(status).json({ success: false, error: { code, message }, meta: { requestId } });
}

export const notFoundHandler: RequestHandler = (req, res) => {
  sendError(res, req.requestId, 404, 'NOT_FOUND', 'The requested resource was not found.');
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const route = req.route?.path ?? 'unmatched'; // route template, never the raw URL (it holds the token)
    const base = { requestId: req.requestId, method: req.method, route };

    if (err instanceof AppError) {
      if (err.status === 401 || err.status === 403) {
        logger.warn({
          ...base,
          event: 'security.denied',
          code: err.code,
          reason: err.reason,
          tenantId: req.auth?.tenantId,
          organizationId: req.auth?.organizationId,
          userId: req.auth?.userId,
        });
      }
      return sendError(res, req.requestId, err.status, err.code, err.message);
    }

    // body-parser errors (malformed JSON, oversized body, wrong charset)
    const parserError = err as { type?: string; status?: number };
    if (parserError.type === 'entity.parse.failed') {
      return sendError(res, req.requestId, 400, 'VALIDATION_ERROR', 'Request body is not valid JSON.');
    }
    if (parserError.type === 'entity.too.large') {
      return sendError(res, req.requestId, 413, 'VALIDATION_ERROR', 'Request body is too large.');
    }

    // Anything else: log detail server-side only, return a generic message.
    logger.error({ ...base, event: 'internal_error', message: (err as Error).message, stack: (err as Error).stack });
    return sendError(res, req.requestId, 500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
  };
}
