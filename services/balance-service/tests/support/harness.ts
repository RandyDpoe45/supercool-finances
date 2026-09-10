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
      // interface/impl split refactor (balance-interface-impl-split): the interface + the
      // `<NAME>_REPOSITORY` token live under a sibling `interfaces/` folder (impl moves to
      // `impl/`). Old paths kept above so resolution is robust to either layout.
      `${SRC}/database/repositories/interfaces/${fileBase}.repository.interface`,
      `${SRC}/database/repositories/interfaces/${fileBase}.repository`,
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
    // PR #16 layout: the controller moved into its own `api/` surface folder with its
    // `serializers/` (and `dto/`). Old paths kept for robustness to either layout.
    `${SRC}/modules/accounts/api/serializers/accounts.serializer`,
    `${SRC}/modules/accounts/api/serializers/account.serializer`,
    `${SRC}/modules/accounts/api/serializers`,
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
      `${SRC}/modules/accounts/impl/accounts.service`,
      `${SRC}/modules/accounts/service/impl/accounts.service`,
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
 * The balance-mutating reducer CLASS — the single `postTransaction(command)` operation
 * (spec 04 Ledger/Transfers, ADR-13). Returned as a class so the DB-backed integration
 * suite can `app.get(PostingService, { strict: false })` and drive the REAL DI'd instance
 * (real repositories + DataSource) against Postgres — the only place the concurrency /
 * overdraft / no-money-created-or-lost invariants are actually provable. Scanned with
 * `findExportAcross` across the plausible domain-layer locations and export names; if the
 * implementor names/places it differently, add the path/export HERE — the single
 * coordination point (see tests/README.md "Seam contract").
 */
export function getPostingService(): any {
  const cls = findExportAcross(
    [
      `${SRC}/modules/ledger/posting.service`,
      `${SRC}/modules/ledger/ledger.service`,
      `${SRC}/modules/posting/posting.service`,
      `${SRC}/modules/posting/impl/posting.service`,
      `${SRC}/modules/posting/service/impl/posting.service`,
      `${SRC}/modules/ledger/impl/ledger.service`,
      `${SRC}/modules/ledger/service/impl/ledger.service`,
      `${SRC}/modules/transactions/posting.service`,
      `${SRC}/modules/transactions/transactions.service`,
      `${SRC}/modules/transfers/posting.service`,
      `${SRC}/modules/transfers/transfers.service`,
      `${SRC}/modules/transfers/transfer.service`,
      `${SRC}/modules/ledger/posting/posting.service`,
      `${SRC}/domain/posting/posting.service`,
      `${SRC}/modules/ledger`,
      `${SRC}/modules/posting`,
      `${SRC}/modules/transactions`,
      `${SRC}/modules/transfers`,
    ],
    [
      'PostingService',
      'LedgerService',
      'LedgerPostingService',
      'TransactionService',
      'TransactionsService',
      'TransfersService',
      'TransferService',
    ],
  );
  if (cls === undefined) {
    throw new Error(
      `[test harness] Could not resolve the postTransaction reducer service (PostingService / ` +
        `LedgerService / TransfersService …). If the implementor named/placed it differently, ` +
        `add the path/export to tests/support/harness.ts:getPostingService — the single ` +
        `coordination point.`,
    );
  }
  return cls;
}

/**
 * The generic idempotency wrapper CLASS — `execute(params, operation)` applies a money
 * operation at most once (replay returns the original result; a reused key with a different
 * fingerprint rejects; a soft-duplicate within 60s rejects unless confirmed). Returned as a
 * class so the DB-backed suite can `app.get(IdempotencyService, { strict: false })` and drive
 * the REAL DI'd instance against Postgres (the claim + operation commit together in one tx).
 * Scanned with `findExportAcross`; if the implementor names/places it differently, add the
 * path/export HERE — the single coordination point.
 */
export function getIdempotencyService(): any {
  const cls = findExportAcross(
    [
      `${SRC}/modules/idempotency/idempotency.service`,
      `${SRC}/modules/idempotency/impl/idempotency.service`,
      `${SRC}/modules/idempotency/service/impl/idempotency.service`,
      `${SRC}/modules/transfers/idempotency.service`,
      `${SRC}/modules/posting/idempotency.service`,
      `${SRC}/common/idempotency/idempotency.service`,
      `${SRC}/modules/idempotency`,
      `${SRC}/common/idempotency`,
      `${SRC}/modules/transfers`,
    ],
    ['IdempotencyService'],
  );
  if (cls === undefined) {
    throw new Error(
      `[test harness] Could not resolve the IdempotencyService (execute(params, operation)). ` +
        `If the implementor named/placed it differently, add the path/export to ` +
        `tests/support/harness.ts:getIdempotencyService — the single coordination point.`,
    );
  }
  return cls;
}

