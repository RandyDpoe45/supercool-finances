/**
 * Spec 04 — Balance Service, step 8a: the SINGLE-ACTOR `/admin` HTTP surface end-to-end over
 * supertest, booting the REAL AppModule (global gateway identity guard — which enforces the `admin`
 * role on `/admin` — + the exception filter + zod validation + the request-id middleware). Written
 * FROM the developer-locked HTTP contract (spec 04 "/admin Endpoints" bullet + "Admin ops" module
 * bullet + DoD), NOT from the implementor's code.
 *
 * Endpoints under test (single-actor only — maker-checker / reversals are step 8b, NOT here):
 *   POST /admin/accounts/:id/freeze | /unfreeze   → 200; flips account status; audits freeze/unfreeze
 *   PUT  /admin/limits  { scope, ownerId?, currency, perTransactionMax?, dailyMax?, monthlyMax? }
 *                                                  → 200; upserts baseline/override; audits limits.change
 *   GET  /admin/transactions  (filters + pagination) → 200; view ANY transaction (NOT owner-scoped); a read
 *   POST /admin/external/inbound { accountNumber, amount, currency, externalRef }
 *                                                  → 200; simulated inbound credit; idempotent by externalRef
 *
 * It proves at the HTTP edge:
 *   - ROLE GATING: `/admin/*` with NO X-User-Id → 401; WITH X-User-Id but WITHOUT the `admin` role
 *     → 403; WITH the `admin` role → 200.
 *   - FREEZE ties to the reducer's frozen-debit rule: freeze → a customer transfer debiting it is
 *     rejected (409 ACCOUNT_FROZEN, no money moves); unfreeze → the debit works again; and a CREDIT
 *     to a frozen account still succeeds (a freeze blocks debits only).
 *   - PUT /limits TAKES EFFECT: a tight per-customer cap makes an over-cap transfer 422 LIMIT_EXCEEDED;
 *     scope validation (customer without ownerId / global with ownerId) → 400.
 *   - GET /transactions returns transactions the caller does NOT own (admin sees ANY); filters +
 *     pagination narrow the result.
 *   - SIMULATED inbound credits the customer and is idempotent by externalRef; unknown account → 404.
 *   - AUDIT-ON-EVERY-MUTATION over the real surface: freeze, PUT /limits, and simulated inbound each
 *     leave exactly one audit_log row with the right action; a GET writes none.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (Postgres AND Redis — the transfer confirm path needs
 * both). beforeAll TCP-probes both and fails loud if unreachable; boots AppModule (migrationsRun:true).
 * Unique owners/accounts/admins per test; committed rows + audit rows + minted OTP keys cleaned up.
 *
 * To run:
 *   BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=… REDIS_HOST=… REDIS_PORT=…] npm run test:e2e
 */
