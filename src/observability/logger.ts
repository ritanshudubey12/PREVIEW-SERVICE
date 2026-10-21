import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

// Defence in depth: even if a caller logs one of these keys by mistake, the value is censored.
const REDACT_PATHS = [
  'authorization',
  'token',
  'jwt',
  'password',
  'tokenHash',
  '*.authorization',
  '*.token',
  '*.jwt',
  '*.password',
  'req.headers.authorization',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'preview-service' },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}
