/**
 * Spec 04 — Balance Service, STEP 8a (single-actor /admin + audit foundation): the audit + limits
 * money-safety proofs driven against the REAL DI'd services (AccountsService, LimitsService, the
 * transfers-side read + the user-limits repo — all resolved BY TOKEN through a booted AppModule)
 * with real Postgres + real Redis. Written FROM the spec's "/admin Endpoints" bullet + "Admin ops"
 * module bullet + the developer-locked contract, NOT from the implementor's code:
 *
 *   - AUDIT-ON-EVERY-MUTATION: each of freeze, unfreeze, and a PUT /limits upsert writes EXACTLY ONE
 *     `audit_log` row (correct `actor_id`, `action`, `target`, and before/after `metadata`) — in the
 *     SAME tx as the change (proven transitively: the change committed ⇒ the row is there).
 *   - A READ (`listTransactions`) writes NO audit row.
 *   - TRANSACTIONAL AUDIT: a freeze on a MISSING account writes NO audit row and changes no status —
 *     nothing half-applied.
 *   - LIMITS UPSERT SEMANTICS: the first `upsertLimits` INSERTs; a second for the same
 *     `(scope, owner_id)` UPDATES the SAME row (never a duplicate), with before/after captured in the
 *     audit; and resolution is customer-override-wins (the customer row beats the seeded global
 *     baseline for that owner; a different owner with no customer row falls back to global).
 *
 * OUT OF SCOPE (step 8b): maker-checker, reversals, approvals — intentionally NOT exercised here.
 *
 * Why DB+Redis-backed and not mocked: "exactly one audit row per mutation, in the same tx" and
 * "the upsert reuses the row, not a duplicate" and "customer override wins" are properties of REAL
 * transactions + the `uq_user_limits_scope` NULLS-NOT-DISTINCT unique — mocking them would mock away
 * the logic under test. Every assertion gates on OBSERVABLE STATE (audit rows, account status,
 * user_limits rows, resolved caps).
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a false
 * pass). beforeAll TCP-probes BOTH Postgres and Redis (the app boots both) and fails loud if
 * unreachable; boots the real AppModule (migrationsRun:true → MXN + clearing accounts + the seeded
 * global limits baseline). jest.config serializes the integration run (maxWorkers:1). Unique
 * account/owner/actor ids per test; committed rows (incl. audit_log + user_limits) cleaned up per-test.
 *
 * To run:
 *   BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=… REDIS_HOST=… REDIS_PORT=…] npm test
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  getAppModule,
  getAccountsServiceToken,
  getLimitsServiceToken,
  getTransfersServiceToken,
  getUserLimitsRepositoryToken,
  tcpProbe,
} from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import * as pg from '../support/pg';
const {
  insertAccount,
  insertTransaction,
  localAccountNumber,
  getAccountStatus,
  getAuditRows,
  countAuditRows,
  deleteAuditRowsByActor,
  getUserLimitsExact,
  countUserLimitsExact,
  withRollback,
} = pg;

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED admin single-actor + audit suite: set BALANCE_INTEGRATION=1 (and point ' +
      'DB_* at Postgres AND REDIS_* at Redis — the app boots both) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const MXN = 'MXN';

// Developer-locked audit `action` constants (spec 04 step 8a brief).
const ACTION_FREEZE = 'account.freeze';
const ACTION_UNFREEZE = 'account.unfreeze';
const ACTION_LIMITS = 'limits.change';

// The transfers-side admin listing read (view ANY transaction). Resolved on the live instance.
const LIST_METHODS = [
  'listTransactions',
  'listAllTransactions',
  'queryTransactions',
  'findTransactions',
  'adminListTransactions',
];

const suite = ENABLED ? describe : describe.skip;

suite(
  'admin single-actor + audit foundation (step 8a) — money-safety proofs (integration, needs Postgres + Redis)',
  () => {
    let app: INestApplication;
    let ds: any;
    let accounts: any;
    let limits: any;
    let transfers: any;
    let listMethod: string;
    let userLimitsRepo: any;

    let createdAccountIds: string[] = [];
    let trackedOwners: string[] = [];
    let trackedActors: string[] = [];

    beforeAll(async () => {
      const [pgOk, redisOk] = await Promise.all([
        tcpProbe(DB_HOST, DB_PORT),
        tcpProbe(REDIS_HOST, REDIS_PORT),
      ]);
      if (!pgOk) {
        throw new Error(
          `[integration] BALANCE_INTEGRATION=1 but Postgres is not reachable at ${DB_HOST}:${DB_PORT}.`,
        );
      }
      if (!redisOk) {
        throw new Error(
          `[integration] BALANCE_INTEGRATION=1 but Redis is not reachable at ${REDIS_HOST}:${REDIS_PORT}.`,
        );
      }

      const env = completeRawEnv({
        DB_HOST,
        DB_PORT: String(DB_PORT),
        DB_NAME: process.env.DB_NAME || 'balance',
        DB_USER: process.env.DB_USER || 'balance_app',
        DB_PASSWORD: process.env.DB_PASSWORD || 'changeme-balance-local',
        REDIS_HOST,
        REDIS_PORT: String(REDIS_PORT),
        REDIS_PASSWORD: process.env.REDIS_PASSWORD || 'changeme-redis-local',
        INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-service-token',
        OTP_HASH_SECRET: process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789',
        RAILS_WEBHOOK_SIGNING_SECRET:
          process.env.RAILS_WEBHOOK_SIGNING_SECRET || 'test-rails-signing-secret-0123456789',
      });
      for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

      const AppModule = getAppModule();
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();

      try {
        const { DataSource } = require('typeorm');
        ds = app.get(DataSource);
      } catch {
        const { getDataSourceToken } = require('@nestjs/typeorm');
        ds = app.get(getDataSourceToken());
      }
      if (!ds)
        throw new Error('[integration] could not resolve the TypeORM DataSource from the app');

      accounts = app.get(getAccountsServiceToken(), { strict: false });
      if (!accounts || typeof accounts.setFrozen !== 'function') {
        throw new Error(
          '[integration] resolved ACCOUNTS_SERVICE but it lacks setFrozen(actorId, accountId, frozen).',
        );
      }
      limits = app.get(getLimitsServiceToken(), { strict: false });
      if (!limits || typeof limits.upsertLimits !== 'function') {
        throw new Error(
          '[integration] resolved LIMITS_SERVICE but it lacks upsertLimits(actorId, input).',
        );
      }
      transfers = app.get(getTransfersServiceToken(), { strict: false });
      listMethod = LIST_METHODS.find((m) => typeof transfers?.[m] === 'function') as string;
      if (!listMethod) {
        throw new Error(
          `[integration] the transfers-side service exposes no admin listing method (tried ${LIST_METHODS.join(
            '/',
          )}). Reconcile the "listTransactions(filter)" contract or add the name to LIST_METHODS.`,
        );
      }
      userLimitsRepo = app.get(getUserLimitsRepositoryToken(), { strict: false });
      if (!userLimitsRepo || typeof userLimitsRepo.resolveInTx !== 'function') {
        throw new Error(
          '[integration] resolved USER_LIMITS_REPOSITORY but it lacks resolveInTx(qr, ownerId, currency).',
        );
      }

      for (const fn of ['getAuditRows', 'getAccountStatus', 'getUserLimitsExact']) {
        if (typeof (pg as any)[fn] !== 'function') {
          throw new Error(`[integration] pg.${fn} is missing — reconcile tests/support/pg.ts.`);
        }
      }
    }, 60_000);

    afterEach(async () => {
      const ids = createdAccountIds;
      const owners = trackedOwners;
      const actors = trackedActors;
      createdAccountIds = [];
      trackedOwners = [];
      trackedActors = [];
      try {
        await cleanup(ids, owners, actors);
      } catch {
        /* best-effort; random ids keep re-runs safe */
      }
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    // ---- seed + query helpers -------------------------------------------------------------

    function newOwner(): string {
      const o = `sub-${randomUUID()}`;
      trackedOwners.push(o);
      return o;
    }
    function newActor(): string {
      const a = `admin-${randomUUID()}`;
      trackedActors.push(a);
      return a;
    }

    async function mkCustomer(
      owner: string,
      overrides: Record<string, unknown> = {},
    ): Promise<any> {
      const acc = await insertAccount(ds, {
        kind: 'customer',
        owner_id: owner,
        currency: MXN,
        status: 'active',
        balance: 0,
        held: 0,
        account_number: localAccountNumber(),
        ...overrides,
      });
      createdAccountIds.push(acc.id);
      return acc;
    }

    async function cleanup(ids: string[], owners: string[], actors: string[]): Promise<void> {
      // Audit rows are polymorphic (no FK) — swept by the acting admin id.
      await deleteAuditRowsByActor(ds, actors);
      if (ids.length || owners.length) {
        const txRows = await ds.query(
          `SELECT id FROM "transaction"
            WHERE debit_account_id = ANY($1) OR credit_account_id = ANY($1) OR initiated_by = ANY($2)`,
          [ids, owners],
        );
        const txIds = txRows.map((r: any) => r.id);
        if (txIds.length) {
          await ds.query(`DELETE FROM ledger_entry WHERE transaction_id = ANY($1)`, [txIds]);
          await ds.query(`DELETE FROM "transaction" WHERE id = ANY($1)`, [txIds]);
        }
      }
      if (owners.length) {
        // Only customer-scope rows (owner_id set) — NEVER the seeded global baseline (owner_id NULL).
        await ds.query(`DELETE FROM user_limits WHERE owner_id = ANY($1)`, [owners]);
      }
      if (ids.length) await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
      if (owners.length) await ds.query(`DELETE FROM customer WHERE id = ANY($1)`, [owners]);
    }

    async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
      try {
        return { ok: true, value: await p };
      } catch (error) {
        return { ok: false, error };
      }
    }

    async function resolveCaps(ownerId: string): Promise<any> {
      let resolved: any;
      await withRollback(ds, async (qr: any) => {
        resolved = await userLimitsRepo.resolveInTx(qr, ownerId, MXN);
      });
      return resolved;
    }

    // =========================================================================================
    // AUDIT-ON-EVERY-MUTATION — freeze / unfreeze each write EXACTLY ONE row (same tx as the flip)
    // =========================================================================================

    it('FREEZE writes exactly one audit_log row (actor, action=account.freeze, target=account id, before/after status) AND flips status to frozen', async () => {
      const actor = newActor();
      const acc = await mkCustomer(newOwner(), { balance: 5000 });

      const res = await capture(accounts.setFrozen(actor, acc.id, true));
      expect(res.ok).toBe(true);

      // The status change committed.
      expect(await getAccountStatus(ds, acc.id)).toBe('frozen');

      // Exactly one audit row for THIS action + target, attributed to the acting admin.
      const rows = await getAuditRows(ds, { action: ACTION_FREEZE, targetId: acc.id });
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(actor);
      expect(rows[0].action).toBe(ACTION_FREEZE);
      expect(rows[0].target_id).toBe(acc.id);
      // The metadata records the before/after transition (active → frozen).
      const meta = JSON.stringify(rows[0].metadata);
      expect(meta).toContain('active'); // before
      expect(meta).toContain('frozen'); // after
    }, 30_000);

    it('UNFREEZE writes exactly one audit_log row (action=account.unfreeze) AND flips status back to active', async () => {
      const actor = newActor();
      const acc = await mkCustomer(newOwner(), { balance: 5000, status: 'frozen' });

      const res = await capture(accounts.setFrozen(actor, acc.id, false));
      expect(res.ok).toBe(true);
      expect(await getAccountStatus(ds, acc.id)).toBe('active');

      const rows = await getAuditRows(ds, { action: ACTION_UNFREEZE, targetId: acc.id });
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(actor);
    }, 30_000);

    // =========================================================================================
    // TRANSACTIONAL AUDIT — a freeze on a MISSING account: NO audit row, NO status change
    // =========================================================================================

    it('freeze on a MISSING account rejects, writes NO audit row, and creates/changes no status (nothing half-applied)', async () => {
      const actor = newActor();
      const missingId = randomUUID();

      const res = await capture(accounts.setFrozen(actor, missingId, true));
      expect(res.ok).toBe(false);
      // Classify by the STABLE domain code (cross-module `instanceof` is unreliable);
      // `ACCOUNT_NOT_FOUND` maps to 404 at the HTTP edge.
      expect(res.error?.code).toBe('ACCOUNT_NOT_FOUND');

      // No audit row was written for the non-existent target, and no account row appeared.
      expect(await countAuditRows(ds, { targetId: missingId })).toBe(0);
      expect(await countAuditRows(ds, { actorId: actor })).toBe(0);
      expect(await getAccountStatus(ds, missingId)).toBeNull();
    }, 30_000);

    // =========================================================================================
    // READS write NO audit — listTransactions is a read
    // =========================================================================================

    it('a READ (listTransactions) writes NO audit row: a prior freeze leaves exactly one row and the read adds none', async () => {
      const actor = newActor();
      const owner = newOwner();
      const acc = await mkCustomer(owner, { balance: 5000 });
      // Seed a transaction so the list is non-empty (proves the read actually ran / returned data).
      await insertTransaction(ds, {
        type: 'internal',
        status: 'POSTED',
        initiatedBy: owner,
        debitAccountId: acc.id,
        creditAccountId: null,
        amount: '1000',
        currency: MXN,
        postedAt: new Date(),
      });

      await accounts.setFrozen(actor, acc.id, true); // one mutation → one audit row
      const before = await countAuditRows(ds, { actorId: actor });
      expect(before).toBe(1);

      const listed = await transfers[listMethod]({ limit: 50, offset: 0 });
      expect(
        Array.isArray(listed) || Array.isArray(listed?.items) || Array.isArray(listed?.data),
      ).toBe(true);

      // The read added NO audit row — the actor's count is unchanged.
      expect(await countAuditRows(ds, { actorId: actor })).toBe(before);
    }, 30_000);

    // =========================================================================================
    // LIMITS UPSERT SEMANTICS — insert then UPDATE the same row; before/after audited; resolution
    // =========================================================================================

    it('PUT /limits upsert: first call INSERTs, a second for the same (scope, ownerId) UPDATES the SAME row (never a duplicate), each audited with before/after', async () => {
      const actor = newActor();
      const owner = newOwner();
      // Seed the customer + an account so the FK (if the row references an owner) is satisfiable and
      // so the owner is a real customer, mirroring production.
      await mkCustomer(owner, { balance: 0 });

      // First upsert → INSERT.
      const first = await capture(
        limits.upsertLimits(actor, {
          scope: 'customer',
          ownerId: owner,
          currency: MXN,
          perTransactionMax: '5000',
          dailyMax: '20000',
          monthlyMax: '100000',
        }),
      );
      expect(first.ok).toBe(true);
      expect(await countUserLimitsExact(ds, { scope: 'customer', ownerId: owner })).toBe(1);
      let row = await getUserLimitsExact(ds, { scope: 'customer', ownerId: owner });
      expect(row?.per_transaction_max).toBe('5000');
      expect(await countAuditRows(ds, { actorId: actor, action: ACTION_LIMITS })).toBe(1);

      // Second upsert for the SAME (scope, ownerId) → UPDATE the same row, not a duplicate.
      const second = await capture(
        limits.upsertLimits(actor, {
          scope: 'customer',
          ownerId: owner,
          currency: MXN,
          perTransactionMax: '7000',
          dailyMax: '20000',
          monthlyMax: '100000',
        }),
      );
      expect(second.ok).toBe(true);
      expect(await countUserLimitsExact(ds, { scope: 'customer', ownerId: owner })).toBe(1); // STILL one
      row = await getUserLimitsExact(ds, { scope: 'customer', ownerId: owner });
      expect(row?.per_transaction_max).toBe('7000'); // updated in place

      // Two audit rows now; the SECOND captures before(5000) → after(7000).
      const auditRows = await getAuditRows(ds, { actorId: actor, action: ACTION_LIMITS });
      expect(auditRows).toHaveLength(2);
      const lastMeta = JSON.stringify(auditRows[auditRows.length - 1].metadata);
      expect(lastMeta).toContain('5000'); // before
      expect(lastMeta).toContain('7000'); // after
    }, 30_000);

    it('resolution after an upsert: the CUSTOMER override wins for that owner; a different owner with no override falls back to the seeded GLOBAL baseline', async () => {
      const actor = newActor();
      const owner = newOwner();
      const otherOwner = newOwner();
      await mkCustomer(owner, { balance: 0 });

      await limits.upsertLimits(actor, {
        scope: 'customer',
        ownerId: owner,
        currency: MXN,
        perTransactionMax: '7000',
        dailyMax: '20000',
        monthlyMax: '100000',
      });

      // The owner with the override resolves to the CUSTOMER caps (customer-wins).
      const customerCaps = await resolveCaps(owner);
      expect(customerCaps).toBeTruthy();
      expect(customerCaps.perTransactionMax).toBe('7000');

      // A different owner (no customer row) resolves to the SEEDED GLOBAL baseline — non-null and
      // NOT the customer's tight cap (proves the fallback, without hardcoding the baseline value).
      const globalCaps = await resolveCaps(otherOwner);
      expect(globalCaps).toBeTruthy();
      expect(globalCaps.perTransactionMax).not.toBe('7000');
    }, 30_000);
  },
);
