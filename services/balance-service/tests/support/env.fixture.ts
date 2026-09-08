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
    ...overrides,
  };
}

/** Same as completeRawEnv but with the given keys removed (to prove fail-fast). */
export function rawEnvWithout(...keys: string[]): Record<string, unknown> {
  const env = completeRawEnv();
  for (const k of keys) delete env[k];
  return env;
}
