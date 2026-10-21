import type { RequestHandler } from 'express';

/** Preview URLs carry a bearer secret: never cache, index, or leak via Referer. */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
};
