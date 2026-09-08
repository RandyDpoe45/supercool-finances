import { Env, parseEnv } from './env.schema';

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  /** DSN composed internally from the discrete parts (never read from env). */
  dsn: string;
}

export interface RedisConfig {
  host: string;
  port: number;
  password: string;
  /** URL composed internally from the discrete parts (never read from env). */
  url: string;
}

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  postgres: PostgresConfig;
  redis: RedisConfig;
  internalServiceToken: string;
}

/**
 * Compose the typed application config — including the Postgres DSN and the Redis
 * URL — from the discrete, validated env parts. Credentials are URL-encoded so a
 * password containing reserved characters cannot corrupt the DSN.
 */
export function buildConfig(env: Env): AppConfig {
  const postgres: PostgresConfig = {
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    dsn: `postgres://${encodeURIComponent(env.DB_USER)}:${encodeURIComponent(
      env.DB_PASSWORD,
    )}@${env.DB_HOST}:${env.DB_PORT}/${encodeURIComponent(env.DB_NAME)}`,
  };

  const redis: RedisConfig = {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    url: `redis://:${encodeURIComponent(env.REDIS_PASSWORD)}@${env.REDIS_HOST}:${env.REDIS_PORT}`,
  };

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    postgres,
    redis,
    internalServiceToken: env.INTERNAL_SERVICE_TOKEN,
  };
}

/** Validate `process.env` and build the typed config. Fail-fast on invalid env. */
export function loadConfig(): AppConfig {
  return buildConfig(parseEnv(process.env));
}
