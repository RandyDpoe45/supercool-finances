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

export interface OtpConfig {
  /** Pepper for the keyed HMAC that hashes OTP codes at rest. Raw secret — never
   *  composed into a URL/DSN (discrete-credentials rule). */
  hashSecret: string;
}

export interface PayeesConfig {
  /** External-payee cooling-off window in seconds: enrollment stamps
   *  `cooling_off_until = now() + coolingOffSeconds`, and a payee is a usable destination
   *  from that instant on. A validated positive integer (never user input). */
  coolingOffSeconds: number;
}

export interface RailsConfig {
  /** Shared API key the external rail webhooks (`/external` surface) must present as
   *  `X-Api-Key`, constant-time compared. A raw secret — never composed into a URL/DSN
   *  (discrete-credentials rule). A DISTINCT trust domain from the `/internal` service token
   *  (`X-Service-Token`) and the `/api` gateway identity (`X-User-Id`). */
  webhookApiKey: string;
}

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  postgres: PostgresConfig;
  redis: RedisConfig;
  internalServiceToken: string;
  otp: OtpConfig;
  payees: PayeesConfig;
  rails: RailsConfig;
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

  const otp: OtpConfig = { hashSecret: env.OTP_HASH_SECRET };

  const payees: PayeesConfig = { coolingOffSeconds: env.PAYEE_COOLING_OFF_SECONDS };

  const rails: RailsConfig = { webhookApiKey: env.RAILS_WEBHOOK_API_KEY };

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    postgres,
    redis,
    internalServiceToken: env.INTERNAL_SERVICE_TOKEN,
    otp,
    payees,
    rails,
  };
}

/** Validate `process.env` and build the typed config. Fail-fast on invalid env. */
export function loadConfig(): AppConfig {
  return buildConfig(parseEnv(process.env));
}
