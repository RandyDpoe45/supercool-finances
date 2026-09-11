/**
 * Test harness — the SINGLE place where the analytics-server test suite touches the
 * implementor's source (import wiring only). Everything else in tests/ depends on the
 * FIXED behavioral contract from specs/03-backend-foundation.md and the Step-3b
 * coordination contract (HTTP status codes, header names, env var names, error DTO
 * shape). If the implementor renames a module/export, this file is the only edit.
 *
 * This file does NOT reimplement any logic under test — it imports the real
 * classes/functions and provides plain scaffolding (env fixtures live in
 * ./env.fixture; a TCP reachability probe for the honest-SKIP integration gate).
 *
 * The candidate module paths mirror the just-merged balance-service layout (the
 * template), adjusted for analytics: Mongo (not Postgres), no `/api`. Redis is
 * config-only here in spec 05's storage step (the stream consumer arrives in A2).
 */

import * as net from 'net';

const SRC = '../../src';

function tryRequire(paths: string[]): any | null {
  for (const p of paths) {
    try {
      return require(p);
    } catch (e: any) {
      if (e && e.code === 'MODULE_NOT_FOUND') continue;
      // A real error inside a module that DOES exist (compile/dependency error)
      // must surface — never masked as "not found".
      throw e;
    }
  }
  return null;
}

function pickExport(mod: any, names: string[]): any | undefined {
  if (!mod) return undefined;
  for (const n of names) if (mod[n] !== undefined) return mod[n];
  return undefined;
}

function resolveOrThrow(what: string, candidates: string[], names: string[]): any {
  const found = pickExport(tryRequire(candidates), names);
  if (!found) {
    throw new Error(
      `[test harness] Could not resolve ${what}.\n` +
        `  Tried module paths: ${candidates.join(', ')}\n` +
        `  Looking for exports: ${names.join(', ')}\n` +
        `  If the implementor renamed it, update tests/support/harness.ts (the single ` +
        `coordination point) — see tests/README.md "Seam contract".`,
    );
  }
  return found;
}

/**
 * Config validation function — the one passed to the config factory. Contract:
 * `(raw) => TypedEnv`, throws (fail-fast) on any missing/invalid required var,
 * applies numeric defaults (PORT 3000, MONGO_PORT 27017) and the MONGO_AUTH_SOURCE
 * default (`analytics`), and coerces numeric fields.
 */
export function getValidateEnv(): (raw: Record<string, unknown>) => any {
  return resolveOrThrow(
    'the config validation function',
    [`${SRC}/config/env.schema`, `${SRC}/config/env.validation`, `${SRC}/config/configuration`],
    ['parseEnv', 'validateEnv', 'validate'],
  );
}

/**
 * The real config COMPOSER — returns a function `(rawEnv) => AppConfig` that runs
 * the implementor's actual DSN-composition code (so the `mongodb://` DSN under test
 * is the production one, not a re-implementation). Prefers the pure `buildConfig`
 * (fed by the real validation `parseEnv`); falls back to `loadConfig` via a
 * scoped process.env swap if only that is exported. Contract: it URL-encodes the
 * discrete credentials into `config.mongo.dsn`.
 */
export function getConfigComposer(): (raw: Record<string, unknown>) => any {
  const mod = tryRequire([`${SRC}/config/configuration`]);
  const buildConfig = pickExport(mod, ['buildConfig']);
  if (buildConfig) {
    const validateEnv = getValidateEnv();
    return (raw: Record<string, unknown>) => buildConfig(validateEnv(raw));
  }
  const loadConfig = pickExport(mod, ['loadConfig']);
  if (loadConfig) {
    return (raw: Record<string, unknown>) => {
      const saved = { ...process.env };
      try {
        for (const [k, v] of Object.entries(raw)) process.env[k] = String(v);
        return loadConfig();
      } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
      }
    };
  }
  throw new Error(
    `[test harness] Could not resolve the config composer.\n` +
      `  Tried module path: ${SRC}/config/configuration\n` +
      `  Looking for exports: buildConfig, loadConfig\n` +
      `  If the implementor renamed it, update tests/support/harness.ts.`,
  );
}

export interface ResolvedGuards {
  /** Global on /admin (analytics has no /api): reads X-User-Id (required) + X-Roles;
   *  enforces the admin role on /admin. Attaches request.identity = { userId, roles }. */
  GatewayIdentityGuard: any;
  /** Global on /internal: requires X-Service-Token === INTERNAL_SERVICE_TOKEN;
   *  exempts GET /internal/health. */
  ServiceIdentityGuard: any;
  /** Global exception filter producing the error DTO. */
  AllExceptionsFilter: any;
}

