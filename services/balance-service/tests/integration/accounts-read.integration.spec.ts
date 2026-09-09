/**
 * Spec 04 — Balance Service DOMAIN layer, STEP 1: the two READ-ONLY customer endpoints
 *   1. GET /api/accounts                    — the caller's own accounts
 *   2. GET /api/accounts/:id/transactions   — one account's ledger statement
 *
 * Written from spec 04 (Modules "Accounts" + "Object-level authorization" + the
 * "available = balance − held" invariant) and the Step-1 coordination contract, NOT
 * from the implementor's code. The suite drives the REAL AppModule over HTTP with
 * supertest — through the real gateway identity guard, the global exception filter,
 * and the request-id middleware — with rows seeded straight into Postgres via
 * tests/support/pg.ts. That is the only level where object-level authorization and the
 * DTO contract are meaningfully provable, so a wrong implementation (owner scoping that
 * leaks or authorizes another user's account, a 403/existence leak instead of 404, a
 * float-lossy available, an unbounded or wrongly-ordered statement, a missing id
 * validation) FAILS a test here.
 *
 * Contract under test (spec-derived):
 *   - GET /api/accounts -> 200 { accounts: AccountDto[] }, ONLY the caller's accounts.
 *     AccountDto = { id, currency, status, kind, balance, held, available }; money
 *     fields are decimal strings (bigint minor units);
 *     available = (BigInt(balance) - BigInt(held)).toString().
 *   - GET /api/accounts/:id/transactions -> 200 { accountId, entries: StatementEntryDto[] }.
 *     StatementEntryDto = { id, transactionId, delta, balanceAfter, currency, createdAt };
 *     entries are that account's ledger legs, newest-first (created_at DESC), bounded to
 *     a page limit of 100. Malformed :id -> 400 BAD_REQUEST. Missing / not-owned / a
 *     system account -> 404 NOT_FOUND (never 403, never a leak of existence).
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED,
 * never a false pass), TCP-probe Postgres in beforeAll (fail loud if unreachable), boot
 * the real AppModule (migrationsRun:true seeds MXN + the two clearing accounts). The app
 * reads through its own auto-commit connection, so seed rows are COMMITTED (not wrapped
 * in a rolled-back tx) and cleaned up in afterEach with random ids — the suite stays
 * idempotent/re-runnable. jest.config.ts serializes the integration run (maxWorkers:1).
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
import request from 'supertest';

import { getAppModule, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import { insertRow, insertLedgerEntry, TODAY, MONTH_START } from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED accounts-read suite: set BALANCE_INTEGRATION=1 (and point ' +
      'DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME at a reachable Postgres) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');

const suite = ENABLED ? describe : describe.skip;

const NOT_FOUND = 'NOT_FOUND';
const BAD_REQUEST = 'BAD_REQUEST';

suite(
  'accounts read endpoints — owner scoping, available, statement (integration, needs Postgres)',
  () => {
    let app: INestApplication;
    let ds: any;
    let http: any;

    // Committed test rows dropped after each test (pushed in creation order, popped LIFO
    // so children are removed before their FK parents).
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
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init(); // runs migrations on boot (migrationsRun: true): MXN + clearing accounts
      http = app.getHttpServer();

      try {
        const { DataSource } = require('typeorm');
        ds = app.get(DataSource);
      } catch {
        const { getDataSourceToken } = require('@nestjs/typeorm');
        ds = app.get(getDataSourceToken());
      }
      if (!ds)
        throw new Error('[integration] could not resolve the TypeORM DataSource from the app');
    }, 60_000);

    afterEach(async () => {
      while (cleanups.length) {
        const c = cleanups.pop()!;
        try {
          await c();
        } catch {
          /* best-effort; random ids keep re-runs safe even if one cleanup fails */
        }
      }
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    // ---- seed helpers (committed rows; cleanup registered in FK-safe order) ----------

    async function mkAccount(overrides: Record<string, unknown>): Promise<any> {
      const acc = await insertRow(ds, 'account', {
        kind: 'customer',
        currency: 'MXN',
        spent_today_date: TODAY,
        spent_month_date: MONTH_START,
        ...overrides,
      });
      cleanups.push(() => ds.query(`DELETE FROM "account" WHERE id = $1`, [acc.id]));
      return acc;
    }

    async function mkTransaction(initiatedBy: string): Promise<any> {
      const tx = await insertRow(ds, 'transaction', {
        type: 'internal',
        status: 'PENDING',
        amount: 1000,
        currency: 'MXN',
        initiated_by: initiatedBy,
      });
      cleanups.push(() => ds.query(`DELETE FROM "transaction" WHERE id = $1`, [tx.id]));
      return tx;
    }

    async function addLedgerEntry(
      accountId: string,
      txId: string,
      fields: { delta: number | string; balanceAfter: number | string; createdAt?: string },
    ): Promise<any> {
      const row: Record<string, unknown> = {
        transaction_id: txId,
        account_id: accountId,
        delta: fields.delta,
        balance_after: fields.balanceAfter,
        currency: 'MXN',
      };
      if (fields.createdAt) row.created_at = fields.createdAt;
      const entry = await insertLedgerEntry(ds, row);
      cleanups.push(() => ds.query(`DELETE FROM ledger_entry WHERE id = $1`, [entry.id]));
      return entry;
    }

    const asCustomer = (userId: string, path: string) =>
      request(http).get(path).set('X-User-Id', userId).set('X-Roles', 'customer');

    // ---- GET /api/accounts: owner scoping (anti-IDOR) + DTO shape --------------------

    it("returns ONLY the caller's own accounts, never another user's (anti-IDOR)", async () => {
      const ownerA = `sub-${randomUUID()}`;
      const ownerB = `sub-${randomUUID()}`;
      const a1 = await mkAccount({ owner_id: ownerA, balance: 1000, held: 0 });
      const a2 = await mkAccount({ owner_id: ownerA, balance: 2000, held: 500 });
      const b1 = await mkAccount({ owner_id: ownerB, balance: 9999, held: 0 });

      const res = await asCustomer(ownerA, '/api/accounts');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.accounts)).toBe(true);

      const ids = res.body.accounts.map((a: any) => a.id).sort();
      // Exactly A's two accounts — and B's account is absent. The DTO carries no owner_id,
      // so this id-set equality is what proves the WHERE owner_id = :sub scoping.
      expect(ids).toEqual([a1.id, a2.id].sort());
      expect(ids).not.toContain(b1.id);
    });

    it('shapes each account as the AccountDto contract (fields + money as strings)', async () => {
      const owner = `sub-${randomUUID()}`;
      const acc = await mkAccount({ owner_id: owner, balance: 1234, held: 34 });

      const res = await asCustomer(owner, '/api/accounts');
      expect(res.status).toBe(200);
      const dto = res.body.accounts.find((a: any) => a.id === acc.id);
      expect(dto).toBeTruthy();
      expect(Object.keys(dto).sort()).toEqual(
        ['available', 'balance', 'currency', 'held', 'id', 'kind', 'status'].sort(),
      );
      expect(dto.kind).toBe('customer');
      expect(dto.status).toBe('active');
      expect(dto.currency).toBe('MXN');
      expect(typeof dto.balance).toBe('string');
      expect(typeof dto.held).toBe('string');
      expect(typeof dto.available).toBe('string');
      expect(dto.balance).toBe('1234');
      expect(dto.held).toBe('34');
      expect(dto.available).toBe('1200');
    });

    it('lists a FROZEN account and still serves its statement (reads do not filter by status)', async () => {
      const owner = `sub-${randomUUID()}`;
      const frozen = await mkAccount({
        owner_id: owner,
        status: 'frozen',
        balance: 800,
        held: 100,
      });

      const list = await asCustomer(owner, '/api/accounts');
      expect(list.status).toBe(200);
      const dto = list.body.accounts.find((a: any) => a.id === frozen.id);
      expect(dto).toBeTruthy();
      // A frozen account is still the customer's to SEE; only movement is blocked. A read
      // path that filtered by status would silently drop it from the customer's view.
      expect(dto.status).toBe('frozen');
      expect(dto.available).toBe('700'); // 800 - 100, unaffected by status

      // Its statement is still readable — the freeze must not turn a read into 404/deny.
      const tx = await mkTransaction(owner);
      const leg = await addLedgerEntry(frozen.id, tx.id, { delta: -200, balanceAfter: 800 });
      const stmt = await asCustomer(owner, `/api/accounts/${frozen.id}/transactions`);
      expect(stmt.status).toBe(200);
      expect(stmt.body.accountId).toBe(frozen.id);
      expect(stmt.body.entries.map((e: any) => e.id)).toContain(leg.id);
    });

    // ---- GET /api/accounts: available = balance - held (edge cases + precision) ------

    it('derives available = balance - held for held>0, held=0, and held=balance', async () => {
      const owner = `sub-${randomUUID()}`;
      const partial = await mkAccount({ owner_id: owner, balance: 5000, held: 2000 });
      const zeroHeld = await mkAccount({ owner_id: owner, balance: 7500, held: 0 });
      const fullyHeld = await mkAccount({ owner_id: owner, balance: 4000, held: 4000 });

      const res = await asCustomer(owner, '/api/accounts');
      expect(res.status).toBe(200);
      const byId = new Map<string, any>(res.body.accounts.map((a: any) => [a.id, a]));

      expect(byId.get(partial.id).available).toBe('3000'); // 5000 - 2000
      expect(byId.get(zeroHeld.id).available).toBe('7500'); // held = 0 => available = balance
      expect(byId.get(fullyHeld.id).available).toBe('0'); // held = balance => available = 0
    });

    it('preserves bigint money end-to-end with no float precision loss (near the max bigint)', async () => {
      const owner = `sub-${randomUUID()}`;
      // 2^63 - 1: exceeds Number.MAX_SAFE_INTEGER by orders of magnitude. If any layer
      // (repo read, DTO map, available derivation) touches Number, balance/held/available
      // come back rounded and these exact-string assertions fail.
      const big = await mkAccount({ owner_id: owner, balance: '9223372036854775807', held: '1' });

      const res = await asCustomer(owner, '/api/accounts');
      expect(res.status).toBe(200);
      const dto = res.body.accounts.find((a: any) => a.id === big.id);
      expect(dto).toBeTruthy();
      expect(dto.balance).toBe('9223372036854775807');
      expect(dto.held).toBe('1');
      expect(dto.available).toBe('9223372036854775806');
    });

    // ---- GET /api/accounts/:id/transactions: object-level authorization --------------

    it('returns 404 (not 403, no existence leak) for an account owned by another user', async () => {
      const ownerA = `sub-${randomUUID()}`;
      const ownerB = `sub-${randomUUID()}`;
      const bAcc = await mkAccount({ owner_id: ownerB, balance: 1000, held: 0 });

      const foreign = await asCustomer(ownerA, `/api/accounts/${bAcc.id}/transactions`);
      expect(foreign.status).toBe(404);
      expect(foreign.body.error.code).toBe(NOT_FOUND);

      // A well-formed but non-existent id, same caller.
      const missing = await asCustomer(ownerA, `/api/accounts/${randomUUID()}/transactions`);
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe(NOT_FOUND);

      // The response for "exists but not yours" must be indistinguishable from "absent":
      // same status, same code, same message. A leak here (e.g. "account frozen" vs "not
      // found", or 403 for one and 404 for the other) lets an attacker probe ownership.
      // UUIDs are stripped first so echoing the caller-supplied id (not itself a leak,
      // it came from the URL) does not cause a false failure; a DIFFERENT message
      // template between the two cases still trips it.
      const stripIds = (m: string) =>
        m.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');
      expect(stripIds(foreign.body.error.message)).toBe(stripIds(missing.body.error.message));
      // And the not-owned response must not betray that the account exists.
      expect(foreign.body.error.message.toLowerCase()).not.toMatch(
        /forbidden|not allowed|belongs|owner|another|frozen|permission/,
      );
    });

    it('treats a system/clearing account as 404 for a customer and never lists it', async () => {
      const rows = await ds.query(
        `SELECT id FROM account WHERE kind = 'system' AND owner_id IS NULL ORDER BY system_key LIMIT 1`,
      );
      expect(rows.length).toBe(1); // seeded by the migration
      const systemId = rows[0].id;

      const owner = `sub-${randomUUID()}`;
      const own = await mkAccount({ owner_id: owner, balance: 100, held: 0 });

      const list = await asCustomer(owner, '/api/accounts');
      expect(list.status).toBe(200);
      const listedIds = list.body.accounts.map((a: any) => a.id);
      expect(listedIds).toContain(own.id); // sanity: the customer's own account IS listed
      expect(listedIds).not.toContain(systemId); // the system account is NOT

      const res = await asCustomer(owner, `/api/accounts/${systemId}/transactions`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(NOT_FOUND);
    });

    // ---- GET /api/accounts/:id/transactions: statement correctness + bound -----------

    it('returns 200 with an empty entries list for an owned account that has no ledger legs', async () => {
      const owner = `sub-${randomUUID()}`;
      const acc = await mkAccount({ owner_id: owner, balance: 0, held: 0 });

      // Owned but with ZERO ledger entries: the statement must be 200 { accountId,
      // entries: [] }, NOT 404. A "no entries => 404" regression would wrongly imply the
      // account is absent (and re-open the existence distinction the 404 path avoids).
      const res = await asCustomer(owner, `/api/accounts/${acc.id}/transactions`);
      expect(res.status).toBe(200);
      expect(res.body.accountId).toBe(acc.id);
      expect(Array.isArray(res.body.entries)).toBe(true);
      expect(res.body.entries).toEqual([]);
    });

    it("returns exactly that account's ledger legs (not another account's) with the DTO shape", async () => {
      const owner = `sub-${randomUUID()}`;
      const accX = await mkAccount({ owner_id: owner, balance: 300, held: 0 });
      const accY = await mkAccount({ owner_id: owner, balance: 500, held: 0 });
      const tx = await mkTransaction(owner);

      const x1 = await addLedgerEntry(accX.id, tx.id, { delta: 100, balanceAfter: 100 });
      const x2 = await addLedgerEntry(accX.id, tx.id, { delta: 200, balanceAfter: 300 });
      const y1 = await addLedgerEntry(accY.id, tx.id, { delta: 500, balanceAfter: 500 });

      const res = await asCustomer(owner, `/api/accounts/${accX.id}/transactions`);
      expect(res.status).toBe(200);
      expect(res.body.accountId).toBe(accX.id);

      const ids = res.body.entries.map((e: any) => e.id).sort();
      expect(ids).toEqual([x1.id, x2.id].sort()); // only X's legs
      expect(ids).not.toContain(y1.id); // Y's leg must not bleed in

      const entry = res.body.entries.find((e: any) => e.id === x2.id);
      expect(Object.keys(entry).sort()).toEqual(
        ['balanceAfter', 'createdAt', 'currency', 'delta', 'id', 'transactionId'].sort(),
      );
      expect(entry.transactionId).toBe(tx.id);
      expect(entry.delta).toBe('200');
      expect(entry.balanceAfter).toBe('300');
      expect(entry.currency).toBe('MXN');
      expect(typeof entry.createdAt).toBe('string');
      expect(entry.createdAt.length).toBeGreaterThan(0);
    });

    it('orders statement entries newest-first (created_at DESC), balance_after intact as strings', async () => {
      const owner = `sub-${randomUUID()}`;
      const acc = await mkAccount({ owner_id: owner, balance: 600, held: 0 });
      const tx = await mkTransaction(owner);

      // Insert oldest-first with explicit, well-separated timestamps; the response must be
      // reversed (newest first). Inserting in ascending order guards against an
      // implementation that returns insertion order rather than created_at DESC.
      const e1 = await addLedgerEntry(acc.id, tx.id, {
        delta: 100,
        balanceAfter: 100,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const e2 = await addLedgerEntry(acc.id, tx.id, {
        delta: 200,
        balanceAfter: 300,
        createdAt: '2026-01-02T00:00:00.000Z',
      });
      const e3 = await addLedgerEntry(acc.id, tx.id, {
        delta: 300,
        balanceAfter: 600,
        createdAt: '2026-01-03T00:00:00.000Z',
      });

      const res = await asCustomer(owner, `/api/accounts/${acc.id}/transactions`);
      expect(res.status).toBe(200);
      expect(res.body.entries.map((e: any) => e.id)).toEqual([e3.id, e2.id, e1.id]);
      expect(res.body.entries.map((e: any) => e.balanceAfter)).toEqual(['600', '300', '100']);
    });

    it('bounds the statement to a page limit of 100, returning the newest 100 legs', async () => {
      const owner = `sub-${randomUUID()}`;
      const acc = await mkAccount({ owner_id: owner, balance: 0, held: 0 });
      const tx = await mkTransaction(owner);
      // Bulk-insert 105 legs with strictly increasing created_at and balance_after = the
      // sequence number, so the returned page can be identified exactly. Registered before
      // the account/tx cleanups so LIFO removes these legs first (FK order).
      cleanups.push(() => ds.query(`DELETE FROM ledger_entry WHERE account_id = $1`, [acc.id]));
      await ds.query(
        `INSERT INTO ledger_entry (transaction_id, account_id, delta, balance_after, currency, created_at)
         SELECT $1, $2, 1, gs, 'MXN', TIMESTAMPTZ '2026-01-01T00:00:00Z' + (gs || ' seconds')::interval
           FROM generate_series(1, 105) AS gs`,
        [tx.id, acc.id],
      );

      const res = await asCustomer(owner, `/api/accounts/${acc.id}/transactions`);
      expect(res.status).toBe(200);
      expect(res.body.entries.length).toBe(100); // hard cap even though 105 exist
      // Newest-first + capped => leg 105 leads and legs 1..5 fall off the page (oldest
      // returned is leg 6).
      expect(res.body.entries[0].balanceAfter).toBe('105');
      expect(res.body.entries[res.body.entries.length - 1].balanceAfter).toBe('6');
    });

    // ---- GET /api/accounts/:id/transactions: input validation ------------------------

    it('rejects a malformed (non-UUID) account id with 400 BAD_REQUEST', async () => {
      const owner = `sub-${randomUUID()}`;
      const res = await asCustomer(owner, '/api/accounts/not-a-uuid/transactions');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(BAD_REQUEST);
    });
  },
);
