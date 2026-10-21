import { z } from 'zod';

// Asymmetric algorithms only: an HS* secret must never double as a public verification key.
export const ALLOWED_JWT_ALGORITHMS = [
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA',
] as const;

const bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');
const optionalString = z.string().trim().min(1).optional();

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: bool,

    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().int().min(1).max(65535),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().min(1),
    DB_NAME: z.string().min(1),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    DB_SSL: bool,

    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1),
    JWT_ALGORITHMS: z
      .string()
      .default('RS256')
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
      .pipe(z.array(z.enum(ALLOWED_JWT_ALGORITHMS)).min(1)),
    JWT_PUBLIC_KEY: optionalString,
    JWT_JWKS_URL: z.url().optional(),
    JWT_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(60).default(5),

    PREVIEW_ORIGIN: z.url(),
    PREVIEW_TTL_DEFAULT_SECONDS: z.coerce.number().int().min(1).default(1800),
    PREVIEW_TTL_MIN_SECONDS: z.coerce.number().int().min(1).default(60),
    PREVIEW_TTL_MAX_SECONDS: z.coerce.number().int().min(1).default(86400),

    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_WRITE_MAX: z.coerce.number().int().min(1).default(30),
    RATE_LIMIT_RESOLVE_MAX: z.coerce.number().int().min(1).default(120),

    PAGE_REVISION_MODE: z.enum(['http', 'stub']).default('http'),
    PAGE_REVISION_SERVICE_URL: z.url().optional(),
    PAGE_REVISION_SERVICE_TOKEN: optionalString,
    PAGE_REVISION_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
  })
  .superRefine((e, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (!e.JWT_PUBLIC_KEY && !e.JWT_JWKS_URL) fail('JWT_PUBLIC_KEY', 'Set JWT_PUBLIC_KEY or JWT_JWKS_URL');
    if (e.JWT_PUBLIC_KEY && e.JWT_JWKS_URL) fail('JWT_JWKS_URL', 'Set only one of JWT_PUBLIC_KEY or JWT_JWKS_URL');
    if (e.PREVIEW_TTL_MIN_SECONDS > e.PREVIEW_TTL_MAX_SECONDS) fail('PREVIEW_TTL_MIN_SECONDS', 'min must be <= max');
    if (e.PREVIEW_TTL_DEFAULT_SECONDS < e.PREVIEW_TTL_MIN_SECONDS || e.PREVIEW_TTL_DEFAULT_SECONDS > e.PREVIEW_TTL_MAX_SECONDS) {
      fail('PREVIEW_TTL_DEFAULT_SECONDS', 'default must be within [min, max]');
    }
    if (e.PAGE_REVISION_MODE === 'stub' && e.NODE_ENV === 'production') {
      fail('PAGE_REVISION_MODE', 'stub mode is not allowed in production');
    }
    if (e.PAGE_REVISION_MODE === 'http' && !e.PAGE_REVISION_SERVICE_URL) {
      fail('PAGE_REVISION_SERVICE_URL', 'required when PAGE_REVISION_MODE=http');
    }
  });

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  // `KEY=` in a .env file yields "", which must behave exactly like an unset variable.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    db: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      user: e.DB_USER,
      password: e.DB_PASSWORD,
      database: e.DB_NAME,
      poolMax: e.DB_POOL_MAX,
      ssl: e.DB_SSL,
    },
    jwt: {
      issuer: e.JWT_ISSUER,
      audience: e.JWT_AUDIENCE,
      algorithms: e.JWT_ALGORITHMS,
      // PEM keys are usually stored on one line with literal "\n" in env files.
      publicKeyPem: e.JWT_PUBLIC_KEY?.replace(/\\n/g, '\n'),
      jwksUrl: e.JWT_JWKS_URL,
      clockToleranceSeconds: e.JWT_CLOCK_TOLERANCE_SECONDS,
    },
    preview: {
      origin: e.PREVIEW_ORIGIN.replace(/\/+$/, ''),
      ttlDefaultSeconds: e.PREVIEW_TTL_DEFAULT_SECONDS,
      ttlMinSeconds: e.PREVIEW_TTL_MIN_SECONDS,
      ttlMaxSeconds: e.PREVIEW_TTL_MAX_SECONDS,
    },
    rateLimit: {
      windowSeconds: e.RATE_LIMIT_WINDOW_SECONDS,
      writeMax: e.RATE_LIMIT_WRITE_MAX,
      resolveMax: e.RATE_LIMIT_RESOLVE_MAX,
    },
    pageRevision: {
      mode: e.PAGE_REVISION_MODE,
      url: e.PAGE_REVISION_SERVICE_URL,
      serviceToken: e.PAGE_REVISION_SERVICE_TOKEN,
      timeoutMs: e.PAGE_REVISION_TIMEOUT_MS,
    },
  };
}