export function resolveGuardsAndFilter(): ResolvedGuards {
  return {
    GatewayIdentityGuard: resolveOrThrow(
      'the gateway identity guard',
      [`${SRC}/common/identity/gateway-identity.guard`],
      ['GatewayIdentityGuard'],
    ),
    ServiceIdentityGuard: resolveOrThrow(
      'the service identity guard',
      [`${SRC}/common/identity/service-identity.guard`],
      ['ServiceIdentityGuard'],
    ),
    AllExceptionsFilter: resolveOrThrow(
      'the global exception filter (error DTO)',
      [`${SRC}/common/errors/all-exceptions.filter`],
      ['AllExceptionsFilter'],
    ),
  };
}

/** DI token the ServiceIdentityGuard injects to read `internalServiceToken`. */
export function getAppConfigToken(): symbol {
  return resolveOrThrow('the APP_CONFIG DI token', [`${SRC}/config/config.tokens`], ['APP_CONFIG']);
}

/** The real health controller + the readiness-repository token (faked in tests).
 *  For analytics the readiness probe pings Mongo (not Postgres). */
export function getHealth(): { HealthController: any; HEALTH_REPOSITORY: symbol } {
  return {
    HealthController: resolveOrThrow(
      'the health controller',
      [`${SRC}/health/health.controller`],
      ['HealthController'],
    ),
    HEALTH_REPOSITORY: resolveOrThrow(
      'the health repository token',
      [`${SRC}/health/health-repository.interface`],
      ['HEALTH_REPOSITORY'],
    ),
  };
}

/** A real guarded /internal probe controller (contrast to the health carve-out).
 *  Used for the case-bypass negatives because it has NO self-defense — a guard
 *  bypass surfaces as 200 rather than being masked by a self-throwing handler. */
export function getInternalProbeController(): any {
  return resolveOrThrow(
    'the internal probe controller',
    [`${SRC}/modules/internal/internal.controller`],
    ['InternalController'],
  );
}

/** Correlation-id middleware that threads `requestId` onto the request/response. */
export function getRequestId(): {
  requestIdMiddleware: any;
  REQUEST_ID_HEADER: string;
} {
  const mod = resolveOrThrow(
    'the request-id middleware',
    [`${SRC}/common/request-context/request-id.middleware`],
    ['requestIdMiddleware'],
  );
  const headerMod = tryRequire([`${SRC}/common/request-context/request-id.middleware`]);
  return {
    requestIdMiddleware: mod,
    REQUEST_ID_HEADER: headerMod?.REQUEST_ID_HEADER ?? 'x-request-id',
  };
}

/** The root NestJS module — only the Docker-gated integration suite needs it. */
export function getAppModule(): any {
  return resolveOrThrow('the root AppModule', [`${SRC}/app.module`], ['AppModule']);
}

/**
 * Spec-05 storage layer (step A1) seams. Kept behind the single coordination point:
 * if the implementor renames a module/token, only this file changes. Resolvers are
 * called lazily (inside the opted-in integration `beforeAll`) so the suite still
 * SKIPS cleanly — never errors on import — when the storage layer is absent.
 */

/** The global config module (provides + exports the APP_CONFIG token from process.env). */
export function getConfigModule(): any {
  return resolveOrThrow(
    'the global config module',
    [`${SRC}/config/config.module`],
    ['AppConfigModule'],
  );
}

/** The Mongoose root-connection module (wires the composed Mongo DSN). */
export function getDatabaseModule(): any {
  return resolveOrThrow(
    'the database module',
    [`${SRC}/database/database.module`],
    ['DatabaseModule'],
  );
}

/** The persistence module — registers the `transactions` model + the repository provider. */
export function getPersistenceModule(): any {
  return resolveOrThrow(
    'the persistence module (spec 05 read-model wiring)',
    [`${SRC}/database/persistence.module`],
    ['PersistenceModule'],
  );
}

/**
 * DI token for the transactions read-model repository (interface-behind-token). The
 * concrete impl is bound to this token in the persistence module; consumers (and the
 * integration test) resolve the repo through it, never the concrete class.
 */
export function getTransactionsRepositoryToken(): symbol {
  return resolveOrThrow(
    'the transactions repository DI token',
    [
      `${SRC}/database/repositories/interfaces/transactions.repository.interface`,
      `${SRC}/database/repositories/interfaces/transactions.repository`,
    ],
    ['TRANSACTIONS_REPOSITORY'],
  );
}

