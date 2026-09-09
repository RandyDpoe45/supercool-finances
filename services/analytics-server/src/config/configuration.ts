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

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  mongo: MongoConfig;
  internalServiceToken: string;
}

/**
 * Compose the typed application config — including the MongoDB DSN — from the
 * discrete, validated env parts. Credentials are URL-encoded so a password
 * containing reserved characters cannot corrupt the DSN, and `authSource` names
 * the DB the app user authenticates against (the least-privilege `analytics` user).
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

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    mongo,
    internalServiceToken: env.INTERNAL_SERVICE_TOKEN,
  };
}

/** Validate `process.env` and build the typed config. Fail-fast on invalid env. */
export function loadConfig(): AppConfig {
  return buildConfig(parseEnv(process.env));
}
