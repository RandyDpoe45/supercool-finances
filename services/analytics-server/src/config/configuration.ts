import { Env, parseEnv } from './env.schema';

export interface MongoConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  authSource: string;
  /** DSN composed internally from the discrete parts (never read from env). */
  dsn: string;
}

export interface RedisConfig {
  host: string;
  port: number;
  password: string;
  /** URL composed internally from the discrete parts (never read from env). The
   *  transaction-stream consumer (spec 05, step A2) connects with this; declared
   *  here so config is present ahead of the client. */
  url: string;
}

/** Transaction-stream consumer knobs (spec 05, step A2). Only `enabled` is env-driven
 *  (so tests can boot AppModule without spinning the live loop); the group/consumer
 *  names + block/count/min-idle live as code constants in the consumer impl. */
export interface ConsumerConfig {
  enabled: boolean;
}

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  mongo: MongoConfig;
  redis: RedisConfig;
  consumer: ConsumerConfig;
  internalServiceToken: string;
}

/**
 * Compose the typed application config — including the MongoDB DSN and the Redis
 * URL — from the discrete, validated env parts. Credentials are URL-encoded so a
 * password containing reserved characters cannot corrupt the DSN/URL, and
 * `authSource` names the DB the app user authenticates against (the
 * least-privilege `analytics` user).
 */
export function buildConfig(env: Env): AppConfig {
  const mongo: MongoConfig = {
    host: env.MONGO_HOST,
    port: env.MONGO_PORT,
    database: env.MONGO_DB,
    username: env.MONGO_USER,
    password: env.MONGO_PASSWORD,
    authSource: env.MONGO_AUTH_SOURCE,
    dsn: `mongodb://${encodeURIComponent(env.MONGO_USER)}:${encodeURIComponent(
      env.MONGO_PASSWORD,
    )}@${env.MONGO_HOST}:${env.MONGO_PORT}/${encodeURIComponent(
      env.MONGO_DB,
    )}?authSource=${encodeURIComponent(env.MONGO_AUTH_SOURCE)}`,
  };

  const redis: RedisConfig = {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    url: `redis://:${encodeURIComponent(env.REDIS_PASSWORD)}@${env.REDIS_HOST}:${env.REDIS_PORT}`,
  };

  const consumer: ConsumerConfig = {
    enabled: env.ANALYTICS_CONSUMER_ENABLED,
  };

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    mongo,
    redis,
    consumer,
    internalServiceToken: env.INTERNAL_SERVICE_TOKEN,
  };
}

/** Validate `process.env` and build the typed config. Fail-fast on invalid env. */
export function loadConfig(): AppConfig {
  return buildConfig(parseEnv(process.env));
}
