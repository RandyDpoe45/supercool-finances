/**
 * Spec 04 — Balance Service: customer self-service account creation (`POST /api/accounts`),
 * the DoD money-safety proofs that are only meaningful against REAL Postgres.
 *
 * Written FROM spec 04 (Modules "Accounts", the `POST /api/accounts` description, and the DoD
 * "Customer self-service account creation" item), NOT from the implementation. The suite drives the
 * REAL AppModule over HTTP with supertest — through the gateway identity guard, the exception filter,
 * and the request-id middleware — so a wrong implementation FAILS a test here.
 *
 * The headline DoD proofs:
 *   - PER-CUSTOMER CAP (5) HOLDS UNDER CONCURRENCY — the per-owner advisory lock. Fire N concurrent
 *     creates for ONE owner where N exceeds the headroom: EXACTLY the headroom succeed, the rest 422,
 *     and the owner NEVER ends with more than 5 customer accounts. (Proven both from the boundary —
 *     4 existing, 5 concurrent → 1 succeeds — and from empty — 8 concurrent → 5 succeed.)
 *   - MONEY-SAFETY: a fresh account is minted at balance/held/available all "0" and the create writes
 *     NO ledger / transaction / outbox / audit row (a self-service create moves no money).
 *   - OWNER SCOPING: the created account is owned by the CALLER (X-User-Id), appears in the caller's
 *     GET /api/accounts and NOT another user's; a body smuggling `ownerId` is rejected (400).
 *   - ACCOUNT NUMBER: a unique 10-digit numeric string per create, distinct across many creates.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a false
 * pass), TCP-probe Postgres in beforeAll (fail loud if unreachable), boot the real AppModule
 * (migrationsRun:true). Unique random owners per test; committed rows cleaned up per-test.
 * jest.config.ts serializes the integration run (maxWorkers:1).
 *
 * To run:
 *   BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=…] npm test
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { getAccountsServiceToken, getAppModule, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import { insertRow, insertCustomer, localAccountNumber, TODAY, MONTH_START } from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED account-creation suite: set BALANCE_INTEGRATION=1 (and point DB_* at a ' +
      'reachable Postgres) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');

const suite = ENABLED ? describe : describe.skip;

/** Spec-locked per-customer cap. */
const MAX_CUSTOMER_ACCOUNTS = 5;

