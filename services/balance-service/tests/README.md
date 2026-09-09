# Balance-service foundation — test suite (Spec 03, Step 3a)

Tests written **from the spec** (`specs/03-backend-foundation.md`) and the Step-3a
coordination contract, not from the implementor's code. Each test is designed to
**fail on a real defect**. Tests live here, segregated from `src/` (CLAUDE.md).

## What runs where

| File | DoD / contract item | Docker? | Runner |
|---|---|---|---|
| `unit/config.validation.spec.ts` | Config validation / **fail-fast** (typed values, defaults, required-var throws) | No | `npm test` |
| `e2e/identity-and-error-model.e2e-spec.ts` | **Gateway identity guard**, **admin role**, **service identity guard**, prefix self-scoping, **mixed-case prefix fails closed** (case-bypass regression), **error DTO** + code vocabulary + correlation id, **5xx genericization / no info leak** | No | `npm run test:e2e` |
| `e2e/health.e2e-spec.ts` | **`/internal/health`** liveness-vs-readiness body, **503 on readiness failure**, service-token **carve-out** | No | `npm run test:e2e` |
| `integration/health-and-migration.integration.spec.ts` | Real DB readiness UP + **sample migration ran on boot** in `balance` | **Yes** (honest-SKIP) | `npm test` |
| `integration/schema-constraints.integration.spec.ts` | Spec 04 **Step-1 schema is DB-enforced**: 5 tables + 5 native enum types exist (with exact labels); **MXN seeded @ scale 2**; FK enforcement (bad currency / bad tx / bad account); native-enum rejection; **CHECK held>=0** (INSERT+UPDATE) with **no blanket balance>=0** (negative clearing balance allowed); **spent_today_date/spent_month_date NOT NULL, no default** (23502 when omitted — decision #5); partial **uq_account_system_key**; **uq_payee** triple; column defaults (account balance/held/status/spent_*, payee status=pending, `ledger_entry.created_at` from clock); the named indexes exist with their partial predicates | **Yes** (honest-SKIP) | `npm test` |
| `integration/satellites-schema.integration.spec.ts` | Spec 04 **Step-2 schema is DB-enforced**: 6 tables (`hold`, `user_limits`, `outbox_event`, `audit_log`, `approval_request`, `idempotency_key`) + 5 native enum types (exact labels); native-enum rejection (one column per enum); **hold** `CHECK amount>0`, account/transaction FKs, `status` default `PLACED`; **user_limits** `UNIQUE(scope,owner_id)` **NULLS NOT DISTINCT** (two global rows rejected; global+customer coexist; two customers same owner rejected); **outbox_event** partial `idx_outbox_unpublished ... WHERE published_at IS NULL`, `published_at` default NULL, transaction FK; **audit_log** bigint IDENTITY auto-increments + `actor_id`/`action` NOT NULL; **approval_request** four-eyes `CHECK(checker_id<>maker_id)` + `status` default `PENDING`; **idempotency_key** composite PK `(owner_id,key)` (dup rejected, same key/different owner allowed) + `idx_idem_expires` and the `(owner_id,request_fingerprint,created_at)` lookup index; the shipped partial `idx_hold_account_placed` (`account_id` WHERE status `PLACED`) | **Yes** (honest-SKIP) | `npm test` |
| `integration/repositories-and-seed.integration.spec.ts` | Spec 04 **Step-3 persistence completion**. **Seed migration**: exactly the two clearing/system accounts (`clearing:rail-outbound/-inbound`, `kind=system`, `MXN`, `balance/held=0`, `active`, date markers set); **no over-seed** (system-account count == 2, **zero** `global` `user_limits`); MXN sanity. **Repos (agreed minimal surface, resolved BY TOKEN through the app graph)**: **all 10 `<NAME>_REPOSITORY` tokens bind to a working provider** (`create` + each repo's read method — `findById`, or `findByOwnerAndKey` for IdempotencyKey — guards the full PersistenceModule wiring); Account `create`→`findById`; `findByOwner` owner-scoping (isolation); `findBySystemKey` resolves a seeded clearing account; `lockByIdForUpdate` returns the row **and holds a real FOR UPDATE lock** (concurrent `FOR UPDATE NOWAIT` → 55P03); ExternalPayee `findByOwner` scoping; IdempotencyKey `findByOwnerAndKey` keys on (owner,key); Transaction & LedgerEntry `create`→`findById` | **Yes** (honest-SKIP) | `npm test` |

Discovery is already wired by the scaffold: `jest.config.ts` matches
`tests/**/*.spec.ts` (unit + the integration specs, which self-skip) and
`jest-e2e.config.ts` matches `tests/**/*.e2e-spec.ts`.

## Honest-SKIP (integration)

The integration suite is **opt-in** via `BALANCE_INTEGRATION=1`; unset it is
`describe.skip`, so Jest reports it as **skipped, never passed** (a skip is never a
false pass — see `tests/storage/README.md`). When opted in, `beforeAll` TCP-probes
Postgres (`DB_HOST:DB_PORT`, default `127.0.0.1:5432`) and **fails loudly** if it is
unreachable rather than silently degrading. It boots the real `AppModule` and runs
the real migrations against the target `balance` DB (idempotent — safe to re-run).

Run it:

```bash
# with the compose datastores reachable to the runner:
BALANCE_INTEGRATION=1 DB_HOST=127.0.0.1 DB_PORT=5432 \
  DB_NAME=balance DB_USER=balance_app DB_PASSWORD=... npm test
# optional: SAMPLE_MIGRATION_TABLE=app_metadata to also assert the exact table
```

## Seam: `support/harness.ts`

All imports of the implementor's source funnel through `support/harness.ts` (the
single coordination point). If a module/export is renamed, that file is the only
edit and it throws an actionable error naming what is missing. The seam it wires:
`parseEnv` (config), `GatewayIdentityGuard`, `ServiceIdentityGuard`,
`AllExceptionsFilter`, the `APP_CONFIG` token, `HealthController` +
`HEALTH_REPOSITORY`, `InternalController`, `requestIdMiddleware`, and `AppModule`.

For Step 3 it also wires the persistence layer: `tryResolvePersistenceModule()`
(optional — returned so the integration suite imports it and puts the DI wiring under
test; null if repos are wired straight into another module) and
`getRepositoryToken(tokenName, fileBase)` (resolves each `<NAME>_REPOSITORY` Symbol,
scanning a barrel then per-repo files — `findExportAcross` keeps looking past a barrel
that lacks the token). If the implementor lays repos out differently, `harness.ts` is
the single edit.

## Shared DB helpers: `support/pg.ts`

The schema integration specs (`schema-constraints` Step 1, `satellites-schema`
Step 2, `repositories-and-seed` Step 3) share their raw-SQL plumbing from
`support/pg.ts` — **not** implementor source, just test plumbing: the `PG` SQLSTATE
vocabulary (incl. `LOCK_NOT_AVAILABLE` 55P03 for the FOR UPDATE proof),
`withRollback(ds, fn)` (always-rolled-back QueryRunner tx), `insertRow(q, table, row)`
(parameterised `INSERT ... RETURNING *`), `expectPgError(promise, sqlstate)`,
`seedTestCurrency`, and the `insertAccount` / `insertTransaction` FK-parent builders.
Schema specs bind a one-line `withRollback = (fn) => withRollbackOn(ds, fn)` to their
resolved DataSource. **Note:** the Step-3 repo tests do NOT use `withRollback` — a
DI'd repo uses its own auto-commit connection, so a separate QueryRunner tx cannot
wrap it; those tests use random ids and clean up their committed rows in `afterEach`.

## Design notes / where fidelity comes from

- **Real code under test.** The e2e suites bind the implementor's REAL guards
  globally (`APP_GUARD`, exactly as `AppModule` does) and thread the REAL request-id
  middleware + error filter. Only genuinely-external seams are faked: the health
  suite fakes `HEALTH_REPOSITORY` (the Postgres ping) so the 200 *and* 503 branches
  are deterministic without Docker. Nothing under test is mocked away.
- **Admin is enforced inside the gateway guard** (path-based), so there is no
  separate admin guard to wire — the `/admin` 403/200 cases exercise the gateway
  guard on an `/admin` path.
- **Self-scoping** is asserted directly: a valid `/api` request needs no service
  token and a valid `/internal` request needs no user header — proving the two
  global guards do not bleed across planes.

## Known gaps (deliberate)

- **Real DB-down => 503 over the wire** is not asserted in the integration suite
  (tearing Postgres down mid-suite is flaky); the 503 readiness path is instead
  proven deterministically in `health.e2e-spec.ts` by faking the readiness repo.
- The integration migration check is **name-independent** (asserts a migrations
  tracking table with >=1 executed row + >=1 non-tracking application table) rather
  than hard-coding `app_metadata`, so it proves the DoD without coupling to the
  sample table's name. Pass `SAMPLE_MIGRATION_TABLE` to pin the exact name.
- **`schema-constraints` proves only DB-enforced invariants.** Domain invariants the
  schema does not (and should not) enforce are deferred to the domain-logic steps
  that own them, not asserted here: `SUM(ledger_entry.delta) = 0` per `transaction_id`
  (double-entry), `balance_after = balance_before + delta` (the posting fold),
  `sum(ledger delta) = account.balance`, `sum(active holds) = account.held`, the
  overdraft rule (`available >= 0` on customer debits), and the fixed-window counter
  resets. Those are `postTransaction`/reconciliation behaviours (spec 04 DoD), tested
  where that logic lands. This suite asserts the schema is a correct *foundation* for
  them (tables, enums, FKs, the `held >= 0` and non-blanket-`balance` checks, the
  uniqueness/defaults/indexes the manifest specifies).
- **`satellites-schema` (Step 2) likewise proves only DB-enforced invariants.**
  Deferred to domain-logic tests (the DB cannot/should not enforce them): the hold
  reconciliation `SUM(amount WHERE status='PLACED') per account == account.held`, the
  `PLACED → SETTLED|RELEASED|EXPIRED` transition rules, the 24h `expires_at =
  created_at + 24h` math and the retention sweep, the idempotency
  fingerprint/replay/60s soft-duplicate logic, the maker-checker *transition* guard
  (the DB only holds the `checker_id <> maker_id` CHECK; "a different admin must
  approve" is enforced in the service), and the `audit_log` append-only guarantee
  (**convention-only by decision — no trigger, no REVOKE, deferred hardening**, same
  posture as `ledger_entry`; so no UPDATE/DELETE-blocking guard is asserted here). The
  composite-PK, enum, FK,
  `CHECK amount>0`, `NULLS NOT DISTINCT`, default, and index assertions prove the
  schema foundation those behaviours build on.
- **`repositories-and-seed` (Step 3) proves the seed + the agreed minimal repo
  surface only.** DEFERRED to the domain-logic step (they are not repo methods this
  step): the specialised queries (outbox `SKIP LOCKED` relay poll, hold `PLACED`-sum,
  idempotency 60s soft-duplicate window, ledger reconstruction, tx-by-debit-account),
  and — crucially — the **no-double-spend / no-overdraft concurrency proof** (N
  simultaneous transfers). This suite proves `lockByIdForUpdate` takes a **real** row
  lock (concurrent `FOR UPDATE NOWAIT` → 55P03), which is the *primitive* the
  overdraft-safe `postTransaction` will build on; the end-to-end concurrency invariant
  is tested where that logic lands (spec 04 DoD).

## Escalations / assumptions (confirm with the developer)

1. **Error `code` vocabulary is now asserted** (`UNAUTHORIZED`/`FORBIDDEN`/`NOT_FOUND`/
   `INTERNAL_ERROR`) against `src/common/errors/error-response.ts`. If that mapping is
   deliberately non-contractual (free to change), loosen these back to a string check.
2. **`main.ts`-only middleware.** `requestIdMiddleware` is applied in `main.ts`, not
   in `AppModule`. The Docker-free e2e applies it explicitly (mirroring `main.ts`).
   The integration suite boots `AppModule` via `Test` (no `main.ts`), so its error
   responses would carry `requestId: 'unknown'` — it does not assert the correlation
   id, only health + migration. If correlation must hold under `AppModule` alone,
   move the middleware into a `NestModule.configure()` and escalate.
3. **Step-2 index names.** `idx_outbox_unpublished` and `idx_idem_expires` are fixed
   by DATA-MODEL and asserted **by name**. The soft-duplicate lookup index over
   `(owner_id, request_fingerprint, created_at)` is **not named** in the manifest, so
   it is asserted **by content** (an index on `idempotency_key` covering those three
   columns) rather than pinning a name like `idx_idem_fingerprint` — this avoids a
   false failure on a naming choice the spec does not fix. If the team wants that name
   pinned, say so and it will be asserted by name.
4. **`user_limits` uniqueness requires Postgres 15+ `NULLS NOT DISTINCT`.** The
   "reject a second global row" test depends on it (two NULL `owner_id`s must collide).
   Storage/compose runs Postgres 16, so this holds; if the target ever downgrades below
   15, the constraint needs a different encoding (e.g. a partial unique index) and this
   test is the tripwire.
5. **`idx_hold_account_placed` is guarded by name though it is not manifest-mandated.**
   It is a shipped index backing the hold reconciliation query (`SUM(amount) WHERE
   status='PLACED' per account`); the by-name + partial-predicate assertion catches a
   regression that drops or unscopes it. If the index is renamed or intentionally
   removed, update/remove this guard.
6. **Step-3 repos resolved by TOKEN through the app graph (DI under test).** The suite
   boots `AppModule` (plus `PersistenceModule` if `harness.tryResolvePersistenceModule`
   finds one) and does `app.get(<NAME>_REPOSITORY, { strict: false })`. This requires
   the repo providers to be in the app graph. If the gate errors resolving a token, the
   fix is either (a) the implementor imports `PersistenceModule` into `AppModule`, or
   (b) `harness.getRepositoryToken` gains the actual path/export — the single edit
   point. Direct impl instantiation was the sanctioned fallback but was **not** needed.
7. **`repository.create(...)` is assumed to return the persisted entity** (agreed shape
   "create → findById returns the row"), and to accept an **entity-shaped** input
   (camelCase props: `ownerId`, `spentTodayDate`, …). The Account/Payee/Idempotency
   round-trips are hardened against a void return (they re-fetch via a finder), but the
   Transaction/LedgerEntry round-trips rely on the returned `id`. If `create` returns
   void or takes a different DTO, those two fail with a clear message — escalate to
   reconcile the contract. `bigint` money fields surface as JS strings (documented in
   docs/persistence.md), so numeric checks use `Number(...)`.