/**
 * Service DI TOKENS. Post interface/impl split each module binds
 * `{ provide: <SERVICE_TOKEN>, useClass: <ServiceClass> }` and exports the TOKEN, so the
 * running instance must be resolved from the app graph BY TOKEN (`app.get(<TOKEN>)`) —
 * `app.get(<Class>)` no longer resolves (the provider is keyed by the Symbol, not the class).
 * These mirror `getRepositoryToken`'s multi-path `findExportAcross` style. The CLASS resolvers
 * (`getPostingService` / `getIdempotencyService` / `getAccountsService`) remain for the pure
 * unit specs that `new` the service directly.
 */
function resolveServiceToken(tokenName: string, moduleBase: string): symbol {
  const token = findExportAcross(
    [
      `${SRC}/modules/${moduleBase}/interfaces/${moduleBase}.service.interface`,
      // PR #16 layout: service files move under `service/{interfaces,impl}`.
      `${SRC}/modules/${moduleBase}/service/interfaces/${moduleBase}.service.interface`,
      `${SRC}/modules/${moduleBase}/service/interfaces/${moduleBase}.service.tokens`,
      `${SRC}/modules/${moduleBase}/interfaces/${moduleBase}.service.tokens`,
      `${SRC}/modules/${moduleBase}/${moduleBase}.service.interface`,
      `${SRC}/modules/${moduleBase}/${moduleBase}.tokens`,
      `${SRC}/modules/${moduleBase}`,
    ],
    [tokenName],
  );
  if (token === undefined) {
    throw new Error(
      `[test harness] Could not resolve the ${tokenName} DI token (module '${moduleBase}'). ` +
        `If the implementor put it elsewhere, add the path/export to ` +
        `tests/support/harness.ts:resolveServiceToken — the single coordination point.`,
    );
  }
  return token as symbol;
}

/** `POSTING_SERVICE` — the DI token the PostingModule binds the reducer to. */
export function getPostingServiceToken(): symbol {
  return resolveServiceToken('POSTING_SERVICE', 'posting');
}

/** `IDEMPOTENCY_SERVICE` — the DI token the IdempotencyModule binds the wrapper to. */
export function getIdempotencyServiceToken(): symbol {
  return resolveServiceToken('IDEMPOTENCY_SERVICE', 'idempotency');
}

/** `ACCOUNTS_SERVICE` — the DI token the AccountsModule binds the read service to (added for
 *  completeness/consistency; no spec resolves it by token yet). */
export function getAccountsServiceToken(): symbol {
  return resolveServiceToken('ACCOUNTS_SERVICE', 'accounts');
}

export interface FingerprintInput {
  type: string;
  source: string | null;
  destination: string | null;
  amount: string;
  currency: string;
}

/**
 * BEST-EFFORT resolution of a PURE `computeFingerprint(input)` helper (the canonical hash of
 * `{type, source, destination, amount, currency}` used for soft-duplicate detection). Returns
 * `undefined` when no such pure export exists — the pure fingerprint unit suite is only
 * written when this resolves, and fingerprint behaviour is otherwise proven via the
 * integration soft-duplicate cases. Add the path/export here if the implementor exposes it
 * under a different name/location.
 */
export function getComputeFingerprint(): ((input: FingerprintInput) => string) | undefined {
  return findExportAcross(
    [
      `${SRC}/modules/idempotency/fingerprint`,
      // PR #16 layout: fingerprint moves under `service/` (so the interface can import
      // FingerprintInput without an impl edge) — try both `service/` and `service/interfaces/`.
      `${SRC}/modules/idempotency/service/fingerprint`,
      `${SRC}/modules/idempotency/service/interfaces/fingerprint`,
      `${SRC}/modules/idempotency/idempotency.fingerprint`,
      `${SRC}/modules/idempotency/idempotency.service`,
      `${SRC}/modules/idempotency`,
      `${SRC}/common/idempotency/fingerprint`,
      `${SRC}/modules/transfers/fingerprint`,
      `${SRC}/common/fingerprint`,
    ],
    ['computeFingerprint', 'requestFingerprint', 'fingerprintOf', 'computeRequestFingerprint'],
  );
}