suite(
  'POST /api/accounts — cap under concurrency, money-safety, owner scoping (integration, needs Postgres)',
  () => {
    let app: INestApplication;
    let ds: any;
    let http: any;

    // Owners created per test; their accounts + audit rows + customer row are swept afterEach.
    const seededOwners = new Set<string>();

    beforeAll(async () => {
      const reachable = await tcpProbe(DB_HOST, DB_PORT);
      if (!reachable) {
        throw new Error(
          `[integration] BALANCE_INTEGRATION=1 but Postgres is not reachable at ${DB_HOST}:${DB_PORT}. ` +
            `Bring up the compose datastores (and point DB_HOST/DB_PORT at them) or unset BALANCE_INTEGRATION.`,
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
        OTP_HASH_SECRET: process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789',
      });
      for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

      const AppModule = getAppModule();
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
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
      const owners = Array.from(seededOwners);
      seededOwners.clear();
      if (!owners.length) return;
      // FK-safe order: audit rows (polymorphic pointer, no cascade), then accounts, then customers.
      try {
        await ds.query(`DELETE FROM "audit_log" WHERE "actor_id" = ANY($1)`, [owners]);
      } catch {
        /* best-effort */
      }
      try {
        await ds.query(`DELETE FROM "account" WHERE "owner_id" = ANY($1)`, [owners]);
      } catch {
        /* best-effort */
      }
      try {
        await ds.query(`DELETE FROM "customer" WHERE "id" = ANY($1)`, [owners]);
      } catch {
        /* best-effort */
      }
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    // ---- helpers -----------------------------------------------------------------------------

    async function newOwner(): Promise<string> {
      const owner = `sub-${randomUUID()}`;
      await insertCustomer(ds, owner);
      seededOwners.add(owner);
      return owner;
    }

    /** Directly seed a committed customer account for `owner` (bypassing the endpoint) so a test can
     * position the owner AT a given count before firing concurrent creates. */
    async function seedAccount(owner: string): Promise<any> {
      return insertRow(ds, 'account', {
        owner_id: owner,
        kind: 'customer',
        currency: 'MXN',
        status: 'active',
        balance: 0,
        held: 0,
        account_number: localAccountNumber(),
        spent_today_date: TODAY,
        spent_month_date: MONTH_START,
      });
    }

    const createFor = (owner: string, body: unknown) =>
      request(http)
        .post('/api/accounts')
        .set('X-User-Id', owner)
        .set('X-Roles', 'customer')
        .send(body as object);

    const listFor = (owner: string) =>
      request(http).get('/api/accounts').set('X-User-Id', owner).set('X-Roles', 'customer');

    async function dbCustomerAccountCount(owner: string): Promise<number> {
      const rows = await ds.query(
        `SELECT COUNT(*)::int AS count FROM "account" WHERE "owner_id" = $1 AND "kind" = 'customer'`,
        [owner],
      );
      return rows[0].count as number;
    }

    // ---- money-safety: mint at 0, no ledger/tx/outbox/audit ----------------------------------

    it('201 mints a customer account at balance/held/available "0" (MXN/active/customer) with a 10-digit number + trimmed label', async () => {
      const owner = await newOwner();

      const res = await createFor(owner, { label: '  Vacation Fund  ' });
      expect(res.status).toBe(201);

      const dto = res.body;
      expect(Object.keys(dto).sort()).toEqual(
        [
          'accountNumber',
          'available',
          'balance',
          'currency',
          'held',
          'id',
          'kind',
          'label',
          'status',
        ].sort(),
      );
      // MONEY-SAFETY: a self-service create can never seed funds.
      expect(dto.balance).toBe('0');
      expect(dto.held).toBe('0');
      expect(dto.available).toBe('0');
      expect(dto.currency).toBe('MXN');
      expect(dto.status).toBe('active');
      expect(dto.kind).toBe('customer');
      expect(dto.accountNumber).toMatch(/^\d{10}$/);
      // The label is TRIMMED before storage.
      expect(dto.label).toBe('Vacation Fund');
      // Anti-leak: the owner sub never crosses the wire.
      expect(JSON.stringify(dto)).not.toContain(owner);
    });

    it('the create writes NO ledger / transaction / outbox / audit row (moves no money)', async () => {
      const owner = await newOwner();

      const res = await createFor(owner, { label: 'No Money Moved' });
      expect(res.status).toBe(201);
      const accountId = res.body.id;

      // No ledger legs for the new account (nothing was posted).
      const ledger = await ds.query(
        `SELECT COUNT(*)::int AS count FROM "ledger_entry" WHERE "account_id" = $1`,
        [accountId],
      );
      expect(ledger[0].count).toBe(0);

      // A create initiates NO transaction (so, transitively, no outbox row can reference one).
      const txs = await ds.query(
        `SELECT COUNT(*)::int AS count FROM "transaction" WHERE "initiated_by" = $1`,
        [owner],
      );
      expect(txs[0].count).toBe(0);

      // No outbox row references the account's (absent) transaction; assert none exist for it.
      const outbox = await ds.query(
        `SELECT COUNT(*)::int AS count FROM "outbox_event" oe
           JOIN "ledger_entry" le ON le."transaction_id" = oe."transaction_id"
          WHERE le."account_id" = $1`,
        [accountId],
      );
      expect(outbox[0].count).toBe(0);

      // No audit row for the create (self-service creation is NOT an audited admin action).
      const audit = await ds.query(
        `SELECT COUNT(*)::int AS count FROM "audit_log"
          WHERE "actor_id" = $1 OR "target_id" = $2`,
        [owner, accountId],
      );
      expect(audit[0].count).toBe(0);
    });

    // ---- owner scoping (anti-IDOR) + smuggled ownerId ----------------------------------------

    it('the created account is owned by the caller: it appears in the caller GET and NOT another user GET', async () => {
      const ownerA = await newOwner();
      const ownerB = await newOwner();

      const created = await createFor(ownerA, { label: 'A-owned' });
      expect(created.status).toBe(201);
      const id = created.body.id;

      const listA = await listFor(ownerA);
      expect(listA.status).toBe(200);
      expect(listA.body.accounts.map((a: any) => a.id)).toContain(id);

      const listB = await listFor(ownerB);
      expect(listB.status).toBe(200);
      // B never sees A's freshly-created account (owner scoping / anti-IDOR).
      expect(listB.body.accounts.map((a: any) => a.id)).not.toContain(id);
    });

    it('rejects a body that smuggles an ownerId (400) — the owner is taken only from X-User-Id', async () => {
      const owner = await newOwner();
      const attacker = `sub-${randomUUID()}`;

      const res = await createFor(owner, { label: 'ok', ownerId: attacker });
      // The `.strict()` schema rejects the extra key outright.
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');

      // And nothing was created for either the caller or the smuggled owner.
      expect(await dbCustomerAccountCount(owner)).toBe(0);
    });

    it('rejects an empty label (400) and creates nothing', async () => {
      const owner = await newOwner();
      const res = await createFor(owner, { label: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(await dbCustomerAccountCount(owner)).toBe(0);
    });

    // ---- fail-closed: a caller with no `customer` row (the owner_id FK precondition) ----------

    it('rejects an owner with NO customer row: a clean CUSTOMER_NOT_FOUND domain error (not a raw 23503/500), and inserts nothing', async () => {
      // Drive the service directly against live PG — the raw FK (`fk_account_owner`) fires here, so
      // this proves the create surfaces it as the clean domain 404 rather than leaking a
      // QueryFailedError (23503 → a 500). Deliberately do NOT seed a customer for this owner.
      const accountsService = app.get(getAccountsServiceToken(), { strict: false });
      const orphanOwner = `sub-${randomUUID()}`;
      seededOwners.add(orphanOwner); // tracked for cleanup, though nothing should be created

      let error: any;
      try {
        await accountsService.createAccount(orphanOwner, { label: 'x' });
      } catch (e) {
        error = e;
      }

      expect(error).toBeDefined();
      // Fail-closed as the stable domain code — the code→HTTP map turns this into a 404.
      expect(error?.code).toBe('CUSTOMER_NOT_FOUND');
      // Explicitly NOT a raw Postgres FK violation surfacing as a 500.
      expect(error?.constructor?.name).not.toBe('QueryFailedError');
      expect(error?.code).not.toBe('23503');

      // Nothing was inserted for the orphan owner (the precondition tripped before the INSERT).
      expect(await dbCustomerAccountCount(orphanOwner)).toBe(0);
    });

    // ---- account-number uniqueness across many creates ---------------------------------------

    it('assigns a distinct 10-digit account number to every created account', async () => {
      const owner = await newOwner();
      for (let i = 0; i < MAX_CUSTOMER_ACCOUNTS; i += 1) {
        const res = await createFor(owner, { label: `acct-${i}` });
        expect(res.status).toBe(201);
      }

      const list = await listFor(owner);
      expect(list.status).toBe(200);
      const numbers = list.body.accounts.map((a: any) => a.accountNumber);
      expect(numbers.length).toBe(MAX_CUSTOMER_ACCOUNTS);
      for (const n of numbers) expect(n).toMatch(/^\d{10}$/);
      // All distinct — the generator + the uq_account_account_number index keep them unique.
      expect(new Set(numbers).size).toBe(numbers.length);
    });

    // ---- the cap holds under concurrency (headline DoD proof) --------------------------------

    it('CAP UNDER CONCURRENCY (boundary): owner with 4 accounts, 5 concurrent creates → exactly ONE 201 reaching 5, the rest 422', async () => {
      const owner = await newOwner();
      for (let i = 0; i < 4; i += 1) await seedAccount(owner);
      expect(await dbCustomerAccountCount(owner)).toBe(4);

      // Fire 5 concurrent creates: there is headroom for exactly ONE.
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => createFor(owner, { label: `race-${i}` })),
      );
      const statuses = results.map((r) => r.status);
      const created = statuses.filter((s) => s === 201).length;
      const rejected = results.filter((r) => r.status === 422);

      expect(created).toBe(1);
      expect(rejected.length).toBe(4);
      for (const r of rejected) expect(r.body.error.code).toBe('ACCOUNT_LIMIT_REACHED');

      // The invariant that matters: the owner NEVER exceeds the cap.
      expect(await dbCustomerAccountCount(owner)).toBe(MAX_CUSTOMER_ACCOUNTS);
    });

    it('CAP UNDER CONCURRENCY (bulk): from empty, 8 concurrent creates → EXACTLY 5 succeed, 3 are 422, owner never exceeds 5', async () => {
      const owner = await newOwner();

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => createFor(owner, { label: `bulk-${i}` })),
      );
      const created = results.filter((r) => r.status === 201);
      const rejected = results.filter((r) => r.status === 422);

      // No response is anything other than a clean 201 or a clean 422 (no 500 from a lost race).
      const other = results.filter((r) => r.status !== 201 && r.status !== 422);
      expect(other.map((r) => r.status)).toEqual([]);

      expect(created.length).toBe(MAX_CUSTOMER_ACCOUNTS);
      expect(rejected.length).toBe(3);
      for (const r of rejected) expect(r.body.error.code).toBe('ACCOUNT_LIMIT_REACHED');

      // Money-safety on the whole batch: no more than 5 customer accounts exist, and every one of the
      // five is at balance 0 (no funds were created by any winner of the race).
      expect(await dbCustomerAccountCount(owner)).toBe(MAX_CUSTOMER_ACCOUNTS);
      const balances = await ds.query(
        `SELECT DISTINCT "balance"::text AS balance FROM "account" WHERE "owner_id" = $1`,
        [owner],
      );
      expect(balances.map((b: any) => b.balance)).toEqual(['0']);

      // And the five winners all carry distinct account numbers.
      const nums = created.map((r) => r.body.accountNumber);
      expect(new Set(nums).size).toBe(MAX_CUSTOMER_ACCOUNTS);
    });
  },
);
