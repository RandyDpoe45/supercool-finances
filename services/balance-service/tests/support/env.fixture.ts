/**
 * A COMPLETE, VALID raw env for the balance service, matching the Step-3a
 * coordination contract exactly (the service reads its OWN discrete vars — never a
 * pre-assembled *_URL, per the storage-layer decision). Values are strings because
 * real process env values are always strings; the config schema is responsible for
 * coercing the numeric ones (PORT / DB_PORT / REDIS_PORT).
 *
 * Tests build on this and then DELETE or corrupt individual keys to exercise the
 * fail-fast paths, so every required key is present here by default.
 */
export function completeRawEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    NODE_ENV: 'test',
    PORT: '3000',
    DB_HOST: 'postgres',
    DB_PORT: '5432',
    DB_NAME: 'balance',
    DB_USER: 'balance_app',
    DB_PASSWORD: 'changeme-balance-local',
    REDIS_HOST: 'redis',
    REDIS_PORT: '6379',
    REDIS_PASSWORD: 'changeme-redis-local',
    INTERNAL_SERVICE_TOKEN: 'test-internal-service-token',
    // Pepper for the keyed HMAC that hashes OTP codes at rest (env.schema requires >= 16 chars).
    OTP_HASH_SECRET: 'test-otp-hash-secret-0123456789',
    // Shared API key the `/external` rail webhooks present as `X-Api-Key` (env.schema requires
    // >= 16 chars). Used by the e2e as the correct key and to prove 401 on a wrong/missing one.
    RAILS_WEBHOOK_API_KEY: 'test-rails-webhook-api-key-0123456789',
    ...overrides,
  };
}

/** Same as completeRawEnv but with the given keys removed (to prove fail-fast). */
export function rawEnvWithout(...keys: string[]): Record<string, unknown> {
  const env = completeRawEnv();
  for (const k of keys) delete env[k];
  return env;
}
