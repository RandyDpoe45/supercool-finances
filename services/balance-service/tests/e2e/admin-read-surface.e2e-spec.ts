/**
 * Spec 04 — Balance Service, `/admin` READ surface end-to-end over supertest, booting the REAL
 * AppModule (global gateway identity guard — which enforces the `admin` role on `/admin` — + the
 * exception filter + zod query validation + the request-id middleware). The three list reads:
 *   GET /admin/accounts   → 200 { accounts: AdminAccountDto[] }   (view ANY owner; filter + paging)
 *   GET /admin/limits     → 200 { limits: LimitsDto[] }           (global baseline + overrides; filter)
 *   GET /admin/approvals  → 200 { approvals: ApprovalRequestDto[] }(checker queue; PENDING default)
 *
 * Written FROM the developer-locked HTTP contract (spec 04 "/admin Endpoints" bullet + DoD), NOT from
 * the implementor's code. It proves at the HTTP edge:
 *   - ROLE GATING: each `/admin/*` read with NO X-User-Id → 401; WITH X-User-Id but WITHOUT the
 *     `admin` role → 403; WITH the `admin` role → 200.
 *   - ENVELOPE + FILTERS: the `{ accounts } | { limits } | { approvals }` envelope; the `ownerId` /
 *     `scope` / `status` filters narrow; accounts paginates by `limit`/`offset` (non-overlapping pages)
 *     with COERCED string numerics; the PENDING default on approvals.
 *   - STRICT VALIDATION: an unknown query key → 400 (`.strict()`); a negative `limit` → 400
 *     (wire `nonnegative`); an out-of-enum `scope` / `status` → 400.
 *   - READS ARE AUDIT-FREE: each GET leaves the calling admin's audit-row count at 0.
 *   - ANTI-LEAK (whitelist serializer): the account objects carry NO `systemKey` / `spentToday` /
 *     `spentMonth`; the approval objects carry NO `payload`. A serializer that spread the entity would
 *     leak these and FAIL — proving the whitelist is not bypassed.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (Postgres AND Redis — the app boots both). beforeAll
 * TCP-probes both and fails loud if unreachable; boots AppModule (migrationsRun:true). Unique
 * owners/accounts/admins/tx per test; committed rows cleaned up.
 *
 * To run:
 *   BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=… REDIS_HOST=… REDIS_PORT=…] npm run test:e2e
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { getAppModule, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import {
  insertAccount,
  insertUserLimits,
  insertApprovalRow,
  insertTransaction,
  countAuditRows,
  deleteApprovalsByTarget,
  deleteAuditRowsByActor,
  localAccountNumber,
  TODAY,
  MONTH_START,
} from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[e2e] SKIPPED admin read-surface HTTP suite: set BALANCE_INTEGRATION=1 (and point DB_* at ' +
      'Postgres AND REDIS_* at Redis) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const MXN = 'MXN';

const suite = ENABLED ? describe : describe.skip;

suite(
  'admin READ surface HTTP (/admin accounts · limits · approvals) — gating, envelope, filters, strict, anti-leak (e2e, needs Postgres + Redis)',
  () => {
    let app: INestApplication;
    let ds: any;
    let http: any;

    let createdAccountIds: string[] = [];
    let trackedOwners: string[] = [];
    let trackedAdmins: string[] = [];
    let createdTxIds: string[] = [];

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
      if (!ds) throw new Error('[e2e] could not resolve the TypeORM DataSource from the app');
    }, 60_000);

    afterEach(async () => {
      const ids = createdAccountIds;
      const owners = trackedOwners;
      const admins = trackedAdmins;
      const txIds = createdTxIds;
      createdAccountIds = [];
      trackedOwners = [];
      trackedAdmins = [];
      createdTxIds = [];
      try {
        await deleteAuditRowsByActor(ds, admins);
        if (txIds.length) {
          await deleteApprovalsByTarget(ds, txIds);
          await ds.query(`DELETE FROM "transaction" WHERE id = ANY($1)`, [txIds]);
        }
        if (owners.length)
          await ds.query(`DELETE FROM user_limits WHERE owner_id = ANY($1)`, [owners]);
        if (ids.length) await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
        if (owners.length) await ds.query(`DELETE FROM customer WHERE id = ANY($1)`, [owners]);
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

    async function mkAccount(owner: string, overrides: Record<string, unknown> = {}): Promise<any> {
      const acc = await insertAccount(ds, {
        kind: 'customer',
        owner_id: owner,
        currency: MXN,
        status: 'active',
        balance: 0,
        held: 0,
        account_number: localAccountNumber(),
        spent_today_date: TODAY,
        spent_month_date: MONTH_START,
        ...overrides,
      });
      createdAccountIds.push(acc.id);
      return acc;
    }

    async function mkTargetTx(): Promise<any> {
      const tx = await insertTransaction(ds, { type: 'internal', status: 'POSTED', currency: MXN });
      createdTxIds.push(tx.id);
      return tx;
    }

    const asUser = (userId: string) => ({
      get: (path: string) =>
        request(http).get(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
    });
    const asAdmin = (adminId: string) => ({
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

    // =========================================================================================
    // ROLE GATING — every /admin read requires the admin role (401 anon / 403 non-admin / 200 admin)
    // =========================================================================================

    it.each(['/admin/accounts', '/admin/limits', '/admin/approvals'])(
      'GET %s: no X-User-Id → 401; a non-admin identity → 403; admin → 200',
      async (path) => {
        const anon = await request(http).get(path);
        expect(anon.status).toBe(401);

        const nonAdmin = await asUser(newOwner()).get(path);
        expect(nonAdmin.status).toBe(403);
        expectErrorDto(nonAdmin.body, 'FORBIDDEN');

        const admin = await asAdmin(newAdmin()).get(path);
        expect(admin.status).toBe(200);
      },
    );

    // =========================================================================================
    // GET /admin/accounts — envelope, ownerId filter, paging, strict validation, anti-leak, no audit
    // =========================================================================================

    it('GET /admin/accounts: { accounts } envelope, ownerId filter, DTO shape + derived available, and NO leaked internal fields', async () => {
      const admin = newAdmin();
      const owner = newOwner();
      // A distinctive spent_today so a spread-leak of the counter is caught by VALUE too, not just key.
      const acc = await mkAccount(owner, { balance: '5000', held: '1500', spent_today: '7777' });

      const res = await asAdmin(admin).get('/admin/accounts').query({ ownerId: owner });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.accounts)).toBe(true);
      // ownerId-scoped → exactly this owner's single account.
      expect(res.body.accounts).toHaveLength(1);
      const dto = res.body.accounts[0];

      // Admin whitelist shape (deliberately exposes ownerId + timestamps).
      expect(Object.keys(dto).sort()).toEqual(
        [
          'accountNumber',
          'available',
          'balance',
          'createdAt',
          'currency',
          'held',
          'id',
          'kind',
          'ownerId',
          'status',
          'updatedAt',
        ].sort(),
      );
      expect(dto.id).toBe(acc.id);
      expect(dto.ownerId).toBe(owner);
      // Money as canonical minor-unit strings; available derived = balance − held.
      expect(dto.balance).toBe('5000');
      expect(dto.held).toBe('1500');
      expect(dto.available).toBe('3500');

      // ANTI-LEAK: the whitelist serializer must NOT surface the internal counters or system key.
      expect(dto).not.toHaveProperty('systemKey');
      expect(dto).not.toHaveProperty('spentToday');
      expect(dto).not.toHaveProperty('spentMonth');
      expect(dto).not.toHaveProperty('spentTodayDate');
      expect(dto).not.toHaveProperty('spentMonthDate');
      expect(JSON.stringify(dto)).not.toContain('7777'); // the seeded counter value never rides along
    }, 30_000);

    it('GET /admin/accounts: paginates with COERCED string limit/offset — consecutive pages do not overlap', async () => {
      const admin = newAdmin();
      const owner = newOwner();
      const seeded: string[] = [];
      for (let i = 0; i < 5; i++) seeded.push((await mkAccount(owner, { balance: 100 + i })).id);

      // Query params arrive as strings; the coercion schema turns them into numbers.
      const page1 = await asAdmin(admin)
        .get('/admin/accounts')
        .query({ ownerId: owner, limit: '2', offset: '0' });
      const page2 = await asAdmin(admin)
        .get('/admin/accounts')
        .query({ ownerId: owner, limit: '2', offset: '2' });
      expect(page1.status).toBe(200);
      expect(page2.status).toBe(200);
      expect(page1.body.accounts).toHaveLength(2);
      expect(page2.body.accounts).toHaveLength(2);

      const p1 = page1.body.accounts.map((a: any) => a.id);
      const p2 = page2.body.accounts.map((a: any) => a.id);
      expect(p2.every((id: string) => !p1.includes(id))).toBe(true);
      for (const id of [...p1, ...p2]) expect(seeded).toContain(id);
    }, 30_000);

    it('GET /admin/accounts: an over-large limit is ACCEPTED (service clamps, not the wire); an unknown key or a negative limit → 400', async () => {
      const admin = newAdmin();

      // The wire schema leaves limit UNBOUNDED (the service clamps to 200) — a huge limit is a 200,
      // never a 400.
      const huge = await asAdmin(admin).get('/admin/accounts').query({ limit: '5000' });
      expect(huge.status).toBe(200);
      expect(Array.isArray(huge.body.accounts)).toBe(true);
      expect(huge.body.accounts.length).toBeLessThanOrEqual(200); // clamp holds even on a large table

      // `.strict()` rejects an unknown query key.
      const unknown = await asAdmin(admin).get('/admin/accounts').query({ foo: 'bar' });
      expect(unknown.status).toBe(400);
      expectErrorDto(unknown.body);

      // A negative limit fails the wire `nonnegative` coercion (400, not a silent clamp).
      const negative = await asAdmin(admin).get('/admin/accounts').query({ limit: '-1' });
      expect(negative.status).toBe(400);
    }, 30_000);

    it('GET /admin/accounts is a READ: it writes no audit row for the calling admin', async () => {
      const admin = newAdmin();
      await asAdmin(admin).get('/admin/accounts').query({ limit: '10' });
      expect(await countAuditRows(ds, { actorId: admin })).toBe(0);
    });

    // =========================================================================================
    // GET /admin/limits — envelope, scope/ownerId filters, strict validation, no audit
    // =========================================================================================

    it('GET /admin/limits: { limits } envelope, scope and ownerId filters narrow; strict/enum validation', async () => {
      const admin = newAdmin();
      const owner = newOwner();
      const override = await insertUserLimits(ds, {
        scope: 'customer',
        ownerId: owner,
        currency: MXN,
        perTransactionMax: '5000',
        dailyMax: '20000',
        monthlyMax: '100000',
      });

      // Unfiltered: our override plus at least the seeded global baseline.
      const all = await asAdmin(admin).get('/admin/limits');
      expect(all.status).toBe(200);
      expect(Array.isArray(all.body.limits)).toBe(true);
      const mine = all.body.limits.find((r: any) => r.id === override.id);
      expect(mine).toBeTruthy();
      // DTO shape (whitelist) + money caps as strings.
      expect(Object.keys(mine).sort()).toEqual(
        [
          'createdAt',
          'currency',
          'dailyMax',
          'id',
          'monthlyMax',
          'ownerId',
          'perTransactionMax',
          'scope',
          'updatedAt',
        ].sort(),
      );
      expect(mine.scope).toBe('customer');
      expect(mine.ownerId).toBe(owner);
      expect(mine.perTransactionMax).toBe('5000');
      expect(all.body.limits.some((r: any) => r.scope === 'global' && r.ownerId === null)).toBe(
        true,
      );

      // scope=customer → only customer-scope rows.
      const customer = await asAdmin(admin).get('/admin/limits').query({ scope: 'customer' });
      expect(customer.status).toBe(200);
      expect(customer.body.limits.every((r: any) => r.scope === 'customer')).toBe(true);
      expect(customer.body.limits.some((r: any) => r.id === override.id)).toBe(true);

      // ownerId → only that owner's row(s).
      const byOwner = await asAdmin(admin).get('/admin/limits').query({ ownerId: owner });
      expect(byOwner.status).toBe(200);
      expect(byOwner.body.limits.every((r: any) => r.ownerId === owner)).toBe(true);

      // strict: unknown key → 400; enum: an out-of-range scope → 400.
      const unknown = await asAdmin(admin).get('/admin/limits').query({ foo: 'bar' });
      expect(unknown.status).toBe(400);
      const badScope = await asAdmin(admin).get('/admin/limits').query({ scope: 'bogus' });
      expect(badScope.status).toBe(400);
    }, 30_000);

    it('GET /admin/limits is a READ: it writes no audit row for the calling admin', async () => {
      const admin = newAdmin();
      await asAdmin(admin).get('/admin/limits');
      expect(await countAuditRows(ds, { actorId: admin })).toBe(0);
    });

    // =========================================================================================
    // GET /admin/approvals — PENDING default, status filter, strict validation, anti-leak, no audit
    // =========================================================================================

    it('GET /admin/approvals: { approvals } envelope, PENDING default + status filter, and NO leaked payload', async () => {
      const admin = newAdmin();
      const pendingTarget = await mkTargetTx();
      const rejectedTarget = await mkTargetTx();
      const makerP = `admin-${randomUUID()}`;
      const makerR = `admin-${randomUUID()}`;
      const checkerR = `admin-${randomUUID()}`;

      const pending = await insertApprovalRow(ds, {
        makerId: makerP,
        targetTransactionId: pendingTarget.id,
        status: 'PENDING',
        payload: { secret: 'do-not-leak' },
      });
      const rejected = await insertApprovalRow(ds, {
        makerId: makerR,
        checkerId: checkerR,
        targetTransactionId: rejectedTarget.id,
        status: 'REJECTED',
      });

      // No status → the PENDING default (the checker's queue).
      const def = await asAdmin(admin).get('/admin/approvals');
      expect(def.status).toBe(200);
      expect(Array.isArray(def.body.approvals)).toBe(true);
      const defIds = def.body.approvals.map((a: any) => a.id);
      expect(defIds).toContain(pending.id);
      expect(defIds).not.toContain(rejected.id);
      expect(def.body.approvals.every((a: any) => a.status === 'PENDING')).toBe(true);

      // DTO shape (whitelist) + ANTI-LEAK: the internal `payload` snapshot never rides the wire.
      const mine = def.body.approvals.find((a: any) => a.id === pending.id);
      expect(Object.keys(mine).sort()).toEqual(
        [
          'actionType',
          'checkerId',
          'createdAt',
          'decidedAt',
          'executedAt',
          'id',
          'makerId',
          'status',
          'targetTransactionId',
        ].sort(),
      );
      expect(mine).not.toHaveProperty('payload');
      expect(JSON.stringify(mine)).not.toContain('do-not-leak');

      // status=REJECTED → our rejected row, never the pending one.
      const rej = await asAdmin(admin).get('/admin/approvals').query({ status: 'REJECTED' });
      expect(rej.status).toBe(200);
      const rejIds = rej.body.approvals.map((a: any) => a.id);
      expect(rejIds).toContain(rejected.id);
      expect(rejIds).not.toContain(pending.id);
      expect(rej.body.approvals.every((a: any) => a.status === 'REJECTED')).toBe(true);

      // strict: unknown key → 400; enum: an out-of-range status → 400.
      const unknown = await asAdmin(admin).get('/admin/approvals').query({ foo: 'bar' });
      expect(unknown.status).toBe(400);
      const badStatus = await asAdmin(admin).get('/admin/approvals').query({ status: 'BOGUS' });
      expect(badStatus.status).toBe(400);
    }, 30_000);

    it('GET /admin/approvals is a READ: it writes no audit row for the calling admin', async () => {
      const admin = newAdmin();
      await asAdmin(admin).get('/admin/approvals');
      expect(await countAuditRows(ds, { actorId: admin })).toBe(0);
    });
  },
);
