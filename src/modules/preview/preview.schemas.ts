import { z } from 'zod';
import type { Config } from '../../config/env.js';
import { validationError } from '../../errors.js';

export const pageIdParam = z.uuid();

export function createPreviewBodySchema(config: Config) {
  const { ttlMinSeconds, ttlMaxSeconds, ttlDefaultSeconds } = config.preview;
  return z
    .object({
      revisionId: z.uuid(),
      expiresInSeconds: z.number().int().min(ttlMinSeconds).max(ttlMaxSeconds).default(ttlDefaultSeconds),
    })
    .strict(); // unknown keys (e.g. tenantId, userId, role) are rejected, never ignored silently
}

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || label}: ${i.message}`).join('; ');
    throw validationError(detail);
  }
  return result.data;
}