/**
 * Spec-05 stream-consumer layer (step A2) seams. Same coordination discipline as the
 * A1 resolvers above: called LAZILY (inside opted-in integration `beforeAll`, or the
 * projection unit suite's own `beforeAll`), so the default `npm test` never touches
 * them — if the consumer layer is absent the suites SKIP (integration) or fail with a
 * single actionable message (the pure projection unit), never mask a missing seam.
 *
 * Candidate module paths are guesses at the A2 layout (the consumer feature module);
 * the STABLE contract is the EXPORT NAMES — `projectEvent`, `STREAM_CONSUMER_SERVICE`,
 * `REDIS_CLIENT`. If the implementor lands them under a different path/name, THIS file
 * is the single edit point (see tests/README.md "Seam contract").
 */

/**
 * The pure projection function: `projectEvent(eventId, eventType, payloadJson)` →
 * `TransactionReadModel`. No Redis/Mongo — it parses the wire payload (camelCase,
 * money as int64 STRINGS) into the stored shape (money as `bigint`). Throws on a
 * malformed payload so the consumer can leave the entry unacked.
 */
export function getProjectEvent(): (
  eventId: string,
  eventType: string,
  payloadJson: string,
) => any {
  return resolveOrThrow(
    'the pure projectEvent projection',
    [
      `${SRC}/modules/consumer/service/project-event`,
      `${SRC}/modules/consumer/service/projection`,
      `${SRC}/modules/consumer/projection/project-event`,
      `${SRC}/modules/consumer/service/impl/project-event`,
      `${SRC}/modules/consumer/project-event`,
      `${SRC}/modules/stream-consumer/service/project-event`,
      `${SRC}/modules/stream/service/project-event`,
      `${SRC}/consumer/project-event`,
    ],
    ['projectEvent'],
  );
}

/**
 * DI token for the stream-consumer service (interface-behind-token). Resolved from a
 * booted app via `app.get(token, { strict: false })`. The service exposes
 * `ensureGroup(): Promise<void>` and `consumeOnce(options?): Promise<number>`.
 */
export function getStreamConsumerToken(): symbol {
  return resolveOrThrow(
    'the stream-consumer service DI token',
    [
      `${SRC}/modules/consumer/service/interfaces/stream-consumer.service.interface`,
      `${SRC}/modules/consumer/service/interfaces/consumer.service.interface`,
      `${SRC}/modules/consumer/service/interfaces/stream-consumer.service`,
      `${SRC}/modules/consumer/consumer.tokens`,
      `${SRC}/modules/stream-consumer/service/interfaces/stream-consumer.service.interface`,
      `${SRC}/modules/stream/service/interfaces/stream-consumer.service.interface`,
    ],
    ['STREAM_CONSUMER_SERVICE'],
  );
}

/**
 * DI token for the global ioredis client. Resolved from a booted app via
 * `app.get(token, { strict: false })`; the integration suite reuses this REAL client
 * to `XADD` events + inspect the PEL (`XPENDING`), so the test drives the exact same
 * Redis the consumer reads (one connection, loop disabled, sequential ops).
 */
export function getRedisClientToken(): symbol {
  return resolveOrThrow(
    'the REDIS_CLIENT DI token',
    [
      `${SRC}/redis/redis.tokens`,
      `${SRC}/redis/redis.constants`,
      `${SRC}/redis/redis.module`,
      `${SRC}/common/redis/redis.tokens`,
      `${SRC}/database/redis/redis.tokens`,
      `${SRC}/modules/redis/redis.tokens`,
      `${SRC}/modules/redis/redis.module`,
    ],
    ['REDIS_CLIENT'],
  );
}

/**
 * Spec-05 reporting layer (step A3) seams — the role-gated `/admin/reports` API over
 * the Mongo read model. Same coordination discipline as the A1/A2 resolvers above:
 * called LAZILY (inside the opted-in integration `beforeAll`, the no-Docker e2e
 * `beforeAll`, or the serializer unit suite's `beforeAll`), so the default `npm test`
 * never touches them — an absent reporting layer SKIPS (integration) or fails with a
 * single actionable message (e2e / unit), never masks a missing seam.
 *
 * Candidate module paths guess the A3 layout (a `reporting`/`reports` feature module
 * with an `admin` surface controller, per the controller-surface convention); the
 * STABLE contract is the EXPORT NAMES — `ReportingModule`, `REPORTING_SERVICE`,
 * `REPORTING_REPOSITORY`, the admin controller class, and the two whitelist
 * serializers `serializeAccountSummary` / `serializeDailyAggregate`. If the
 * implementor lands them under a different path/name, THIS file is the single edit.
 */

/** The reporting feature module — provides + exports REPORTING_SERVICE and owns the
 *  `/admin/reports` controller. Imported by the integration boot alongside the
 *  persistence layer so the real aggregation pipelines run against a live Mongo. */