export interface ResolvedDomainErrors {
  InsufficientFundsError?: any;
  AccountFrozenError?: any;
  CurrencyMismatchError?: any;
  AccountNotFoundError?: any;
  InvalidPostingCommandError?: any;
  IdempotencyKeyReuseError?: any;
  SuspectedDuplicateError?: any;
  // Transfers/OTP domain errors added by Step-4b (internal transfers end-to-end). Best-effort
  // like the rest of this map — undefined until the implementor exports them. The DomainError→HTTP
  // filter maps by `.code`, so the filter proof (all-exceptions.filter.spec) can fall back to a
  // synthetic DomainError subclass carrying the code when a concrete class is not yet resolvable;
  // the money-safety proofs gate on OBSERVABLE STATE + status codes, classifying by class/code
  // only as a secondary signal.
  InvalidTransferError?: any;
  TransferNotFoundError?: any;
  /** The transfers SERVICE-level pre-check error (TransfersService.confirmTransfer). */
  TransferNotPendingError?: any;
  /** The posting REDUCER-level guarded-transition error (PostingService.postPendingInTx).
   *  Distinct class from TransferNotPendingError, but shares the `TRANSFER_NOT_PENDING` code. */
  TransactionNotPendingError?: any;
  InvalidOtpError?: any;
  OtpLockedOutError?: any;
  OtpAlreadyActiveError?: any;
  /** Confirmation-of-payee follow-up: initiate was called without a valid confirmation token
   *  bound to the caller AND to THIS destination (code `DESTINATION_NOT_CONFIRMED` → 409). */
  DestinationNotConfirmedError?: any;
  /** Pending-lifecycle follow-up: a PENDING transfer whose 2-minute `expires_at` lapsed —
   *  confirm/read lazily transitions it to EXPIRED and confirm rejects WITHOUT consuming the OTP
   *  (code `TRANSFER_EXPIRED` → 410). Distinct class from `TransferNotPendingError`. */
  TransferExpiredError?: any;
  /** Pending-lifecycle follow-up: a same-initiator concurrent initiate collided on the
   *  single-pending unique index (code `PENDING_TRANSFER_CONFLICT` → 409). */
  PendingTransferConflictError?: any;
}

/**
 * BEST-EFFORT resolution of the reducer's framework-agnostic domain error classes so a
 * rejection can be classified by `instanceof`. UNLIKE the other resolvers this one does NOT
 * throw when a class is absent: the money-safety proofs gate on OBSERVABLE STATE (the tx
 * rolled back — no ledger/tx/outbox rows, balances unchanged), never on the error type
 * alone, and the error *kind* is a secondary signal the suite falls back to matching by
 * `code`/message when a class is not exported here. If the implementor exports these under
 * the spec-named identifiers, add their module path below and classification becomes exact.
 */
