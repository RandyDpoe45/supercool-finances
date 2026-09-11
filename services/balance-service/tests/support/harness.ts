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

import { createHmac } from 'crypto';
import * as net from 'net';
import { completeRawEnv } from './env.fixture';

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
  /** Limits (spec 04 step 7): a customer-initiated outbound movement would breach the owner's
   *  per-transaction / daily / monthly cap, checked under the account's `FOR UPDATE` lock BEFORE
   *  any balance mutation (code `LIMIT_EXCEEDED` → 422). Owned by the posting reducer feature
   *  (posting/service/errors), already in the candidates below. */
  LimitExceededError?: any;
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
  /** External-payee enrollment (spec 04 step 5): a duplicate `(owner_id, rail, destination_ref)`
   *  collided on `uq_payee` (code `PAYEE_ALREADY_ENROLLED` → 409). */
  PayeeAlreadyEnrolledError?: any;
  /** External outbound (spec 04 step 5b): the addressed payee is missing or not owned by the caller
   *  (code `PAYEE_NOT_FOUND` → 404, anti-IDOR — indistinguishable from a genuine miss). */
  PayeeNotFoundError?: any;
  /** External outbound (spec 04 step 5b): the payee is still inside its cooling-off window
   *  (`now() < cooling_off_until`, DB clock) (code `PAYEE_IN_COOLING_OFF` → 409). */
  PayeeInCoolingOffError?: any;
  /** External rail webhooks (spec 04 step 5c): the settlement callback referenced a transaction id
   *  that does not exist (code `SETTLEMENT_TARGET_NOT_FOUND` → 404). */
  SettlementTargetNotFoundError?: any;
  /** External rail webhooks (step 5c): the callback conflicts with the transfer's current money
   *  state — wrong type, or a contradictory outcome (success for a reversed transfer / failure for
   *  a reconciled success) (code `INVALID_SETTLEMENT_STATE` → 409). */
  InvalidSettlementStateError?: any;
  /** External rail webhooks (step 5c): the inbound credit could not resolve its destination to a
   *  customer account by account number (code `INBOUND_DESTINATION_NOT_FOUND` → 404). */
  InboundDestinationNotFoundError?: any;
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
    // Step-5: the payees feature owns its domain errors under `service/errors`.
    `${SRC}/modules/payees/service/errors`,
    // Step-5c: the rails feature owns its domain errors under `service/errors`.
    `${SRC}/modules/rails/service/errors`,
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
    // Step-7 limits enforcement (best-effort). Owned by the posting reducer (posting/service/errors),
    // already in `candidates`.
    LimitExceededError: findExportAcross(candidates, ['LimitExceededError', 'LimitExceeded']),
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
    // Step-5 external-payee enrollment (best-effort).
    PayeeAlreadyEnrolledError: findExportAcross(candidates, [
      'PayeeAlreadyEnrolledError',
      'PayeeAlreadyEnrolled',
      'DuplicatePayeeError',
    ]),
    // Step-5b external outbound (best-effort). Owned by the transfers feature
    // (transfers/service/errors), already in `candidates`.
    PayeeNotFoundError: findExportAcross(candidates, ['PayeeNotFoundError', 'PayeeNotFound']),
    PayeeInCoolingOffError: findExportAcross(candidates, [
      'PayeeInCoolingOffError',
      'PayeeInCoolingOff',
      'PayeeCoolingOffError',
    ]),
    // Step-5c external rail webhooks (best-effort). Owned by the rails feature
    // (rails/service/errors), already in `candidates`.
    SettlementTargetNotFoundError: findExportAcross(candidates, [
      'SettlementTargetNotFoundError',
      'SettlementTargetNotFound',
    ]),
    InvalidSettlementStateError: findExportAcross(candidates, [
      'InvalidSettlementStateError',
      'InvalidSettlementState',
    ]),
    InboundDestinationNotFoundError: findExportAcross(candidates, [
      'InboundDestinationNotFoundError',
      'InboundDestinationNotFound',
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

/** `USER_LIMITS_REPOSITORY` — the DI token the persistence layer binds the user-limits repo to
 *  (spec 04 step 7). Reuses the multi-path repo-token resolver so a limits suite can drive
 *  `resolveInTx(qr, ownerId, currency)` directly or seed rows via `tests/support/pg.ts:insertUserLimits`. */
export function getUserLimitsRepositoryToken(): symbol {
  return getRepositoryToken('USER_LIMITS_REPOSITORY', 'user-limits');
}

/** `HOLD_REPOSITORY` — the DI token the persistence layer binds the hold (reservation-ledger) repo
 *  to. Reuses the multi-path repo-token resolver so the holds/outbound suites can drive the guarded
 *  hold transitions (`insertInTx`, `findByTransactionInTx`, `settleInTx`, `releaseInTx`) directly,
 *  or seed rows via `tests/support/pg.ts:insertHold`. */
export function getHoldRepositoryToken(): symbol {
  return getRepositoryToken('HOLD_REPOSITORY', 'hold');
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
 * The `ApprovalStatus` enum (native-Postgres-enum mirror: `PENDING`/`APPROVED`/`REJECTED`/`EXECUTED`)
 * — so the `/admin/approvals` read suites can assert the DEFAULT status the service applies (PENDING,
 * the checker's queue) and a pass-through status without hard-coding string labels. Resolved from the
 * entities barrel; the single coordination point if the implementor moves it.
 */
export function getApprovalStatus(): Record<string, string> {
  return resolveOrThrow(
    'the ApprovalStatus enum',
    [`${SRC}/database/entities/enums`],
    ['ApprovalStatus'],
  );
}

/**
 * The `UserLimitsScope` enum (native-Postgres-enum mirror: `global`/`customer`) — so the
 * `/admin/limits` read suites can assert the service maps the wire `scope` string to the ENUM member
 * before delegating to the repo, without hard-coding the label. Resolved from the entities barrel; the
 * single coordination point if the implementor moves it.
 */
export function getUserLimitsScope(): Record<string, string> {
  return resolveOrThrow(
    'the UserLimitsScope enum',
    [`${SRC}/database/entities/enums`],
    ['UserLimitsScope'],
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

/**
 * The PURE confirm-time failure-classification predicate `isBusinessFailure(error) => boolean` —
 * the money-safety gate deciding which confirm-time errors become a PERSISTED terminal FAILED
 * transaction (+ a `transaction.failed` event) vs. a validation/structural error that propagates
 * WITHOUT a FAILED row. Classifies by `instanceof DomainError` AND a code allowlist. Resolved as a
 * REQUIRED export (the SUT of its unit spec) — this is the single coordination point if the
 * implementor moves/renames it.
 */
export function getIsBusinessFailure(): (error: unknown) => boolean {
  return resolveOrThrow(
    'the isBusinessFailure classification predicate',
    [
      `${SRC}/common/errors/failure-classification`,
      `${SRC}/common/errors/failure-classification.util`,
      `${SRC}/common/errors/confirm-failure-classification`,
    ],
    ['isBusinessFailure'],
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

// ---- Payees module (spec 04 "External payees", Step-5: enrollment) ------------------------
// Resolved through the same single-seam convention as everything else: the running instance BY
// TOKEN through the app graph (integration), and the CLASS for the pure unit spec. The
// `PayeeAlreadyEnrolledError` domain class is resolved via `getDomainErrors()` above.

/** `PAYEES_SERVICE` — the DI token the PayeesModule binds the PayeesService to (resolved by token,
 *  never by class, per the interface/impl split). Reuses the shared service-token probe. */
export function getPayeesServiceToken(): symbol {
  return resolveServiceToken('PAYEES_SERVICE', 'payees');
}

/** `EXTERNAL_PAYEE_REPOSITORY` — the DI token the persistence layer binds the external-payee repo
 *  to. Reuses the multi-path repo-token resolver so a suite can drive `createEnrollment` /
 *  `findByOwner` directly (or seed rows via `tests/support/pg.ts:insertExternalPayee`). */
export function getExternalPayeeRepositoryToken(): symbol {
  return getRepositoryToken('EXTERNAL_PAYEE_REPOSITORY', 'external-payee');
}

/**
 * The `PayeesService` CLASS, for the pure unit spec (driven through a Nest TestingModule so the
 * injection is order-independent). Scanned with `findExportAcross`; if the implementor moves/renames
 * it, add the path/export HERE — the single coordination point.
 */
export function getPayeesService(): any {
  const cls = findExportAcross(
    [
      `${SRC}/modules/payees/service/impl/payees.service`,
      `${SRC}/modules/payees/impl/payees.service`,
      `${SRC}/modules/payees/payees.service`,
      `${SRC}/modules/payees/service/payees.service`,
    ],
    ['PayeesService'],
  );
  if (cls === undefined) {
    throw new Error(
      `[test harness] Could not resolve the PayeesService class. If the implementor named/placed ` +
        `it differently, add the path/export to tests/support/harness.ts:getPayeesService — the ` +
        `single coordination point.`,
    );
  }
  return cls;
}

/**
 * The controller-boundary payee serializer `serializePayee(entity) => PayeeDto` (an explicit
 * whitelist to `{ id, displayName, destinationRef, coolingOffUntil, usable, createdAt }` — NEVER
 * `ownerId` / `rail` / `status` / `activatedAt`). Scanned with `findExportAcross`; if the
 * implementor names/locates it differently, add the path/export here — the single coordination
 * point.
 */
export function getPayeeSerializer(): (payee: any) => any {
  const fn = findExportAcross(
    [
      `${SRC}/modules/payees/api/serializers/payees.serializer`,
      `${SRC}/modules/payees/api/serializers/payee.serializer`,
      `${SRC}/modules/payees/api/serializers`,
      `${SRC}/modules/payees/serializers`,
    ],
    ['serializePayee', 'toPayeeDto', 'payeeToDto'],
  );
  if (fn === undefined) {
    throw new Error(
      `[test harness] Could not resolve the payee serializer (serializePayee). If the implementor ` +
        `put it elsewhere, add the path/export to tests/support/harness.ts:getPayeeSerializer — the ` +
        `single coordination point.`,
    );
  }
  return fn as (payee: any) => any;
}

/**
 * The constant outbound rail id (`OUTBOUND_RAIL` = 'rail-outbound') — all external outbound clears
 * through this single rail; enrollment stores it on `external_payee.rail`. Returned so a suite can
 * assert the seeded rail / compute the `uq_payee` uniqueness key without hard-coding the literal.
 * The single coordination point if the implementor moves/renames it.
 */
export function getOutboundRail(): string {
  return resolveOrThrow(
    'the constant outbound rail id (OUTBOUND_RAIL)',
    [`${SRC}/common/rails/outbound-rail`, `${SRC}/common/rails`],
    ['OUTBOUND_RAIL'],
  );
}

/**
 * The external-payee cooling-off window in SECONDS, read from the RESOLVED `AppConfig`. Pass the
 * config resolved from the app graph (`app.get(getAppConfigToken())`); called bare, it falls back
 * to building the config from the current environment (`loadConfig()`), which works in the
 * env-configured integration run. This is the single coordination point for the config PATH: if
 * the implementor names the field differently, edit here. The value lets a suite compute the
 * expected `cooling_off_until` (`enrolledAt + coolingOffSeconds`).
 */
export function getPayeeCoolingOffSeconds(config?: any): number {
  const resolved = config ?? buildConfigFromEnv();
  const seconds = resolved?.payees?.coolingOffSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    throw new Error(
      `[test harness] Could not read payees.coolingOffSeconds from the resolved AppConfig. Pass ` +
        `the config resolved from the app graph (app.get(getAppConfigToken())); if the implementor ` +
        `names the field differently, update tests/support/harness.ts:getPayeeCoolingOffSeconds — ` +
        `the single coordination point.`,
    );
  }
  return seconds;
}

/** Resolve + call the production `loadConfig()` (env → typed `AppConfig`), so a bare
 * `getPayeeCoolingOffSeconds()` reads the SAME config the app builds. Throws the config loader's
 * own (env-validation) error if the environment is incomplete. */
function buildConfigFromEnv(): any {
  const loadConfig = resolveOrThrow(
    'the config loader (loadConfig)',
    [`${SRC}/config/configuration`],
    ['loadConfig'],
  ) as () => any;
  return loadConfig();
}

// ---- Rails module (spec 04 "Mocked external rails", step 5c: `/external` webhooks) --------
// The outbound settlement callback + inbound credit behind the `/external` surface (a distinct
// HMAC-signature trust domain). Resolved through the same single-seam convention: the running
// instance BY TOKEN through the app graph. The domain error classes are resolved via
// `getDomainErrors()` above. The booted `AppModule` already wires the `/external` surface
// (ExternalModule) and its global `RailSignatureGuard` — nothing extra to import here;
// `getAppModule()` yields them. NOTE: to exercise the guard over HTTP, the e2e must boot the app
// with `{ rawBody: true }` (`moduleRef.createNestApplication({ rawBody: true })`) so `req.rawBody`
// is captured — the same option production sets in `main.ts` — and sign with `railSignatureHeader`.

/** `RAILS_SERVICE` — the DI token the RailsModule binds the RailsService to (resolved by token,
 *  never by class, per the interface/impl split). Reuses the shared service-token probe. */
export function getRailsServiceToken(): symbol {
  return resolveServiceToken('RAILS_SERVICE', 'rails');
}

/**
 * The `RailsService` CLASS, for the pure unit spec (driven through a Nest TestingModule so the
 * injection is order-independent, like the transfers/payees unit specs). Scanned with
 * `findExportAcross`; if the implementor moves/renames it, add the path/export HERE — the single
 * coordination point.
 */
export function getRailsService(): any {
  const cls = findExportAcross(
    [
      `${SRC}/modules/rails/service/impl/rails.service`,
      `${SRC}/modules/rails/impl/rails.service`,
      `${SRC}/modules/rails/rails.service`,
      `${SRC}/modules/rails/service/rails.service`,
    ],
    ['RailsService'],
  );
  if (cls === undefined) {
    throw new Error(
      `[test harness] Could not resolve the RailsService class. If the implementor named/placed ` +
        `it differently, add the path/export to tests/support/harness.ts:getRailsService — the ` +
        `single coordination point.`,
    );
  }
  return cls;
}

/**
 * The `/external` rail-webhook HMAC signing secret the booted app verifies `X-Rail-Signature`
 * against — the `RAILS_WEBHOOK_SIGNING_SECRET` fixture value (the SAME value the integration/e2e
 * boot injects into the environment via `completeRawEnv()`). Returned so an e2e can sign a valid
 * request (200) and prove 401 on a wrong secret. If a suite boots with a different secret it must
 * pass that value instead.
 */
export function getRailsWebhookSigningSecret(): string {
  return completeRawEnv().RAILS_WEBHOOK_SIGNING_SECRET as string;
}

/**
 * The canonical SENDER-SIDE signer for the `/external` rail webhooks — mirrors the
 * `RailSignatureGuard` verification exactly. Given the RAW request-body string (the exact bytes
 * the e2e will POST), it returns the `X-Rail-Signature` header value
 * `` `t=${t},v1=${hmacHex}` `` where `hmacHex = HMAC-SHA256(secret ?? fixture secret,
 * `${t ?? nowSeconds}.${rawBody}`)` (hex). Defaults: `t` = current unix seconds (inside the ±300s
 * replay window), `secret` = the fixture signing secret. Override `t` to prove the replay guard
 * (e.g. `t: nowSeconds - 400` → 401) and `secret` to prove a wrong-secret rejection (401). The
 * signed payload is `"<t>.<rawBody>"` — the SAME string the guard rebuilds from `req.rawBody`, so
 * the e2e MUST send `rawBody` verbatim as the request body (no re-stringify) for the bytes to match.
 */
export function railSignatureHeader(
  rawBody: string,
  opts: { secret?: string; t?: number } = {},
): string {
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const secret = opts.secret ?? getRailsWebhookSigningSecret();
  const hmacHex = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${hmacHex}`;
}

// ---- Relay module (spec 04 "Outbox + relay worker", step 6) -------------------------------
// The in-process poll loop that drains the transactional outbox to the Redis stream
// `events:transactions` (SELECT ... WHERE published_at IS NULL ORDER BY created_at FOR UPDATE
// SKIP LOCKED LIMIT n → XADD each → markPublished → commit; XADD BEFORE mark ⇒ at-least-once).
// Resolved through the same single-seam convention: the running instance BY TOKEN through the
// app graph (integration), and the CLASS for the pure unit spec that drives it with mocked deps.
// The stream is read back through the app's REDIS_CLIENT (getRedisClientToken above); the outbox
// rows are seeded/read via tests/support/pg.ts (insertOutboxRow / getOutboxRow).

/** `RELAY_SERVICE` — the DI token the RelayModule binds the RelayService to (resolved by token,
 *  never by class, per the interface/impl split). Reuses the shared service-token probe. The
 *  public seam is `drainOnce(): Promise<number>` (publishes one batch, returns rows published). */
export function getRelayServiceToken(): symbol {
  return resolveServiceToken('RELAY_SERVICE', 'relay');
}

/**
 * The `RelayService` CLASS, for the pure unit spec (driven through a Nest TestingModule so the
 * injection is order-independent, like the rails/transfers/payees unit specs). Scanned with
 * `findExportAcross`; if the implementor moves/renames it, add the path/export HERE — the single
 * coordination point. Returns `undefined` when the step-6 module is not yet built, so the unit
 * spec honest-SKIPs (loudly) rather than crashing the default `npm test` run.
 */
export function getRelayService(): any | undefined {
  return findExportAcross(
    [
      `${SRC}/modules/relay/service/impl/relay.service`,
      `${SRC}/modules/relay/impl/relay.service`,
      `${SRC}/modules/relay/relay.service`,
      `${SRC}/modules/relay/service/relay.service`,
    ],
    ['RelayService'],
  );
}

/** `OUTBOX_EVENT_REPOSITORY` — the DI token the persistence layer binds the outbox-event repo to
 *  (the relay's `pollUnpublished(queryRunner, limit)` / `markPublished(queryRunner, ids)` port).
 *  Reuses the multi-path repo-token resolver so the relay unit spec can mock it BY token and the
 *  integration suite can drive it directly if needed. */
export function getOutboxEventRepositoryToken(): symbol {
  return getRepositoryToken('OUTBOX_EVENT_REPOSITORY', 'outbox-event');
}

// ---- Admin ops (spec 04 "Admin ops (/admin)", step 8a: single-actor + audit foundation) -------
// The `/admin` single-actor surface (freeze/unfreeze, PUT /limits, GET /transactions, simulated
// inbound) + the audit foundation. Resolved through the same single-seam convention: services BY
// TOKEN through the app graph (integration), the CLASS for the pure unit specs, repo tokens BY name.
// Maker-checker (reversals / approvals) is step 8b and is intentionally NOT resolved here.

/** `AUDIT_SERVICE` — the DI token the AuditModule binds the IAuditService to (`recordInTx(qr, entry)`
 *  writes one append-only `audit_log` row in the CALLER's tx; `record(entry)` opens its own). Resolved
 *  by token, never by class, per the interface/impl split. Reuses the shared service-token probe. */
export function getAuditServiceToken(): symbol {
  return resolveServiceToken('AUDIT_SERVICE', 'audit');
}

/** `AUDIT_LOG_REPOSITORY` — the DI token the persistence layer binds the audit-log repo to (append-only;
 *  `insertInTx(qr, data)` writes one row inside the caller's tx). Reuses the multi-path repo-token
 *  resolver so a unit spec can mock it BY token, or seed/read rows via tests/support/pg.ts. */
export function getAuditLogRepositoryToken(): symbol {
  return getRepositoryToken('AUDIT_LOG_REPOSITORY', 'audit-log');
}

/** `LIMITS_SERVICE` — the DI token the LimitsModule binds the LimitsService to (`upsertLimits(actorId,
 *  input)` upserts the global baseline or a per-customer override, `ON CONFLICT (scope, owner_id)`, and
 *  audits `limits.change` with before/after). Resolved by token, never by class. */
export function getLimitsServiceToken(): symbol {
  return resolveServiceToken('LIMITS_SERVICE', 'limits');
}

/**
 * The `LimitsService` CLASS, for the pure unit spec (driven through a Nest TestingModule + useMocker
 * so injection is order-independent, like the transfers/rails unit specs). Scanned with
 * `findExportAcross`; if the implementor moves/renames it, add the path/export HERE — the single
 * coordination point.
 */
export function getLimitsService(): any {
  const cls = findExportAcross(
    [
      `${SRC}/modules/limits/service/impl/limits.service`,
      `${SRC}/modules/limits/impl/limits.service`,
      `${SRC}/modules/limits/limits.service`,
      `${SRC}/modules/limits/service/limits.service`,
    ],
    ['LimitsService'],
  );
  if (cls === undefined) {
    throw new Error(
      `[test harness] Could not resolve the LimitsService class. If the implementor named/placed it ` +
        `differently, add the path/export to tests/support/harness.ts:getLimitsService — the single ` +
        `coordination point.`,
    );
  }
  return cls;
}

// ---- Maker-checker + reversals (spec 04 "Admin ops (/admin)", step 8b) -------------------------
// The `/admin` maker-checker (four-eyes) reversal surface: a MAKER proposes a reversal
// (`ApprovalRequest` PENDING) and a DIFFERENT CHECKER approves (executes the reversal atomically) or
// rejects. Resolved through the same single-seam convention: the service BY TOKEN through the app
// graph (integration), the CLASS for the pure unit spec (best-effort — the module is authored in
// parallel), and the approval-request repo token BY name. The compensating movement is posted via
// POSTING_SERVICE (getPostingServiceToken above), the audit rows via AUDIT_SERVICE.

/** `APPROVAL_SERVICE` — the DI token the ApprovalsModule binds the IApprovalService to
 *  (`proposeReversal(actorId, transactionId, reason?)`, `approve(actorId, approvalId)`,
 *  `reject(actorId, approvalId)`). Resolved by token, never by class, per the interface/impl split.
 *  The feature module folder is `approvals` (plural) but the service files are `approval.service*`
 *  (singular), so the shared `resolveServiceToken` naming convention does not match — probe the real
 *  paths directly with `findExportAcross`. Throws with an actionable message if unresolved (callers in
 *  the parallel-development window wrap it defensively). */
export function getApprovalServiceToken(): symbol {
  const token = findExportAcross(
    [
      `${SRC}/modules/approvals/service/interfaces/approval.service.interface`,
      `${SRC}/modules/approvals/service/interfaces/approvals.service.interface`,
      `${SRC}/modules/approval/service/interfaces/approval.service.interface`,
      `${SRC}/modules/approvals/service/interfaces`,
      `${SRC}/modules/approvals`,
      `${SRC}/modules/approval`,
    ],
    ['APPROVAL_SERVICE', 'APPROVALS_SERVICE'],
  );
  if (token === undefined) {
    throw new Error(
      `[test harness] Could not resolve the APPROVAL_SERVICE DI token. If the implementor put it ` +
        `elsewhere, add the path/export to tests/support/harness.ts:getApprovalServiceToken — the ` +
        `single coordination point.`,
    );
  }
  return token as symbol;
}

/**
 * The `ApprovalService` CLASS, for the pure unit spec (driven through a Nest TestingModule so the
 * injection is order-independent, like the rails/transfers unit specs). Scanned with
 * `findExportAcross`; returns `undefined` when the step-8b module is not yet built, so the unit spec
 * honest-SKIPs (loudly) rather than crashing the default `npm test` run. If the implementor
 * names/places it differently, add the path/export HERE — the single coordination point.
 */
export function getApprovalService(): any | undefined {
  return findExportAcross(
    [
      `${SRC}/modules/approval/service/impl/approval.service`,
      `${SRC}/modules/approval/impl/approval.service`,
      `${SRC}/modules/approval/approval.service`,
      `${SRC}/modules/approval/service/approval.service`,
      `${SRC}/modules/approvals/service/impl/approvals.service`,
      `${SRC}/modules/approvals/service/impl/approval.service`,
      `${SRC}/modules/approvals/impl/approvals.service`,
      `${SRC}/modules/approvals/approvals.service`,
    ],
    ['ApprovalService', 'ApprovalsService'],
  );
}

/** `APPROVAL_REQUEST_REPOSITORY` — the DI token the persistence layer binds the approval-request repo
 *  to (maker-checker). The step-8b surface adds `findByIdInTx(qr, id)`,
 *  `findByTargetTransaction(txId)`, `transitionToExecutedInTx(qr, id, checkerId)` and
 *  `transitionToRejectedInTx(qr, id, checkerId)` to the port. Reuses the multi-path repo-token
 *  resolver so the unit spec can mock it BY token, or seed/read rows via tests/support/pg.ts. */
export function getApprovalRequestRepositoryToken(): symbol {
  return getRepositoryToken('APPROVAL_REQUEST_REPOSITORY', 'approval-request');
}

/**
 * BEST-EFFORT resolution of the maker-checker domain error classes (so a rejection can be classified
 * by `instanceof`). Like `getDomainErrors`, this does NOT throw when a class is absent — the proofs
 * gate on OBSERVABLE STATE (money moved / not, target status, approval status) and the stable `.code`,
 * with the class as a secondary (exact) signal. Codes: `TRANSACTION_NOT_REVERSIBLE`,
 * `REVERSAL_ALREADY_REQUESTED`, `APPROVAL_NOT_FOUND`, `APPROVAL_NOT_PENDING`, `SELF_APPROVAL_FORBIDDEN`.
 */
export function getApprovalErrors(): Record<string, any> {
  const candidates = [
    `${SRC}/modules/approval/service/errors`,
    `${SRC}/modules/approval/errors`,
    `${SRC}/modules/approval/approval.errors`,
    `${SRC}/modules/approvals/service/errors`,
    `${SRC}/modules/approvals/errors`,
    `${SRC}/common/errors/domain.errors`,
    `${SRC}/modules/approval`,
    `${SRC}/modules/approvals`,
  ];
  return {
    TransactionNotReversibleError: findExportAcross(candidates, [
      'TransactionNotReversibleError',
      'TransactionNotReversible',
      'NotReversibleError',
    ]),
    ReversalAlreadyRequestedError: findExportAcross(candidates, [
      'ReversalAlreadyRequestedError',
      'ReversalAlreadyRequested',
      'ApprovalAlreadyRequestedError',
    ]),
    ApprovalNotFoundError: findExportAcross(candidates, [
      'ApprovalNotFoundError',
      'ApprovalNotFound',
      'ApprovalRequestNotFoundError',
    ]),
    ApprovalNotPendingError: findExportAcross(candidates, [
      'ApprovalNotPendingError',
      'ApprovalNotPending',
    ]),
    SelfApprovalForbiddenError: findExportAcross(candidates, [
      'SelfApprovalForbiddenError',
      'SelfApprovalForbidden',
      'FourEyesViolationError',
    ]),
  };
}