import 'reflect-metadata';
import { createHmac, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { getAppModule, getRedisClientToken, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import {
  insertRow,
  insertCustomer,
  insertTransaction,
  localAccountNumber,
  getAccountStatus,
  getAuditRows,
  countAuditRows,
  deleteAuditRowsByActor,
  TODAY,
  MONTH_START,
} from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[e2e] SKIPPED admin single-actor HTTP suite: set BALANCE_INTEGRATION=1 (and point DB_* at ' +
      'Postgres AND REDIS_* at Redis) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789';
const MXN = 'MXN';

// Developer-locked audit `action` constants (spec 04 step 8a brief).
const ACTION_FREEZE = 'account.freeze';
const ACTION_LIMITS = 'limits.change';
const ACTION_SIM_INBOUND = 'external.inbound.simulated';

const suite = ENABLED ? describe : describe.skip;

suite(
  'admin single-actor HTTP surface (step 8a) — role gating, freeze, limits, listing, inbound, audit (e2e, needs Postgres + Redis)',
  () => {
    let app: INestApplication;
    let ds: any;
    let redis: any;
    let http: any;

    let createdAccountIds: string[] = [];
    let trackedOwners: string[] = [];
    let trackedAdmins: string[] = [];
    let trackedRedisKeys: string[] = [];

    beforeAll(async () => {
      const [pgOk, redisOk] = await Promise.all([
        tcpProbe(DB_HOST, DB_PORT),
        tcpProbe(REDIS_HOST, REDIS_PORT),
      ]);
      if (!pgOk) throw new Error(`[e2e] Postgres not reachable at ${DB_HOST}:${DB_PORT}.`);
      if (!redisOk) throw new Error(`[e2e] Redis not reachable at ${REDIS_HOST}:${REDIS_PORT}.`);

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
        OTP_HASH_SECRET,
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
      if (!ds) throw new Error('[e2e] could not resolve the TypeORM DataSource from the app');

      redis = app.get(getRedisClientToken(), { strict: false });
    }, 60_000);

    afterEach(async () => {
      const ids = createdAccountIds;
      const owners = trackedOwners;
      const admins = trackedAdmins;
      const redisKeys = Array.from(new Set(trackedRedisKeys));
      createdAccountIds = [];
      trackedOwners = [];
      trackedAdmins = [];
      trackedRedisKeys = [];
      if (redis && redisKeys.length) {
        try {
          await redis.del(...redisKeys);
        } catch {
          /* best-effort */
        }
      }
      try {
        await cleanup(ids, owners, admins);
      } catch {
        /* best-effort */
      }
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    // ---- helpers ----------------------------------------------------------------------------

    function newOwner(): string {
      const o = `sub-${randomUUID()}`;
      trackedOwners.push(o);
      return o;
    }
    function newAdmin(): string {
      const a = `admin-${randomUUID()}`;
      trackedAdmins.push(a);
      return a;
    }

    async function mkCustomer(
      owner: string,
      overrides: Record<string, unknown> = {},
    ): Promise<any> {
      const {
        name,
        phone,
        email,
        account_number: numberOverride,
        ...accountOverrides
      } = overrides as any;
      await insertCustomer(ds, owner, { name, phone, email });
      const accountNumber = (numberOverride as string) ?? localAccountNumber();
      const acc = await insertRow(ds, 'account', {
        kind: 'customer',
        owner_id: owner,
        currency: MXN,
        status: 'active',
        balance: 0,
        held: 0,
        account_number: accountNumber,
        spent_today_date: TODAY,
        spent_month_date: MONTH_START,
        ...accountOverrides,
      });
      createdAccountIds.push(acc.id);
      acc.account_number = acc.account_number ?? accountNumber;
      return acc;
    }

    async function cleanup(ids: string[], owners: string[], admins: string[]): Promise<void> {
      await deleteAuditRowsByActor(ds, admins);
      if (ids.length || owners.length) {
        const txRows = await ds.query(
          `SELECT id FROM "transaction"
          WHERE debit_account_id = ANY($1) OR credit_account_id = ANY($1) OR initiated_by = ANY($2)
          UNION SELECT DISTINCT transaction_id AS id FROM ledger_entry WHERE account_id = ANY($1)
          UNION SELECT DISTINCT transaction_id AS id FROM hold WHERE account_id = ANY($1)`,
          [ids, owners],
        );
        const txIds = txRows.map((r: any) => r.id);
        if (txIds.length) {
          await ds.query(`DELETE FROM idempotency_key WHERE transaction_id = ANY($1)`, [txIds]);
          await ds.query(`DELETE FROM outbox_event WHERE transaction_id = ANY($1)`, [txIds]);
          await ds.query(`DELETE FROM hold WHERE transaction_id = ANY($1)`, [txIds]);
          await ds.query(`DELETE FROM ledger_entry WHERE transaction_id = ANY($1)`, [txIds]);
          await ds.query(`DELETE FROM "transaction" WHERE id = ANY($1)`, [txIds]);
        }
      }
      if (owners.length) {
        await ds.query(`DELETE FROM idempotency_key WHERE owner_id = ANY($1)`, [owners]);
        await ds.query(`DELETE FROM user_limits WHERE owner_id = ANY($1)`, [owners]);
      }
      if (ids.length) await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
      if (owners.length) await ds.query(`DELETE FROM customer WHERE id = ANY($1)`, [owners]);
    }

    const asUser = (userId: string) => ({
      post: (path: string) =>
        request(http).post(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
      put: (path: string) =>
        request(http).put(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
      get: (path: string) =>
        request(http).get(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
    });
    const asAdmin = (adminId: string) => ({
      post: (path: string) =>
        request(http).post(path).set('X-User-Id', adminId).set('X-Roles', 'admin'),
      put: (path: string) =>
        request(http).put(path).set('X-User-Id', adminId).set('X-Roles', 'admin'),
      get: (path: string) =>
        request(http).get(path).set('X-User-Id', adminId).set('X-Roles', 'admin'),
    });

    function expectErrorDto(body: any, code?: string): void {
      expect(body).toBeDefined();
      expect(body.error).toBeDefined();
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
      if (code !== undefined) expect(body.error.code).toBe(code);
    }

    // The customer-side transfer flow (resolve → initiate → OTP → confirm), reused by the freeze +
    // limits proofs. Returns the confirm response so a caller can assert its status/body.
    async function resolveDest(owner: string, accountNumber: string) {
      const res = await asUser(owner)
        .post('/api/transfers/resolve-destination')
        .send({ accountNumber });
      if (res.body?.confirmationToken) {
        trackedRedisKeys.push(`xfer:confirm:${owner}:${res.body.confirmationToken}`);
      }
      return res;
    }
    async function initiate(owner: string, sourceId: string, dst: any, amount: number) {
      const resolved = await resolveDest(owner, dst.account_number);
      return asUser(owner)
        .post('/api/transfers')
        .set('Idempotency-Key', `key-${randomUUID()}`)
        .send({
          sourceAccountId: sourceId,
          destinationAccountNumber: dst.account_number,
          amount: String(amount),
          currency: MXN,
          confirmationToken: resolved.body?.confirmationToken,
        });
    }
    async function mintOtp(owner: string): Promise<string | undefined> {
      const res = await asUser(owner).post('/api/otp').send({});
      const code = res.body?.code ?? res.body?.otp?.code;
      if (code) {
        trackedRedisKeys.push(`otp:${owner}`);
        trackedRedisKeys.push(
          `otp:${owner}:${createHmac('sha256', OTP_HASH_SECRET).update(`${owner}:${code}`).digest('hex')}`,
        );
      }
      return code;
    }
    function idOf(body: any): string {
      const t = body?.transfer ?? body?.transaction ?? body;
      return (t?.id ?? t?.transferId ?? t?.transactionId) as string;
    }
    /** resolve → initiate → OTP → confirm; returns the confirm HTTP response. */
    async function transferAndConfirm(owner: string, sourceId: string, dst: any, amount: number) {
      const created = await initiate(owner, sourceId, dst, amount);
      expect(created.status).toBe(201);
      const transferId = idOf(created.body);
      const code = await mintOtp(owner);
      return asUser(owner).post(`/api/transfers/${transferId}/confirm`).send({ code });
    }

    function listOf(body: any): any[] {
      if (Array.isArray(body)) return body;
      return body?.transactions ?? body?.items ?? body?.data ?? [];
    }

    // =========================================================================================
    // ROLE GATING — /admin requires the admin role (representative route: GET /admin/transactions)
    // =========================================================================================

    it('GET /admin/transactions: no X-User-Id → 401; X-User-Id without the admin role → 403; with admin → 200', async () => {
      // No gateway identity at all → 401.
      const anon = await request(http).get('/admin/transactions');
      expect(anon.status).toBe(401);

      // A gateway identity WITHOUT the admin role → 403.
      const nonAdmin = await request(http)
        .get('/admin/transactions')
        .set('X-User-Id', newOwner())
        .set('X-Roles', 'customer');
      expect(nonAdmin.status).toBe(403);
      expectErrorDto(nonAdmin.body, 'FORBIDDEN');

      // WITH the admin role → 200.
      const admin = await asAdmin(newAdmin()).get('/admin/transactions');
      expect(admin.status).toBe(200);
    });

    it('the mutating admin routes are equally role-gated: freeze / PUT limits / simulated inbound reject a non-admin with 403', async () => {
      const owner = newOwner();
      const acc = await mkCustomer(owner, { balance: 1000 });

      const freeze = await asUser(owner).post(`/admin/accounts/${acc.id}/freeze`).send({});
      expect(freeze.status).toBe(403);

      const put = await asUser(owner)
        .put('/admin/limits')
        .send({ scope: 'global', currency: MXN, perTransactionMax: '5000' });
      expect(put.status).toBe(403); // the role gate denies before the handler runs

      const inbound = await asUser(owner).post('/admin/external/inbound').send({
        accountNumber: acc.account_number,
        amount: '100',
        currency: MXN,
        externalRef: 'r',
      });
      expect(inbound.status).toBe(403);

      // The freeze/inbound attempts by a non-admin left the account untouched + wrote no audit.
      expect(await getAccountStatus(ds, acc.id)).toBe('active');
      expect(await countAuditRows(ds, { actorId: owner })).toBe(0);
    });

    // =========================================================================================
    // FREEZE end-to-end — ties the admin action to the reducer's frozen-debit rule + audits
    // =========================================================================================

    it('freeze → a customer debit is rejected (409 ACCOUNT_FROZEN, no money moves) → unfreeze → the debit works; freeze audits account.freeze', async () => {
      const admin = newAdmin();
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const dst = await mkCustomer(newOwner(), { balance: 0 });

      // FREEZE via the admin surface.
      const frozen = await asAdmin(admin).post(`/admin/accounts/${src.id}/freeze`).send({});
      expect(frozen.status).toBe(200);
      expect(await getAccountStatus(ds, src.id)).toBe('frozen');
      // Exactly one audit row for the freeze, attributed to the acting admin.
      const freezeAudit = await getAuditRows(ds, { action: ACTION_FREEZE, targetId: src.id });
      expect(freezeAudit).toHaveLength(1);
      expect(freezeAudit[0].actor_id).toBe(admin);

      // A customer transfer DEBITING the frozen account is rejected at confirm (post time).
      const blocked = await transferAndConfirm(owner, src.id, dst, 4000);
      expect(blocked.status).toBe(409);
      expectErrorDto(blocked.body, 'ACCOUNT_FROZEN');
      // No money moved.
      const balBlocked = await ds.query(`SELECT id, balance FROM account WHERE id = ANY($1)`, [
        [src.id, dst.id],
      ]);
      const byId = new Map<string, string>(balBlocked.map((r: any) => [r.id, r.balance]));
      expect(byId.get(src.id)).toBe('10000');
      expect(byId.get(dst.id)).toBe('0');

      // UNFREEZE, then a debit succeeds again. Use a DIFFERENT amount (3000, not the blocked 4000)
      // so it is a fresh fingerprint — the blocked attempt left a same-fingerprint idempotency record
      // within the 60s soft-duplicate window, and a repeat 4000 would (correctly) be SUSPECTED_DUPLICATE.
      // The new initiate auto-supersedes the stuck PENDING from the frozen attempt.
      const unfrozen = await asAdmin(admin).post(`/admin/accounts/${src.id}/unfreeze`).send({});
      expect(unfrozen.status).toBe(200);
      expect(await getAccountStatus(ds, src.id)).toBe('active');

      const ok = await transferAndConfirm(owner, src.id, dst, 3000);
      expect(ok.status).toBe(200);
      const balOk = await ds.query(`SELECT id, balance FROM account WHERE id = ANY($1)`, [
        [src.id, dst.id],
      ]);
      const byId2 = new Map<string, string>(balOk.map((r: any) => [r.id, r.balance]));
      expect(byId2.get(src.id)).toBe('7000'); // 10000 − 3000 (the frozen 4000 attempt never moved money)
      expect(byId2.get(dst.id)).toBe('3000');
    }, 60_000);

    it('a CREDIT to a frozen account still succeeds (a freeze blocks debits only): simulated inbound credits a frozen customer', async () => {
      const admin = newAdmin();
      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 0 });

      await asAdmin(admin).post(`/admin/accounts/${cust.id}/freeze`).send({});
      expect(await getAccountStatus(ds, cust.id)).toBe('frozen');

      const credit = await asAdmin(admin)
        .post('/admin/external/inbound')
        .send({
          accountNumber: cust.account_number,
          amount: '2500',
          currency: MXN,
          externalRef: `rail-ref-${randomUUID()}`,
        });
      // The simulated inbound is a POST creating a credit transaction — a 2xx success (the spec does
      // not lock 200 vs 201; assert success + the money observable rather than an arbitrary code).
      expect([200, 201]).toContain(credit.status);

      const row = await ds.query(`SELECT balance, status FROM account WHERE id = $1`, [cust.id]);
      expect(row[0].balance).toBe('2500'); // credited despite the freeze
      expect(row[0].status).toBe('frozen'); // the credit did not thaw it
    }, 30_000);

    it('freezing a SYSTEM/clearing account is rejected (409 ACCOUNT_NOT_FREEZABLE): no status change, no audit row', async () => {
      const admin = newAdmin();
      // A seeded clearing (system) account — freeze applies to customer accounts only.
      const sys = await ds.query(
        `SELECT id, status FROM account WHERE kind = 'system' ORDER BY system_key LIMIT 1`,
      );
      expect(sys[0]?.id).toBeTruthy(); // the migration seeds clearing:rail-inbound / clearing:rail-outbound
      const sysId = sys[0].id as string;
      const statusBefore = sys[0].status as string;

      const res = await asAdmin(admin).post(`/admin/accounts/${sysId}/freeze`).send({});
      expect(res.status).toBe(409);
      expectErrorDto(res.body, 'ACCOUNT_NOT_FREEZABLE');

      // Nothing half-applied: the system account's status is unchanged and NO audit row was written
      // (mirrors the missing-account transactional-audit assertions).
      expect(await getAccountStatus(ds, sysId)).toBe(statusBefore);
      expect(await countAuditRows(ds, { targetId: sysId })).toBe(0);
      expect(await countAuditRows(ds, { actorId: admin, action: ACTION_FREEZE })).toBe(0);
    }, 30_000);

    // =========================================================================================
    // PUT /limits — takes effect + scope validation + audits limits.change
    // =========================================================================================

    it('PUT /admin/limits sets a tight per-customer cap that TAKES EFFECT: an over-cap transfer → 422 LIMIT_EXCEEDED; the upsert audits limits.change', async () => {
      const admin = newAdmin();
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 1000000 });
      const dst = await mkCustomer(newOwner(), { balance: 0 });

      const put = await asAdmin(admin).put('/admin/limits').send({
        scope: 'customer',
        ownerId: owner,
        currency: MXN,
        perTransactionMax: '5000',
        dailyMax: '1000000',
        monthlyMax: '10000000',
      });
      expect(put.status).toBe(200);
      // The upsert wrote exactly one limits.change audit row.
      expect(await countAuditRows(ds, { actorId: admin, action: ACTION_LIMITS })).toBe(1);

      // A transfer over the per-transaction cap is rejected at confirm, under the lock.
      const over = await transferAndConfirm(owner, src.id, dst, 5001); // 5001 > 5000
      expect(over.status).toBe(422);
      expectErrorDto(over.body, 'LIMIT_EXCEEDED');
      // No money moved (rejected before any balance mutation).
      const bal = await ds.query(`SELECT balance FROM account WHERE id = $1`, [src.id]);
      expect(bal[0].balance).toBe('1000000');

      // A transfer UNDER the cap posts — proving the cap is a ceiling, not a blanket block.
      const under = await transferAndConfirm(owner, src.id, dst, 4000);
      expect(under.status).toBe(200);
      const bal2 = await ds.query(`SELECT balance FROM account WHERE id = $1`, [src.id]);
      expect(bal2[0].balance).toBe('996000');
    }, 60_000);

    it('PUT /admin/limits scope validation: customer WITHOUT ownerId → 400; global WITH an ownerId → 400 (no row written)', async () => {
      const admin = newAdmin();
      const owner = newOwner();

      const customerNoOwner = await asAdmin(admin)
        .put('/admin/limits')
        .send({ scope: 'customer', currency: MXN, perTransactionMax: '5000' });
      expect(customerNoOwner.status).toBe(400);

      const globalWithOwner = await asAdmin(admin)
        .put('/admin/limits')
        .send({ scope: 'global', ownerId: owner, currency: MXN, perTransactionMax: '5000' });
      expect(globalWithOwner.status).toBe(400);

      // Neither malformed request wrote a customer override row for the owner.
      const rows = await ds.query(
        `SELECT count(*)::int AS n FROM user_limits WHERE owner_id = $1`,
        [owner],
      );
      expect(rows[0].n).toBe(0);
    });

    // =========================================================================================
    // GET /admin/transactions — admin sees ANY transaction (NOT owner-scoped) + filters + pagination
    // NOTE: the filter/pagination QUERY-PARAM SPELLINGS (ownerId / status / limit / offset) are the
    // conventional REST names ASSUMED from the DTO shape — flagged to confirm with the developer.
    // =========================================================================================

    it('GET /admin/transactions returns a transaction NOT owned by the caller (admin sees ANY, not owner-scoped)', async () => {
      const admin = newAdmin();
      const owner = newOwner(); // the transaction's owner, DIFFERENT from the admin caller
      const src = await mkCustomer(owner, { balance: 5000 });
      const seeded = await insertTransaction(ds, {
        type: 'internal',
        status: 'POSTED',
        initiatedBy: owner,
        debitAccountId: src.id,
        creditAccountId: null,
        amount: '1234',
        currency: MXN,
        postedAt: new Date(),
      });

      const res = await asAdmin(admin).get('/admin/transactions').query({ ownerId: owner });
      expect(res.status).toBe(200);
      const list = listOf(res.body);
      const found = list.find((t: any) => (t.id ?? t.transactionId) === seeded.id);
      expect(found).toBeTruthy();
      // The row belongs to `owner`, NOT the admin caller — the admin view is not owner-scoped.
      expect(found.initiatedBy ?? found.ownerId ?? owner).toBe(owner);
      // Whitelist / serialized shape: the intended admin fields are present and it is a plain object.
      expect(typeof found).toBe('object');
      expect(String(found.status)).toBe('POSTED');
      expect(String(found.amount)).toBe('1234');
    }, 30_000);

    it('GET /admin/transactions filters by status and paginates (limit/offset bound the page)', async () => {
      const admin = newAdmin();
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 100000 });
      // Seed 3 POSTED + 1 PENDING for this owner.
      const posted: string[] = [];
      for (let i = 0; i < 3; i++) {
        const t = await insertTransaction(ds, {
          type: 'internal',
          status: 'POSTED',
          initiatedBy: owner,
          debitAccountId: src.id,
          creditAccountId: null,
          amount: String(1000 + i),
          currency: MXN,
          postedAt: new Date(Date.now() + i),
        });
        posted.push(t.id);
      }
      const pending = await insertTransaction(ds, {
        type: 'internal',
        status: 'PENDING',
        initiatedBy: owner,
        debitAccountId: src.id,
        creditAccountId: null,
        amount: '9999',
        currency: MXN,
        expiresAt: new Date(Date.now() + 120_000),
      });

      // Filter by status=POSTED for this owner → the 3 posted, never the PENDING one.
      const postedRes = await asAdmin(admin)
        .get('/admin/transactions')
        .query({ ownerId: owner, status: 'POSTED' });
      expect(postedRes.status).toBe(200);
      const postedIds = listOf(postedRes.body).map((t: any) => t.id ?? t.transactionId);
      for (const id of posted) expect(postedIds).toContain(id);
      expect(postedIds).not.toContain(pending.id);

      // Filter by status=PENDING → the pending one, never the posted ones.
      const pendingRes = await asAdmin(admin)
        .get('/admin/transactions')
        .query({ ownerId: owner, status: 'PENDING' });
      expect(pendingRes.status).toBe(200);
      const pendingIds = listOf(pendingRes.body).map((t: any) => t.id ?? t.transactionId);
      expect(pendingIds).toContain(pending.id);
      for (const id of posted) expect(pendingIds).not.toContain(id);

      // Pagination: limit=2 over this owner's POSTED set returns at most 2, and offset shifts the page.
      const page1 = await asAdmin(admin)
        .get('/admin/transactions')
        .query({ ownerId: owner, status: 'POSTED', limit: 2, offset: 0 });
      expect(page1.status).toBe(200);
      expect(listOf(page1.body).length).toBeLessThanOrEqual(2);

      const page2 = await asAdmin(admin)
        .get('/admin/transactions')
        .query({ ownerId: owner, status: 'POSTED', limit: 2, offset: 2 });
      expect(page2.status).toBe(200);
      const p1 = listOf(page1.body).map((t: any) => t.id ?? t.transactionId);
      const p2 = listOf(page2.body).map((t: any) => t.id ?? t.transactionId);
      // The two pages do not overlap (offset genuinely skipped the first page).
      expect(p2.every((id: string) => !p1.includes(id))).toBe(true);
    }, 45_000);

    it('GET /admin/transactions is a READ: it writes no audit row for the calling admin', async () => {
      const admin = newAdmin();
      await asAdmin(admin).get('/admin/transactions').query({ limit: 10 });
      expect(await countAuditRows(ds, { actorId: admin })).toBe(0);
    });

    // =========================================================================================
    // POST /admin/external/inbound — simulated inbound: credits once, idempotent by ref, audits
    // =========================================================================================

    it('POST /admin/external/inbound credits the customer and audits external.inbound.simulated; a duplicate externalRef does NOT double-credit', async () => {
      const admin = newAdmin();
      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 0 });
      const externalRef = `rail-ref-${randomUUID()}`;

      const first = await asAdmin(admin)
        .post('/admin/external/inbound')
        .send({ accountNumber: cust.account_number, amount: '3000', currency: MXN, externalRef });
      expect([200, 201]).toContain(first.status); // 2xx success (spec does not lock 200 vs 201)
      let bal = await ds.query(`SELECT balance FROM account WHERE id = $1`, [cust.id]);
      expect(bal[0].balance).toBe('3000');
      // The simulated inbound is a mutating admin action → at least one audit row (checked here,
      // before the idempotent replay below which may add another).
      expect(await countAuditRows(ds, { actorId: admin, action: ACTION_SIM_INBOUND })).toBe(1);

      // Replaying the SAME rail ref must not credit again (idempotent by externalRef).
      const dup = await asAdmin(admin)
        .post('/admin/external/inbound')
        .send({ accountNumber: cust.account_number, amount: '3000', currency: MXN, externalRef });
      expect([200, 201]).toContain(dup.status); // idempotent ack, not an error
      bal = await ds.query(`SELECT balance FROM account WHERE id = $1`, [cust.id]);
      expect(bal[0].balance).toBe('3000'); // credited ONCE

      // A DISTINCT ref credits again (idempotency is per-ref).
      const second = await asAdmin(admin)
        .post('/admin/external/inbound')
        .send({
          accountNumber: cust.account_number,
          amount: '1500',
          currency: MXN,
          externalRef: `rail-ref-${randomUUID()}`,
        });
      expect([200, 201]).toContain(second.status);
      bal = await ds.query(`SELECT balance FROM account WHERE id = $1`, [cust.id]);
      expect(bal[0].balance).toBe('4500');
    }, 30_000);

    it('POST /admin/external/inbound to an unknown account number → 404 (no credit anywhere)', async () => {
      const admin = newAdmin();
      const missing = localAccountNumber(); // a well-formed 10-digit number enrolled to no account
      const res = await asAdmin(admin)
        .post('/admin/external/inbound')
        .send({
          accountNumber: missing,
          amount: '1000',
          currency: MXN,
          externalRef: `rail-ref-${randomUUID()}`,
        });
      expect(res.status).toBe(404);
      expectErrorDto(res.body);
    });
  },
);
