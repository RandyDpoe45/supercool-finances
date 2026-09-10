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
  /** Shared HMAC signing secret the external rail webhooks (`/external` surface) sign each
   *  request with — the guard recomputes `HMAC-SHA256(secret, "<t>.<rawBody>")` and compares it
   *  constant-time. A raw secret — never composed into a URL/DSN (discrete-credentials rule). A
   *  DISTINCT trust domain from the `/internal` service token (`X-Service-Token`) and the `/api`
   *  gateway identity (`X-User-Id`). */
  webhookSigningSecret: string;
}

export interface RelayConfig {
  /** Whether the in-process outbox relay poll loop runs (spec 04 step 6). Disabled in the
   *  e2e/integration fixtures so booting AppModule doesn't spin the timer. */
  enabled: boolean;
  /** Poll cadence in ms between drain ticks when idle (not draining a backlog). Positive. */
  pollIntervalMs: number;
  /** Max outbox rows claimed + published per drain tick. A full batch fast-drains the backlog. */
  batchSize: number;
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
  relay: RelayConfig;
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

  const rails: RailsConfig = { webhookSigningSecret: env.RAILS_WEBHOOK_SIGNING_SECRET };

  const relay: RelayConfig = {
    enabled: env.RELAY_ENABLED,
    pollIntervalMs: env.RELAY_POLL_INTERVAL_MS,
    batchSize: env.RELAY_BATCH_SIZE,
  };

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    postgres,
    redis,
    internalServiceToken: env.INTERNAL_SERVICE_TOKEN,
    otp,
    payees,
    rails,
    relay,
  };
}

/** Validate `process.env` and build the typed config. Fail-fast on invalid env. */
export function loadConfig(): AppConfig {
  return buildConfig(parseEnv(process.env));
}
