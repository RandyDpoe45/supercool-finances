/**
 * A COMPLETE, VALID raw env for the analytics server (the service reads its OWN
 * discrete vars — never a pre-assembled `*_URL`, per the storage-layer decision;
 * ADR-16 no shared code). Values are strings because real process env values are
 * always strings; the config schema is responsible for coercing the numeric ones
 * (PORT / MONGO_PORT / REDIS_PORT).
 *
 * Analytics owns Mongo (the read model) AND, as of spec 05 (the stream consumer),
 * connects to Redis to read `events:transactions`. So this env carries the MONGO_*
 * set, the REDIS_* set (REDIS_HOST, REDIS_PORT default 6379, REDIS_PASSWORD), and the
 * shared INTERNAL_SERVICE_TOKEN. (There is still NO Postgres/TypeORM here.)
 *
 * This must stay a COMPLETE valid env: the config unit tests, the guard/error e2e
 * boots, and the Mongo integration boot all build on it and then DELETE or corrupt
 * individual keys to exercise the fail-fast paths — so every required key
 * (including the spec-05 Redis coordinates + secret) is present here by default.
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
