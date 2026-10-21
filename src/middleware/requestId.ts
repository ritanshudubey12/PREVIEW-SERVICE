import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Accepts a well-formed X-Request-Id from the caller, otherwise generates one. Always echoed back. */
export const requestId: RequestHandler = (req, res, next) => {
  const supplied = req.header('x-request-id');
  req.requestId = supplied && VALID_REQUEST_ID.test(supplied) ? supplied : `req_${randomUUID()}`;
  res.setHeader('X-Request-Id', req.requestId);
  next();
};