export function getReportingModule(): any {
  return resolveOrThrow(
    'the reporting feature module (spec 05 step A3)',
    [
      `${SRC}/modules/reporting/reporting.module`,
      `${SRC}/modules/reports/reports.module`,
      `${SRC}/modules/admin-reporting/admin-reporting.module`,
    ],
    ['ReportingModule', 'ReportsModule', 'AdminReportingModule'],
  );
}

/** DI token for the reporting SERVICE (interface-behind-token). The service owns the
 *  business rules (clamping/normalization) and returns domain objects; consumers
 *  resolve it through this token, never the concrete class. */
export function getReportingServiceToken(): symbol {
  return resolveOrThrow(
    'the reporting service DI token',
    [
      `${SRC}/modules/reporting/service/interfaces/reporting.service.interface`,
      `${SRC}/modules/reporting/service/interfaces/reporting.service`,
      `${SRC}/modules/reports/service/interfaces/reporting.service.interface`,
      `${SRC}/modules/reporting/reporting.tokens`,
      `${SRC}/modules/reports/reports.tokens`,
    ],
    ['REPORTING_SERVICE'],
  );
}

/** DI token for the reporting REPOSITORY (interface-behind-token). The repository
 *  runs the query-time aggregation pipelines over `transactions`. */
export function getReportingRepositoryToken(): symbol {
  return resolveOrThrow(
    'the reporting repository DI token',
    [
      `${SRC}/database/repositories/interfaces/reporting.repository.interface`,
      `${SRC}/database/repositories/interfaces/reporting.repository`,
      `${SRC}/modules/reporting/repository/interfaces/reporting.repository.interface`,
      `${SRC}/modules/reporting/service/interfaces/reporting.repository.interface`,
    ],
    ['REPORTING_REPOSITORY'],
  );
}

/** The real `/admin/reports` controller class (bound in a minimal e2e module to prove
 *  role-gating + validation + the wrapped/serialized wire shape without Docker). */
export function getReportsController(): any {
  return resolveOrThrow(
    'the admin reporting controller (spec 05 step A3)',
    [
      `${SRC}/modules/reporting/admin/reports-admin.controller`,
      `${SRC}/modules/reporting/admin/reporting-admin.controller`,
      `${SRC}/modules/reporting/admin/reports.controller`,
      `${SRC}/modules/reports/admin/reports-admin.controller`,
      `${SRC}/modules/reporting/reporting-admin.controller`,
      `${SRC}/modules/reporting/reports.controller`,
    ],
    [
      'ReportsAdminController',
      'ReportingAdminController',
      'ReportsController',
      'ReportingController',
      'AdminReportsController',
    ],
  );
}

/** The two whitelist serializers (pure functions): domain object -> wire DTO. Money
 *  becomes a STRING (bigint/int64 -> decimal string, exact past 2^53), dates ISO. */
export function getReportingSerializers(): {
  serializeAccountSummary: (summary: any) => any;
  serializeDailyAggregate: (aggregate: any) => any;
} {
  const candidates = [
    `${SRC}/modules/reporting/admin/serializers/account-summary.serializer`,
    `${SRC}/modules/reporting/admin/serializers/reporting.serializer`,
    `${SRC}/modules/reporting/admin/serializers/reports.serializer`,
    `${SRC}/modules/reporting/serializers/account-summary.serializer`,
    `${SRC}/modules/reports/admin/serializers/account-summary.serializer`,
  ];
  const serializeAccountSummary = resolveOrThrow(
    'serializeAccountSummary (account-summary whitelist serializer)',
    candidates,
    ['serializeAccountSummary'],
  );
  const dailyCandidates = [
    `${SRC}/modules/reporting/admin/serializers/daily-aggregate.serializer`,
    `${SRC}/modules/reporting/admin/serializers/reporting.serializer`,
    `${SRC}/modules/reporting/admin/serializers/reports.serializer`,
    `${SRC}/modules/reporting/serializers/daily-aggregate.serializer`,
    `${SRC}/modules/reports/admin/serializers/daily-aggregate.serializer`,
  ];
  const serializeDailyAggregate = resolveOrThrow(
    'serializeDailyAggregate (daily-aggregate whitelist serializer)',
    dailyCandidates,
    ['serializeDailyAggregate'],
  );
  return { serializeAccountSummary, serializeDailyAggregate };
}

/**
 * Best-effort TCP reachability probe for the honest-SKIP integration gate. Resolves
 * true iff a TCP connection to host:port opens within `timeoutMs`. Never throws.
 */
export function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}