export function getDomainErrors(): ResolvedDomainErrors {
  const candidates = [
    `${SRC}/modules/ledger/posting.errors`,
    `${SRC}/modules/ledger/domain.errors`,
    `${SRC}/modules/ledger/errors`,
    `${SRC}/modules/posting/posting.errors`,
    // PR #16 layout: domain error files move to `service/errors.ts` per module.
    `${SRC}/modules/posting/service/errors`,
    `${SRC}/modules/idempotency/service/errors`,
    `${SRC}/modules/idempotency/idempotency.errors`,
    `${SRC}/modules/idempotency/errors`,
    `${SRC}/common/idempotency/idempotency.errors`,
    `${SRC}/modules/transfers/idempotency.errors`,
    `${SRC}/modules/transfers/transfers.errors`,
    `${SRC}/modules/transfers/errors`,
    // Step-4b: the transfers feature owns its domain errors under `service/errors`.
    `${SRC}/modules/transfers/service/errors`,
    `${SRC}/modules/otp/service/errors`,
    `${SRC}/modules/otp/otp.errors`,
    `${SRC}/modules/otp/errors`,
    `${SRC}/common/errors/domain.errors`,
    `${SRC}/common/errors/domain-errors`,
    `${SRC}/common/errors/domain.error`,
    `${SRC}/domain/errors`,
    `${SRC}/modules/ledger`,
    `${SRC}/modules/posting`,
    `${SRC}/modules/idempotency`,
    `${SRC}/modules/transfers`,
  ];
  return {
    InsufficientFundsError: findExportAcross(candidates, [
      'InsufficientFundsError',
      'InsufficientFunds',
    ]),
    AccountFrozenError: findExportAcross(candidates, ['AccountFrozenError', 'AccountFrozen']),
    CurrencyMismatchError: findExportAcross(candidates, [
      'CurrencyMismatchError',
      'CurrencyMismatch',
    ]),
    AccountNotFoundError: findExportAcross(candidates, ['AccountNotFoundError', 'AccountNotFound']),
    InvalidPostingCommandError: findExportAcross(candidates, [
      'InvalidPostingCommandError',
      'InvalidPostingCommand',
      'InvalidCommandError',
    ]),
    IdempotencyKeyReuseError: findExportAcross(candidates, [
      'IdempotencyKeyReuseError',
      'IdempotencyKeyReusedError',
      'IdempotencyKeyReused',
      'KeyReuseError',
    ]),
    SuspectedDuplicateError: findExportAcross(candidates, [
      'SuspectedDuplicateError',
      'SuspectedDuplicate',
      'DuplicateSuspectedError',
    ]),
    // Step-4b transfers/OTP domain errors (best-effort).
    InvalidTransferError: findExportAcross(candidates, ['InvalidTransferError', 'InvalidTransfer']),
    TransferNotFoundError: findExportAcross(candidates, [
      'TransferNotFoundError',
      'TransferNotFound',
      'TransactionNotFoundError',
    ]),
    // The transfers service pre-check throws `TransferNotPendingError` (transfers/service/errors);
    // the posting reducer's guarded transition throws `TransactionNotPendingError`
    // (posting/service/errors). Two distinct classes sharing the `TRANSFER_NOT_PENDING` code —
    // resolved under SEPARATE keys so an `instanceof` proof targets the right one (posting's
    // module is scanned before transfers', so the names must not overlap or they'd collide).
    TransferNotPendingError: findExportAcross(candidates, [
      'TransferNotPendingError',
      'TransferNotPending',
    ]),
    TransactionNotPendingError: findExportAcross(candidates, ['TransactionNotPendingError']),
    InvalidOtpError: findExportAcross(candidates, [
      'InvalidOtpError',
      'InvalidOtp',
      'OtpInvalidError',
    ]),
    OtpLockedOutError: findExportAcross(candidates, [
      'OtpLockedOutError',
      'OtpLockedOut',
      'OtpLockoutError',
    ]),
    OtpAlreadyActiveError: findExportAcross(candidates, [
      'OtpAlreadyActiveError',
      'OtpActiveError',
      'OtpAlreadyActive',
    ]),
    // Confirmation-of-payee follow-up: the resolve→confirm→initiate gate error.
    DestinationNotConfirmedError: findExportAcross(candidates, [
      'DestinationNotConfirmedError',
      'DestinationNotConfirmed',
      'PayeeNotConfirmedError',
    ]),
    // Pending-lifecycle follow-up: the two new transfers/service errors. Distinct classes (like
    // the TransferNotPendingError / TransactionNotPendingError split), resolved under their own
    // keys so an `instanceof` proof targets the right one.
    TransferExpiredError: findExportAcross(candidates, ['TransferExpiredError', 'TransferExpired']),
    PendingTransferConflictError: findExportAcross(candidates, [
      'PendingTransferConflictError',
      'PendingTransferConflict',
    ]),
  };
}

// ---- OTP module (spec 04 "OTP module", Step-4a: Redis-backed, service-only) -------------
// The Redis-backed user-scoped OTP capability. Resolved through the same single-seam
// convention as everything else: the running instance by TOKEN through the app graph
// (integration), and the CLASS for the pure unit spec that `new`s it with a fake Redis.

const OTP_SERVICE_IMPL_CANDIDATES = [
  `${SRC}/modules/otp/service/impl/otp.service`,
  `${SRC}/modules/otp/impl/otp.service`,
  `${SRC}/modules/otp/otp.service`,
  `${SRC}/modules/otp/service/otp.service`,
];

/** `OTP_SERVICE` — the DI token the OtpModule binds the OtpService to (resolved by token,
 *  never by class, post interface/impl split). Reuses the shared service-token probe. */
export function getOtpServiceToken(): symbol {
  return resolveServiceToken('OTP_SERVICE', 'otp');
}

