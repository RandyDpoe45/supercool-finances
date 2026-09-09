import { z } from 'zod';

/**
 * The balance service defines its OWN env var names (it is a self-contained
 * component — ADR-16). docker-compose maps the root discrete credentials into
 * these names; the service never reads a pre-assembled `*_URL` string and
 * composes its own DSN/URL from these discrete parts (see configuration.ts).
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),

  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().min(1),

  // Shared secret for the `/internal` service-identity guard.
  INTERNAL_SERVICE_TOKEN: z.string().min(1),

  // Pepper for hashing OTP codes at rest (keyed HMAC); never stored in Redis.
  OTP_HASH_SECRET: z.string().min(16),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validate the raw environment once, at boot. Throws with a readable, aggregated
 * message on any missing/invalid required variable — the caller turns that into a
 * non-zero process exit (fail-fast).
 */
export function parseEnv(raw: Record<string, unknown>): Env {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
