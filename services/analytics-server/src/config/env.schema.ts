import { z } from 'zod';

/**
 * The analytics server defines its OWN env var names (it is a self-contained
 * component — ADR-16). docker-compose maps the root discrete credentials into
 * these names; the service never reads a pre-assembled `*_URL` string and
 * composes its own MongoDB DSN + Redis URL from these discrete parts (see
 * configuration.ts).
 *
 * Redis (the transaction-stream consumer's connection) belongs to spec 05 and IS
 * declared here as of the read-model storage layer — it is now a required part of
 * the config surface (the earlier foundation "Mongo-only" note is superseded). The
 * consumer's Redis CLIENT + `data`-network wiring land with the A2 consumer; this
 * schema only makes the connection config present so the service still boots with
 * the now-required vars.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  MONGO_HOST: z.string().min(1),
  MONGO_PORT: z.coerce.number().int().positive().default(27017),
  MONGO_DB: z.string().min(1),
  MONGO_USER: z.string().min(1),
  MONGO_PASSWORD: z.string().min(1),
  MONGO_AUTH_SOURCE: z.string().min(1).default('analytics'),

  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().min(1),

  // Shared secret for the `/internal` service-identity guard.
  INTERNAL_SERVICE_TOKEN: z.string().min(1),
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