/**
 * The `OtpService` CLASS, for the pure unit spec: `new OtpService(fakeRedis, config)` (DI
 * decorators are inert under plain instantiation; the 2nd arg is the AppConfig carrying
 * `otp.hashSecret`). Scanned with `findExportAcross`; if the implementor moves/renames it,
 * add the path/export HERE — the single coordination point.
 */
export function getOtpService(): any {
  const cls = findExportAcross(OTP_SERVICE_IMPL_CANDIDATES, ['OtpService']);
  if (cls === undefined) {
    throw new Error(
      `[test harness] Could not resolve the OtpService class. If the implementor named/placed ` +
        `it differently, add the path/export to tests/support/harness.ts:getOtpService — the ` +
        `single coordination point.`,
    );
  }
  return cls;
}

/** `REDIS_CLIENT` — the DI token the RedisModule binds the shared ioredis client to (the
 *  integration suite resolves it from the app graph for real assertions/cleanup). */
export function getRedisClientToken(): symbol {
  return resolveOrThrow(
    'the REDIS_CLIENT DI token',
    [
      `${SRC}/redis/redis.tokens`,
      `${SRC}/redis/redis.module`,
      `${SRC}/redis`,
      `${SRC}/common/redis/redis.tokens`,
    ],
    ['REDIS_CLIENT'],
  );
}

/**
 * BEST-EFFORT resolution of the OTP tuning constants (`OTP_CODE_LENGTH` = 6, `OTP_TTL_SECONDS`
 * = 300, `OTP_MAX_ATTEMPTS` = 3 — the typo-tolerance allowance before lockout) exported from
 * the impl. Does NOT throw when absent: the code-length / ttl assertions fall back to structural
 * bounds (`code.length >= 4`, `ttlSeconds > 0`), and the attempt-ladder proofs fall back to a
 * max of 3, when a constant is not exported here.
 */
export function getOtpConstants(): {
  OTP_CODE_LENGTH?: number;
  OTP_TTL_SECONDS?: number;
  OTP_MAX_ATTEMPTS?: number;
} {
  const candidates = [
    ...OTP_SERVICE_IMPL_CANDIDATES,
    `${SRC}/modules/otp/otp.constants`,
    `${SRC}/modules/otp/service/otp.constants`,
    `${SRC}/modules/otp/service/interfaces/otp.service.interface`,
  ];
  return {
    OTP_CODE_LENGTH: findExportAcross(candidates, ['OTP_CODE_LENGTH']),
    OTP_TTL_SECONDS: findExportAcross(candidates, ['OTP_TTL_SECONDS']),
    OTP_MAX_ATTEMPTS: findExportAcross(candidates, ['OTP_MAX_ATTEMPTS', 'OTP_MAX_WRONG_ATTEMPTS']),
  };
}

/**
 * BEST-EFFORT resolution of the `OtpAlreadyActiveError` domain error class (code
 * `OTP_ALREADY_ACTIVE`) so the singleton-gate rejection can be classified by `instanceof`.
 * Does NOT throw when absent — the proofs gate on the stable `.code`, with the class as a
 * secondary (exact) signal when it is exported.
 */
