import type { Request, Response } from 'express';
import type { Config } from '../../config/env.js';
import { createPreviewBodySchema, pageIdParam, parseOrThrow } from './preview.schemas.js';
import type { PreviewService } from './preview.service.js';

const ok = (req: Request, res: Response, status: number, data: unknown) =>
  res.status(status).json({ success: true, data, meta: { requestId: req.requestId } });

export function createPreviewController(config: Config, service: PreviewService) {
  const bodySchema = createPreviewBodySchema(config);
  return {
    async create(req: Request, res: Response) {
      const pageId = parseOrThrow(pageIdParam, req.params.pageId, 'pageId');
      const body = parseOrThrow(bodySchema, req.body ?? {}, 'body');
      const data = await service.create({
        ctx: req.auth!,
        requestId: req.requestId,
        pageId,
        revisionId: body.revisionId,
        expiresInSeconds: body.expiresInSeconds,
      });
      ok(req, res, 201, data);
    },

    async resolve(req: Request, res: Response) {
      const data = await service.resolve(String(req.params.token), req.requestId);
      ok(req, res, 200, data);
    },

    async revoke(req: Request, res: Response) {
      await service.revoke({ ctx: req.auth!, requestId: req.requestId, token: String(req.params.token) });
      res.status(204).end();
    },
  };
}
