/**
 * Spec 04 — Balance Service persistence layer, STEP 3 (persistence COMPLETION):
 * the system-account seed migration + the minimal per-aggregate repository layer.
 *
 * Written from spec 04 + specs/DATA-MODEL.md + the agreed Step-3 shape (method
 * surface below), NOT from the implementor's repo code. Assertions encode intended
 * behaviour, so a deviation (missing seed, over-seed, broken owner scoping, a
 * lockByIdForUpdate that does not actually lock, a finder that ignores its key) FAILS.
 *
 * Two things under test:
 *   1) A NEW migration seeds EXACTLY the two clearing/system accounts (like the MXN
 *      currency row) — committed on boot. NO global limits, NO customer/demo data
 *      (those defer to spec 08). Asserted read-only (these rows are committed; do NOT
 *      wrap them in a rollback).
 *   2) The minimal per-aggregate repos. Agreed surface only: findById + create;
 *      findByOwner (owner-scoped repos); Account also findBySystemKey +
 *      lockByIdForUpdate(queryRunner, id); IdempotencyKey findByOwnerAndKey.
 *      Specialised/domain queries (SKIP LOCKED poll, PLACED-sum, soft-duplicate
 *      window, reconstruction, tx-by-debit-account) are DEFERRED and NOT tested.
 *
 * Repos are resolved BY TOKEN through the booted app graph (DI wiring under test); if
 * a PersistenceModule is found it is imported into the testing module too. Source
 * imports funnel through tests/support/harness.ts (the single seam).
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (default `npm test` reports SKIPPED —
 * never a false pass), TCP-probe Postgres in beforeAll (fail loud if unreachable),
 * boot the real AppModule (runs all migrations on boot). Repo methods use the repo's
 * own (auto-commit) connection, so mutating repo tests CANNOT be wrapped in the shared
 * withRollback QueryRunner tx — instead they use random ids and clean up their own
 * rows in afterEach, so the suite stays idempotent/re-runnable. jest.config.ts already
 * serializes the integration run (maxWorkers:1 when BALANCE_INTEGRATION=1).
 *
 * To run:
 *   1. bring up the compose datastores (Postgres reachable to the test runner);
 *   2. export the balance service's DB_* env (or rely on the defaults below);
 *   3. BALANCE_INTEGRATION=1 npm test
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  getAppModule,
  tcpProbe,
  tryResolvePersistenceModule,
  getRepositoryToken,
} from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import { PG, TODAY, MONTH_START, insertRow, expectPgError } from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED repositories-and-seed suite: set BALANCE_INTEGRATION=1 (and ' +
      'point DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME at a reachable Postgres) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');

const suite = ENABLED ? describe : describe.skip;

const CLEARING_KEYS = ['clearing:rail-inbound', 'clearing:rail-outbound'];
const DAY_MS = 86_400_000;

// All 10 per-aggregate repos: [repos key, DI token export name, kebab file base,
// expected READ method]. Every repo has `create`; the read method is `findById`
// EXCEPT IdempotencyKey, whose PK is composite `(owner_id, key)` so it exposes
// `findByOwnerAndKey` and deliberately has no `findById` (agreed, locked design).
// The harness resolves each `<NAME>_REPOSITORY` Symbol; app.get binds it from the graph.
const REPO_SPECS: Array<[string, string, string, string]> = [
  ['account', 'ACCOUNT_REPOSITORY', 'account', 'findById'],
  ['externalPayee', 'EXTERNAL_PAYEE_REPOSITORY', 'external-payee', 'findById'],
  ['idempotencyKey', 'IDEMPOTENCY_KEY_REPOSITORY', 'idempotency-key', 'findByOwnerAndKey'],
  ['transaction', 'TRANSACTION_REPOSITORY', 'transaction', 'findById'],
  ['ledgerEntry', 'LEDGER_ENTRY_REPOSITORY', 'ledger-entry', 'findById'],
  ['hold', 'HOLD_REPOSITORY', 'hold', 'findById'],
  ['userLimits', 'USER_LIMITS_REPOSITORY', 'user-limits', 'findById'],
  ['outboxEvent', 'OUTBOX_EVENT_REPOSITORY', 'outbox-event', 'findById'],
  ['auditLog', 'AUDIT_LOG_REPOSITORY', 'audit-log', 'findById'],
  ['approvalRequest', 'APPROVAL_REQUEST_REPOSITORY', 'approval-request', 'findById'],
];

suite('balance persistence — Step 3 seed + repositories (integration, needs Postgres)', () => {
  let app: INestApplication;
  let ds: any;
  const repos: Record<string, any> = {};

  // Committed test rows are dropped here after each test (LIFO -> FK-reverse order).
  const cleanups: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    const reachable = await tcpProbe(DB_HOST, DB_PORT);
    if (!reachable) {
      throw new Error(
        `[integration] BALANCE_INTEGRATION=1 but Postgres is not reachable at ` +
          `${DB_HOST}:${DB_PORT}. Bring up the compose datastores (and publish/point ` +
          `DB_HOST/DB_PORT at them) or unset BALANCE_INTEGRATION.`,
      );
    }

    const env = completeRawEnv({
      DB_HOST,
      DB_PORT: String(DB_PORT),
      DB_NAME: process.env.DB_NAME || 'balance',
      DB_USER: process.env.DB_USER || 'balance_app',
      DB_PASSWORD: process.env.DB_PASSWORD || 'changeme-balance-local',
      REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
      REDIS_PORT: process.env.REDIS_PORT || '6379',
      REDIS_PASSWORD: process.env.REDIS_PASSWORD || 'changeme-redis-local',
      INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-service-token',
    });
    for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

    const AppModule = getAppModule();
    const PersistenceModule = tryResolvePersistenceModule();
    const imports = PersistenceModule ? [AppModule, PersistenceModule] : [AppModule];

    const moduleRef = await Test.createTestingModule({ imports }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // runs all migrations on boot (migrationsRun: true)

    try {
      const { DataSource } = require('typeorm');
      ds = app.get(DataSource);
    } catch {
      const { getDataSourceToken } = require('@nestjs/typeorm');
      ds = app.get(getDataSourceToken());
    }
    if (!ds) throw new Error('[integration] could not resolve the TypeORM DataSource from the app');

    // Resolve ALL 10 repos BY TOKEN from the app graph. The first five get behavioural
    // round-trips below; the other five are boilerplate whose binding we still gate
    // (a copy-paste mis-bind or a missing token export must not slip past). Resolving
    // in beforeAll throws loudly if any provider is unwired; the wiring test below
    // makes the guarantee explicit and checks the method surface.
    for (const [key, tokenName, fileBase] of REPO_SPECS) {
      const token = getRepositoryToken(tokenName, fileBase);
      repos[key] = app.get(token, { strict: false });
      if (!repos[key]) {
        throw new Error(
          `[integration] resolved token ${tokenName} but the app graph has no provider ` +
            `for it — is PersistenceModule (or the repo provider) wired into AppModule?`,
        );
      }
    }
  }, 60_000);

  afterEach(async () => {
    while (cleanups.length) {
      const c = cleanups.pop()!;
      try {
        await c();
      } catch {
        /* best-effort cleanup; random ids keep re-runs safe even if one fails */
      }
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // ---- Part 1: system-account seed migration (read-only; committed by the migration)

  it('seeds EXACTLY the two clearing/system accounts with the expected shape', async () => {
    const rows: Array<Record<string, any>> = await ds.query(
      `SELECT system_key, kind, currency, balance, held, status, spent_today_date, spent_month_date
         FROM account WHERE kind = 'system' ORDER BY system_key`,
    );
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.system_key)).toEqual(CLEARING_KEYS);
    for (const r of rows) {
      expect(r.kind).toBe('system');
      expect(r.currency).toBe('MXN');
      expect(Number(r.balance)).toBe(0);
      expect(Number(r.held)).toBe(0);
      expect(r.status).toBe('active');
      expect(r.spent_today_date).toBeTruthy();
      expect(r.spent_month_date).toBeTruthy();
    }
  });

  it('does NOT over-seed: no other system accounts, and NO global user_limits row', async () => {
    const [{ system_count }] = await ds.query(
      `SELECT count(*)::int AS system_count FROM account WHERE kind = 'system'`,
    );
    expect(system_count).toBe(2); // exactly the two clearing accounts — nothing else

    const [{ global_limits }] = await ds.query(
      `SELECT count(*)::int AS global_limits FROM user_limits WHERE scope = 'global'`,
    );
    expect(global_limits).toBe(0); // global limits deliberately deferred to spec 08
  });

  it('MXN currency is present (seed sanity)', async () => {
    const rows = await ds.query(`SELECT minor_unit_scale FROM currency WHERE code = 'MXN'`);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].minor_unit_scale)).toBe(2);
  });

  // ---- Part 2: repository round-trips -------------------------------------------

  it('binds ALL 10 repository tokens to a working provider (create + its read method)', () => {
    // Each token resolved in beforeAll; here we assert the full set is present and
    // exposes the agreed minimal surface — so a mis-bound/omitted token on ANY repo
    // (not just the 5 with round-trips) fails the gate. `create` is universal; the
    // read method is per-repo (findById, or findByOwnerAndKey for IdempotencyKey).
    for (const [key, , , readMethod] of REPO_SPECS) {
      const repo = repos[key];
      expect(repo).toBeTruthy();
      expect(typeof repo.create).toBe('function');
      expect(typeof repo[readMethod]).toBe('function');
    }
  });

  it('Account.create persists and Account.findById returns it (with DB defaults)', async () => {
    const ownerId = `sub-${randomUUID()}`;
    cleanups.push(() => ds.query(`DELETE FROM "account" WHERE owner_id = $1`, [ownerId]));

    const created = await repos.account.create({
      kind: 'customer',
      currency: 'MXN',
      ownerId,
      spentTodayDate: TODAY,
      spentMonthDate: MONTH_START,
    });
    // Robust to create's return shape: prefer the returned id, else look it up.
    const id = created?.id ?? (await repos.account.findByOwner(ownerId))[0]?.id;
    expect(id).toBeTruthy();

    const found = await repos.account.findById(id);
    expect(found).toBeTruthy();
    expect(found.id).toBe(id);
    expect(found.ownerId).toBe(ownerId);
    expect(found.kind).toBe('customer');
    expect(found.status).toBe('active'); // DB default surfaces through the repo
    expect(Number(found.balance)).toBe(0);
    expect(Number(found.held)).toBe(0);
  });

  it("Account.findByOwner is owner-scoped (returns only that owner's accounts)", async () => {
    const ownerA = `sub-${randomUUID()}`;
    const ownerB = `sub-${randomUUID()}`;
    cleanups.push(() =>
      ds.query(`DELETE FROM "account" WHERE owner_id = ANY($1)`, [[ownerA, ownerB]]),
    );

    const mk = (ownerId: string) =>
      repos.account.create({
        kind: 'customer',
        currency: 'MXN',
        ownerId,
        spentTodayDate: TODAY,
        spentMonthDate: MONTH_START,
      });
    await mk(ownerA);
    await mk(ownerA);
    await mk(ownerB);

    const aAccts = await repos.account.findByOwner(ownerA);
    expect(aAccts.length).toBe(2);
    expect(aAccts.every((a: any) => a.ownerId === ownerA)).toBe(true);

    const bAccts = await repos.account.findByOwner(ownerB);
    expect(bAccts.length).toBe(1);
    expect(bAccts[0].ownerId).toBe(ownerB);
  });

  it('Account.findBySystemKey resolves a seeded clearing account', async () => {
    const acc = await repos.account.findBySystemKey('clearing:rail-outbound');
    expect(acc).toBeTruthy();
    expect(acc.kind).toBe('system');
    expect(acc.systemKey).toBe('clearing:rail-outbound');
    expect(acc.currency).toBe('MXN');

    // A non-existent system key resolves to nothing (not an arbitrary row).
    const missing = await repos.account.findBySystemKey(`clearing:none-${randomUUID()}`);
    expect(missing == null).toBe(true);
  });

  it('Account.lockByIdForUpdate returns the row AND takes a real FOR UPDATE lock', async () => {
    // Commit a row so a second connection can see it and contend for the lock.
    const acc = await insertRow(ds, 'account', {
      kind: 'customer',
      owner_id: `sub-${randomUUID()}`,
      currency: 'MXN',
      spent_today_date: TODAY,
      spent_month_date: MONTH_START,
    });
    cleanups.push(() => ds.query(`DELETE FROM "account" WHERE id = $1`, [acc.id]));

    const qrA = ds.createQueryRunner();
    const qrB = ds.createQueryRunner();
    await qrA.connect();
    await qrB.connect();
    await qrA.startTransaction();
    try {
      const locked = await repos.account.lockByIdForUpdate(qrA, acc.id);
      expect(locked).toBeTruthy();
      expect(locked.id).toBe(acc.id);

      // While qrA holds the FOR UPDATE lock, a concurrent NOWAIT lock on the same row
      // must fail immediately with lock_not_available. If lockByIdForUpdate did NOT
      // actually lock (e.g. ignored the queryRunner / omitted FOR UPDATE), qrB would
      // succeed and this assertion would fail — catching the missing lock.
      await expectPgError(
        qrB.query(`SELECT id FROM "account" WHERE id = $1 FOR UPDATE NOWAIT`, [acc.id]),
        PG.LOCK_NOT_AVAILABLE,
      );
    } finally {
      await qrA.rollbackTransaction();
      await qrA.release();
      await qrB.release();
    }
  });

  it('ExternalPayee.findByOwner is owner-scoped', async () => {
    const ownerA = `sub-${randomUUID()}`;
    const ownerB = `sub-${randomUUID()}`;
    cleanups.push(() =>
      ds.query(`DELETE FROM external_payee WHERE owner_id = ANY($1)`, [[ownerA, ownerB]]),
    );

    const mk = (ownerId: string) =>
      repos.externalPayee.create({
        ownerId,
        displayName: 'ACME',
        rail: 'rail-outbound',
        destinationRef: `ref-${randomUUID()}`,
        coolingOffUntil: new Date(),
      });
    await mk(ownerA);
    await mk(ownerA);
    await mk(ownerB);

    const a = await repos.externalPayee.findByOwner(ownerA);
    expect(a.length).toBe(2);
    expect(a.every((p: any) => p.ownerId === ownerA)).toBe(true);
  });

  it('IdempotencyKey.findByOwnerAndKey keys on BOTH owner and key (per-caller namespacing)', async () => {
    const key = `idem-${randomUUID()}`;
    const ownerA = `sub-${randomUUID()}`;
    const ownerB = `sub-${randomUUID()}`;
    cleanups.push(() =>
      ds.query(`DELETE FROM idempotency_key WHERE owner_id = ANY($1)`, [[ownerA, ownerB]]),
    );

    // Same key under two different owners must be two distinct rows.
    await repos.idempotencyKey.create({
      ownerId: ownerA,
      key,
      requestFingerprint: 'fp-A',
      status: 'in_progress',
      expiresAt: new Date(Date.now() + DAY_MS),
    });
    await repos.idempotencyKey.create({
      ownerId: ownerB,
      key,
      requestFingerprint: 'fp-B',
      status: 'in_progress',
      expiresAt: new Date(Date.now() + DAY_MS),
    });

    const a = await repos.idempotencyKey.findByOwnerAndKey(ownerA, key);
    const b = await repos.idempotencyKey.findByOwnerAndKey(ownerB, key);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    // If the lookup keyed on `key` alone it could not tell these apart.
    expect(a.requestFingerprint).toBe('fp-A');
    expect(b.requestFingerprint).toBe('fp-B');

    const missing = await repos.idempotencyKey.findByOwnerAndKey(ownerA, `idem-${randomUUID()}`);
    expect(missing == null).toBe(true);
  });

  it('Transaction.create persists and Transaction.findById returns it', async () => {
    const initiatedBy = `sub-${randomUUID()}`;
    const created = await repos.transaction.create({
      type: 'internal',
      status: 'PENDING',
      amount: '1000',
      currency: 'MXN',
      initiatedBy,
    });
    expect(created?.id).toBeTruthy();
    cleanups.push(() => ds.query(`DELETE FROM "transaction" WHERE id = $1`, [created.id]));

    const found = await repos.transaction.findById(created.id);
    expect(found).toBeTruthy();
    expect(found.id).toBe(created.id);
    expect(found.type).toBe('internal');
    expect(found.status).toBe('PENDING');
    expect(Number(found.amount)).toBe(1000);
  });

  it('LedgerEntry.create persists and LedgerEntry.findById returns it', async () => {
    const tx = await repos.transaction.create({
      type: 'internal',
      status: 'PENDING',
      amount: '1000',
      currency: 'MXN',
      initiatedBy: `sub-${randomUUID()}`,
    });
    expect(tx?.id).toBeTruthy();
    const acc = await insertRow(ds, 'account', {
      kind: 'customer',
      owner_id: `sub-${randomUUID()}`,
      currency: 'MXN',
      spent_today_date: TODAY,
      spent_month_date: MONTH_START,
    });
    // Push in creation order; afterEach pops LIFO -> ledger, then account, then tx.
    cleanups.push(() => ds.query(`DELETE FROM "transaction" WHERE id = $1`, [tx.id]));
    cleanups.push(() => ds.query(`DELETE FROM "account" WHERE id = $1`, [acc.id]));

    const created = await repos.ledgerEntry.create({
      transactionId: tx.id,
      accountId: acc.id,
      delta: '-1000',
      balanceAfter: '-1000',
      currency: 'MXN',
    });
    expect(created?.id).toBeTruthy();
    cleanups.push(() => ds.query(`DELETE FROM ledger_entry WHERE id = $1`, [created.id]));

    const found = await repos.ledgerEntry.findById(created.id);
    expect(found).toBeTruthy();
    expect(found.id).toBe(created.id);
    expect(found.transactionId).toBe(tx.id);
    expect(found.accountId).toBe(acc.id);
    expect(Number(found.delta)).toBe(-1000);
  });
});
