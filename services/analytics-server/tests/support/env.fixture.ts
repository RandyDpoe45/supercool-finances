/**
 * A COMPLETE, VALID raw env for the analytics server, matching the Step-3b
 * coordination contract exactly (the service reads its OWN discrete vars — never a
 * pre-assembled `*_URL`, per the storage-layer decision; ADR-16 no shared code).
 * Values are strings because real process env values are always strings; the config
 * schema is responsible for coercing the numeric ones (PORT / MONGO_PORT).
 *
 * NOTE (vs the balance service): analytics owns Mongo only — there is NO Redis and
 * NO Postgres/TypeORM here in the foundation. So this env carries the MONGO_* set
 * plus the shared INTERNAL_SERVICE_TOKEN, and nothing else.
 *
 * Tests build on this and then DELETE or corrupt individual keys to exercise the
 * fail-fast paths, so every required key is present here by default.
 */
export function completeRawEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    NODE_ENV: 'test',
    PORT: '3000',
    MONGO_HOST: 'mongo',
    MONGO_PORT: '27017',
    MONGO_DB: 'analytics',
    MONGO_USER: 'analytics_app',
    MONGO_PASSWORD: 'changeme-analytics-local',
    MONGO_AUTH_SOURCE: 'analytics',
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