export function getOtpAlreadyActiveError(): any | undefined {
  return findExportAcross(
    [
      `${SRC}/modules/otp/service/errors`,
      `${SRC}/modules/otp/otp.errors`,
      `${SRC}/modules/otp/errors`,
      ...OTP_SERVICE_IMPL_CANDIDATES,
      `${SRC}/modules/otp`,
    ],
    ['OtpAlreadyActiveError', 'OtpActiveError', 'OtpAlreadyActive'],
  );
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

// ---- Transfers module (spec 04 Transfers, Step-4b: internal transfers end-to-end) ---------
// Resolved through the same single-seam convention as everything else: the running instance BY
// TOKEN through the app graph (integration), and the CLASS for the pure unit spec that drives it
// with mocked deps.

/** `TRANSFERS_SERVICE` — the DI token the TransfersModule binds the TransfersService to (resolved
 *  by token, never by class, per the interface/impl split). Reuses the shared service-token probe. */
export function getTransfersServiceToken(): symbol {
  return resolveServiceToken('TRANSFERS_SERVICE', 'transfers');
}

/** `TRANSACTION_REPOSITORY` — the DI token the persistence layer binds the transaction repo to.
 *  Reuses the multi-path repo-token resolver so the pending-lifecycle suites can drive the new
 *  guarded transitions (`insertPendingInTx`, `expireIfOverdue`, `transitionToCancelled`, …). */
export function getTransactionRepositoryToken(): symbol {
  return getRepositoryToken('TRANSACTION_REPOSITORY', 'transaction');
}

/**
 * The `TransactionStatus` enum (native-Postgres-enum mirror) — including the new terminal
 * `EXPIRED` / `CANCELLED` labels — so a suite can assert the lifecycle status of a transfer row
 * without hard-coding the string values. Resolved from the entities barrel; the single
 * coordination point if the implementor moves it.
 */
export function getTransactionStatus(): Record<string, string> {
  return resolveOrThrow(
    'the TransactionStatus enum',
    [`${SRC}/database/entities/enums`],
    ['TransactionStatus'],
  );
}

/**
 * The `TransfersService` CLASS, for the pure unit spec (driven through a Nest TestingModule so the
 * injection is order-independent — see tests/unit/transfers.service.spec.ts). Scanned with
 * `findExportAcross`; if the implementor moves/renames it, add the path/export HERE — the single
 * coordination point.
 */
export function getTransfersService(): any {
  const cls = findExportAcross(
    [
      `${SRC}/modules/transfers/service/impl/transfers.service`,
      `${SRC}/modules/transfers/impl/transfers.service`,
      `${SRC}/modules/transfers/transfers.service`,
      `${SRC}/modules/transfers/service/transfers.service`,
    ],
    ['TransfersService'],
  );
  if (cls === undefined) {
    throw new Error(
      `[test harness] Could not resolve the TransfersService class. If the implementor named/placed ` +
        `it differently, add the path/export to tests/support/harness.ts:getTransfersService — the ` +
        `single coordination point.`,
    );
  }
  return cls;
}

export interface TransferSerializers {
  serializeTransfer?: (transfer: any) => any;
  serializePendingAuthorization?: (transfer: any) => any;
}

/**
 * BEST-EFFORT resolution of the controller-boundary transfer serializers (services return
 * entities; controllers serialize to DTOs via explicit whitelists). Returns `undefined` members
 * when a serializer is not exported — the e2e proves the wire DTO shape / anti-leak over HTTP
 * regardless, so this is only used opportunistically. Add the path/export here if the implementor
 * names/locates them differently.
 */
export function getTransferSerializers(): TransferSerializers {
  const candidates = [
    `${SRC}/modules/transfers/api/serializers/transfers.serializer`,
    `${SRC}/modules/transfers/api/serializers/transfer.serializer`,
    `${SRC}/modules/transfers/api/serializers`,
    `${SRC}/modules/transfers/transfers.serializer`,
    `${SRC}/modules/transfers/serializers`,
  ];
  return {
    serializeTransfer: findExportAcross(candidates, [
      'serializeTransfer',
      'toTransferDto',
      'transferToDto',
    ]),
    serializePendingAuthorization: findExportAcross(candidates, [
      'serializePendingAuthorization',
      'toPendingAuthorizationDto',
      'serializePendingAuth',
      'pendingAuthorizationToDto',
    ]),
  };
}

/**
 * The `ZodValidationPipe` CLASS — a `PipeTransform` constructed with a Zod schema
 * (`new ZodValidationPipe(schema)`) whose `transform(value, metadata)` returns the parsed value
 * on success and throws a `BadRequestException` (HTTP 400) on a schema violation, with a safe
 * (non-leaky) message. Scanned with `findExportAcross`; if the implementor names/places it
 * differently, add the path/export HERE — the single coordination point.
 */
export function getZodValidationPipe(): any {
  const cls = findExportAcross(
    [
      `${SRC}/common/pipes/zod-validation.pipe`,
      `${SRC}/common/pipes/zod.pipe`,
      `${SRC}/common/validation/zod-validation.pipe`,
      `${SRC}/common/validation/zod.pipe`,
      `${SRC}/common/zod/zod-validation.pipe`,
      `${SRC}/common/pipes/zod-validation`,
      `${SRC}/modules/transfers/api/zod-validation.pipe`,
    ],
    ['ZodValidationPipe'],
  );
  if (cls === undefined) {
    throw new Error(
      `[test harness] Could not resolve the ZodValidationPipe class. If the implementor named/placed ` +
        `it differently, add the path/export to tests/support/harness.ts:getZodValidationPipe — the ` +
        `single coordination point.`,
    );
  }
  return cls;
}

/**
 * BEST-EFFORT resolution of `runInTransactionWithRetry(dataSource, fn, options?)` — the single
 * seam every money-mutating operation opens its DB transaction through (the posting reducer and
 * the idempotency wrapper). Returned so the transfers integration suite can drive the reducer's
 * confirm-time `postPendingInTx` seam through the SAME transaction wrapper production uses
 * (`confirmTransfer` calls it exactly this way). Does NOT throw when absent — the caller falls
 * back to opening a QueryRunner transaction directly, so a rename/move never turns the money-once
 * proof into a false pass. If the implementor moves/renames it, add the path/export here.
 */
export function getRunInTransactionWithRetry():
  | (<T>(dataSource: any, fn: (queryRunner: any) => Promise<T>, options?: any) => Promise<T>)
  | undefined {
  return findExportAcross(
    [
      `${SRC}/common/db/run-in-transaction`,
      `${SRC}/common/db/run-in-transaction-with-retry`,
      `${SRC}/common/database/run-in-transaction`,
      `${SRC}/common/db`,
    ],
    ['runInTransactionWithRetry', 'runInTransaction'],
  );
}

/**
 * The abstract `DomainError` base class (every domain error extends it and carries a stable
 * `.code`). Returned so the filter spec can build a synthetic subclass for a code whose concrete
 * class is not yet resolvable, and so a rejection can be classified by `instanceof DomainError`.
 */
export function getDomainErrorBase(): any {
  return resolveOrThrow(
    'the DomainError base class',
    [`${SRC}/common/errors/domain-error`, `${SRC}/common/errors/domain.error`],
    ['DomainError'],
  );
}

// ---- Confirmation-of-payee follow-up (spec 04, step 4b follow-up) -------------------------
// A `customer` representation, human 10-digit account numbers, and the resolve→confirm→initiate
// gate. Resolved through the same single-seam convention: repo tokens BY name, pure helpers
// BEST-EFFORT (undefined when absent, so a spec can honest-SKIP or fall back rather than crash
// the whole file at import time).

/** `CUSTOMER_REPOSITORY` — the DI token the persistence layer binds the customer repo to.
 *  Reuses the multi-path repo-token resolver (probes `interfaces/<base>.repository.interface`). */
export function getCustomerRepositoryToken(): symbol {
  return getRepositoryToken('CUSTOMER_REPOSITORY', 'customer');
}

/**
 * BEST-EFFORT resolution of the PURE `maskName(name)` privacy helper (the payee-name mask:
 * each whitespace-split token → first 3 chars + exactly two asterisks). Returns `undefined`
 * when no such export exists — the pure mask-name unit suite is skipped with a clear message
 * when this is unresolved (prefer it resolves). Add the path/export here if the implementor
 * names/locates it differently — the single coordination point.
 */
export function getMaskName(): ((name: string) => string) | undefined {
  return findExportAcross(
    [
      `${SRC}/modules/transfers/service/mask-name`,
      `${SRC}/modules/transfers/service/impl/mask-name`,
      `${SRC}/modules/transfers/service/mask`,
      `${SRC}/modules/transfers/service/impl/mask`,
      `${SRC}/modules/transfers/mask-name`,
      `${SRC}/common/text/mask-name`,
      `${SRC}/common/pii/mask-name`,
      `${SRC}/common/mask-name`,
    ],
    ['maskName', 'maskHolderName', 'maskDisplayName', 'maskPayeeName'],
  );
}

/**
 * BEST-EFFORT resolution of the PURE `generateAccountNumber()` helper (a 10-digit numeric
 * string). Returns `undefined` when absent; a test that mints numbers falls back to a local
 * 10-digit generator when this is unresolved. Add the path/export here if the implementor
 * names/locates it differently — the single coordination point.
 */
export function getGenerateAccountNumber(): (() => string) | undefined {
  return findExportAcross(
    [
      `${SRC}/modules/accounts/service/account-number`,
      `${SRC}/modules/accounts/service/impl/account-number`,
      `${SRC}/modules/accounts/service/generate-account-number`,
      `${SRC}/modules/accounts/service/impl/generate-account-number`,
      `${SRC}/modules/accounts/account-number`,
      `${SRC}/common/accounts/account-number`,
      `${SRC}/common/account-number`,
    ],
    ['generateAccountNumber', 'newAccountNumber', 'makeAccountNumber'],
  );
}
