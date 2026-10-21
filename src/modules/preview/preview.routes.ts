import { Router } from 'express';
import type { Config } from '../../config/env.js';
import { authenticate, type JwtVerifier } from '../../middleware/authenticate.js';
import { resolveRateLimit, writeRateLimit } from '../../middleware/rateLimit.js';
import { trustedRequestContext } from '../../middleware/trustedRequestContext.js';
import { createPreviewController } from './preview.controller.js';
import type { PreviewService } from './preview.service.js';

export function createPreviewRouter(config: Config, service: PreviewService, verify: JwtVerifier): Router {
  const router = Router();
  const ctrl = createPreviewController(config, service);
  const auth = [authenticate(verify), trustedRequestContext, writeRateLimit(config)];

  // Canonical routes only (plural /previews); no singular aliases.
  router.post('/pages/:pageId/previews', ...auth, ctrl.create);
  router.get('/previews/:token', resolveRateLimit(config), ctrl.resolve);
  router.delete('/previews/:token', ...auth, ctrl.revoke);
  return router;
}
