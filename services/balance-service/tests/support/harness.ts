/**
 * Test harness — the SINGLE place where the test suite touches the implementor's
 * source (import wiring only). Everything else in tests/ depends on the FIXED
 * behavioral contract from specs/03-backend-foundation.md and the Step-3a
 * coordination contract (HTTP status codes, header names, env var names, error DTO
 * shape). If the implementor renames a module/export, this file is the only edit.
 *
 * This file does NOT reimplement any logic under test — it imports the real
 * classes/functions and provides plain scaffolding (env fixtures live in
 * ./env.fixture; a TCP reachability probe for the honest-SKIP integration gate).
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
 * applies numeric defaults (PORT 3000, DB_PORT 5432, REDIS_PORT 6379) and coerces
 * numeric fields.
 */
export function getValidateEnv(): (raw: Record<string, unknown>) => any {
  return resolveOrThrow(
    'the config validation function',
    [`${SRC}/config/env.schema`, `${SRC}/config/env.validation`, `${SRC}/config/configuration`],
    ['parseEnv', 'validateEnv', 'validate'],
  );
}

export interface ResolvedGuards {
  /** Global on /api and /admin: reads X-User-Id (required) + X-Roles; enforces the
   *  admin role on /admin. Attaches request.identity = { userId, roles }. */
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

/** The real health controller + the readiness-repository token (faked in tests). */
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

/** A real guarded /internal probe controller (contrast to the health carve-out). */
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
 * Return the FIRST candidate module that actually EXPORTS one of `names`. Unlike
 * `resolveOrThrow` (which only inspects the first requireable module), this keeps
 * scanning — so a barrel that exists but does not re-export a given repository token
 * falls through to the per-file candidate. Missing modules are skipped; a real
 * compile/dependency error inside an existing module still surfaces.
 */
function findExportAcross(candidates: string[], names: string[]): any | undefined {
  for (const p of candidates) {
    let mod: any;
    try {
      mod = require(p);
    } catch (e: any) {
      if (e && e.code === 'MODULE_NOT_FOUND') continue;
      throw e;
    }
    const hit = pickExport(mod, names);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * The Step-3 persistence module (optional). Returned so the integration suite can
 * import it into its testing module and put the DI wiring itself under test. Returns
 * null if the repos are wired directly into another module (e.g. DatabaseModule)
 * instead of a dedicated PersistenceModule — in that case the suite falls back to
 * resolving the tokens through the booted AppModule graph.
 */
export function tryResolvePersistenceModule(): any | null {
  return (
    findExportAcross(
      [
        `${SRC}/persistence/persistence.module`,
        `${SRC}/persistence`,
        `${SRC}/database/persistence.module`,
        `${SRC}/database/repositories/repositories.module`,
        `${SRC}/database/repositories/persistence.module`,
        `${SRC}/database/repositories`,
        `${SRC}/persistence/repositories.module`,
      ],
      ['PersistenceModule', 'RepositoriesModule'],
    ) ?? null
  );
}

/**
 * Resolve a repository DI token (a Symbol) by its export name. `fileBase` is the
 * kebab-case entity file base (e.g. 'ledger-entry') used to probe the per-repo file
 * when there is no central token barrel. Follows the same interface/token convention
 * as HEALTH_REPOSITORY. Throws an actionable error naming what is missing (this file
 * is the single edit point if the implementor names things differently).
 */
export function getRepositoryToken(tokenName: string, fileBase: string): symbol {
  const token = findExportAcross(
    [
      `${SRC}/persistence/persistence.tokens`,
      `${SRC}/persistence/tokens`,
      `${SRC}/persistence`,
      `${SRC}/persistence/${fileBase}.repository`,
      `${SRC}/persistence/${fileBase}.repository.interface`,
      `${SRC}/persistence/${fileBase}/${fileBase}.repository`,
      `${SRC}/database/repositories/tokens`,
      `${SRC}/database/repositories`,
      `${SRC}/database/repositories/${fileBase}.repository`,
      `${SRC}/database/repositories/${fileBase}.repository.interface`,
      `${SRC}/database/repositories/${fileBase}/${fileBase}.repository`,
    ],
    [tokenName],
  );
  if (token === undefined) {
    throw new Error(
      `[test harness] Could not resolve the ${tokenName} DI token (repo file base ` +
        `'${fileBase}'). If the implementor put it elsewhere, add the path/export to ` +
        `tests/support/harness.ts:getRepositoryToken — the single coordination point.`,
    );
  }
  return token as symbol;
}

/**
 * The pure available-balance money helper — `availableBalance(balance, held) => string`,
 * computing `(BigInt(balance) - BigInt(held)).toString()` (BigInt math, NEVER Number, so
 * minor-unit values beyond 2^53 do not lose precision). Scanned across the plausible
 * domain-layer locations with `findExportAcross` (so a barrel that lacks the export does
 * not shadow the per-file one). If the implementor puts it elsewhere or names it
 * differently, add the path/export here — this is the single coordination point.
 */
export function getAvailableBalance(): (balance: string, held: string) => string {
  const fn = findExportAcross(
    [
      `${SRC}/modules/api/money`,
      `${SRC}/modules/api/money.util`,
      `${SRC}/modules/api/available-balance`,
      `${SRC}/modules/api/accounts/money`,
      `${SRC}/modules/api/accounts/available-balance`,
      `${SRC}/modules/api/dto/account.dto`,
      `${SRC}/common/money/money`,
      `${SRC}/common/money`,
      `${SRC}/common/money/available-balance`,
      `${SRC}/common/money.util`,
      `${SRC}/common/money.ts`,
      `${SRC}/domain/money`,
    ],
    ['availableBalance', 'computeAvailable', 'deriveAvailable'],
  );
  if (fn === undefined) {
    throw new Error(
      `[test harness] Could not resolve the available-balance money helper ` +
        `(availableBalance / computeAvailable / deriveAvailable). If the implementor put ` +
        `it elsewhere, add the path/export to tests/support/harness.ts:getAvailableBalance ` +
        `— the single coordination point.`,
    );
  }
  return fn as (balance: string, held: string) => string;
}

export interface AccountSerializers {
  /** Entity -> AccountDto: an explicit whitelist to {id,currency,status,kind,balance,held,available}. */
  serializeAccount: (account: any) => any;
  /** Entity -> StatementEntryDto: whitelist to {id,transactionId,delta,balanceAfter,currency,createdAt}. */
  serializeStatementEntry: (entry: any) => any;
}

/**
 * The controller-boundary serializers introduced by the Step-1 layering refactor
 * (services work in entities; controllers serialize to DTOs via explicit whitelists).
 * `serializeAccount(account) => AccountDto` and `serializeStatementEntry(entry) =>
 * StatementEntryDto`. Each export is scanned independently with `findExportAcross` across
 * the plausible locations; if the implementor names/locates them differently, add the
 * path/export here — this is the single coordination point.
 */
export function getAccountSerializers(): AccountSerializers {
  const candidates = [
    `${SRC}/modules/accounts/accounts.serializer`,
    `${SRC}/modules/accounts/account.serializer`,
    `${SRC}/modules/accounts/serializers`,
    `${SRC}/modules/accounts/serializer`,
    `${SRC}/modules/api/accounts.serializer`,
    `${SRC}/modules/api/serializers`,
    `${SRC}/common/serializers/account.serializer`,
  ];
  const serializeAccount = findExportAcross(candidates, [
    'serializeAccount',
    'toAccountDto',
    'accountToDto',
  ]);
  const serializeStatementEntry = findExportAcross(candidates, [
    'serializeStatementEntry',
    'toStatementEntryDto',
    'statementEntryToDto',
  ]);
  if (serializeAccount === undefined || serializeStatementEntry === undefined) {
    throw new Error(
      `[test harness] Could not resolve the account serializers ` +
        `(serializeAccount / serializeStatementEntry). If the implementor put them ` +
        `elsewhere, add the path/export to tests/support/harness.ts:getAccountSerializers ` +
        `— the single coordination point.`,
    );
  }
  return { serializeAccount, serializeStatementEntry };
}

/**
 * The read-only `AccountsService` class (Step-1 domain slice). Returned so a pure unit
 * test can `new AccountsService(mockAccountRepo, mockLedgerRepo)` and drive its
 * owner-scope guard directly (positional constructor args — DI decorators are inert under
 * plain instantiation). Scanned with `findExportAcross`; if the implementor moves/renames
 * it, add the path/export here — the single coordination point.
 */
export function getAccountsService(): any {
  const cls = findExportAcross(
    [
      `${SRC}/modules/accounts/accounts.service`,
      `${SRC}/modules/accounts/account.service`,
      `${SRC}/modules/api/accounts.service`,
    ],
    ['AccountsService'],
  );
  if (cls === undefined) {
    throw new Error(
      `[test harness] Could not resolve AccountsService. If the implementor moved/renamed ` +
        `it, add the path/export to tests/support/harness.ts:getAccountsService — the ` +
        `single coordination point.`,
    );
  }
  return cls;
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
