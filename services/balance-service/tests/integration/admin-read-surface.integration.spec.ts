/**
 * Spec 04 — Balance Service, `/admin` READ surface: the THREE non-owner-scoped, role-gated LIST reads
 *   1. GET /admin/accounts   — view ANY owner's accounts (filter + paging)
 *   2. GET /admin/limits     — the global baseline + per-customer overrides (scope / ownerId filter)
 *   3. GET /admin/approvals  — the checker's queue (status filter; PENDING is the default)
 *
 * driven against the REAL DI'd services (`ACCOUNTS_SERVICE` / `LIMITS_SERVICE` / `APPROVAL_SERVICE`,
 * resolved BY TOKEN through a booted AppModule) with real Postgres. Written FROM spec 04's "/admin
 * Endpoints" bullet (view ANY account/limits/approval, NOT owner-scoped, "reads do not [audit]") + the
 * developer-locked contract, NOT from the implementor's code. A wrong implementation FAILS here:
 *
 *   - accounts: an owner-scoped list (leaking only one owner, or scoping to the caller) fails the
 *     "spans multiple owners" + "ownerId narrows to exactly one owner" proofs; a paging bug (offset
 *     ignored) fails the non-overlapping-pages proof; a float-lossy balance fails the round-trip.
 *   - limits: a read that dropped the global baseline, or that ignored the scope/ownerId filter, fails.
 *   - approvals: a read that dropped the PENDING default (so an unfiltered call returns the wrong
 *     queue), or ignored the status filter, fails.
 *   - ANY of these three writing an audit row on a read (they must not) fails the audit-delta==0 proof.
 *
 * Why DB-backed and not mocked: "any owner's accounts", "the seeded global baseline is returned",
 * "offset genuinely skips", and "a read appends NO audit row" are properties of the REAL parameterized
 * queries + the migration-seeded baseline — mocking them would mock away the logic under test. Every
 * assertion gates on OBSERVABLE STATE (returned entity ids / fields, audit-row delta).
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a false
 * pass). beforeAll TCP-probes BOTH Postgres and Redis (the app boots both) and fails loud if
 * unreachable; boots the real AppModule (migrationsRun:true → MXN + clearing accounts + the seeded
 * global limits baseline). jest.config serializes the integration run (maxWorkers:1). Unique
 * account/owner/tx ids per test; committed rows cleaned up per-test.
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
  getApprovalServiceToken,
  getApprovalStatus,
  getUserLimitsScope,
  tcpProbe,
} from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import {
  insertAccount,
  insertUserLimits,
  insertApprovalRow,
  insertTransaction,
  countAuditRows,
  deleteApprovalsByTarget,
  localAccountNumber,
  TODAY,
  MONTH_START,
} from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED admin read-surface suite: set BALANCE_INTEGRATION=1 (and point DB_* at ' +
      'Postgres AND REDIS_* at Redis — the app boots both) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const MXN = 'MXN';

const ApprovalStatus = getApprovalStatus();
const UserLimitsScope = getUserLimitsScope();

const suite = ENABLED ? describe : describe.skip;

suite(
  'admin READ surface (/admin accounts · limits · approvals) — non-owner-scoped, filtered, no audit (integration, needs Postgres + Redis)',
  () => {
    let app: INestApplication;
    let ds: any;
    let accounts: any;
    let limits: any;
    let approvals: any;

    let createdAccountIds: string[] = [];
    let trackedOwners: string[] = [];
    let createdTxIds: string[] = [];

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
      if (!accounts || typeof accounts.listAccounts !== 'function') {
        throw new Error(
          '[integration] resolved ACCOUNTS_SERVICE but it lacks listAccounts({ ownerId?, limit?, offset? }).',
        );
      }
      limits = app.get(getLimitsServiceToken(), { strict: false });
      if (!limits || typeof limits.listLimits !== 'function') {
        throw new Error(
          '[integration] resolved LIMITS_SERVICE but it lacks listLimits({ scope?, ownerId? }).',
        );
      }
      approvals = app.get(getApprovalServiceToken(), { strict: false });
      if (!approvals || typeof approvals.listApprovals !== 'function') {
        throw new Error(
          '[integration] resolved APPROVAL_SERVICE but it lacks listApprovals({ status? }).',
        );
      }
    }, 60_000);

    afterEach(async () => {
      const ids = createdAccountIds;
      const owners = trackedOwners;
      const txIds = createdTxIds;
      createdAccountIds = [];
      trackedOwners = [];
      createdTxIds = [];
      try {
        if (txIds.length) {
          await deleteApprovalsByTarget(ds, txIds);
          await ds.query(`DELETE FROM "transaction" WHERE id = ANY($1)`, [txIds]);
        }
        if (owners.length) {
          await ds.query(`DELETE FROM user_limits WHERE owner_id = ANY($1)`, [owners]);
        }
        if (ids.length) await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
        if (owners.length) await ds.query(`DELETE FROM customer WHERE id = ANY($1)`, [owners]);
      } catch {
        /* best-effort; random ids keep re-runs safe */
      }
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    // ---- seed helpers -----------------------------------------------------------------------

    function newOwner(): string {
      const o = `sub-${randomUUID()}`;
      trackedOwners.push(o);
      return o;
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

    const idsOf = (rows: any[]): string[] => rows.map((r) => r.id);

    // =========================================================================================
    // GET /admin/accounts — NON-owner-scoped (any owner), ownerId narrows, balance round-trips
    // =========================================================================================

    it('lists accounts across MULTIPLE owners (non-owner-scoped); ownerId narrows to exactly one owner; balance/held round-trip; no audit row', async () => {
      const ownerA = newOwner();
      const ownerB = newOwner();
      const a1 = await mkAccount(ownerA, { balance: '123400', held: '400' });
      const a2 = await mkAccount(ownerA, { balance: 2000, held: 0 });
      const b1 = await mkAccount(ownerB, { balance: 9999, held: 0 });

      const auditBefore = await countAuditRows(ds);

      // Unfiltered: the admin view spans BOTH owners (it is NOT scoped to any single owner).
      const all = await accounts.listAccounts({});
      const allIds = idsOf(all);
      expect(allIds).toEqual(expect.arrayContaining([a1.id, a2.id, b1.id]));

      // The surface's DEFINING property: being non-owner-scoped, it ALSO surfaces the migration-
      // seeded system/clearing accounts (owner_id NULL). A regression adding `WHERE owner_id IS
      // NOT NULL` would still pass every customer-owner proof above, but fail HERE.
      expect(all.some((r: any) => r.ownerId === null && r.kind !== 'customer')).toBe(true);

      // ownerId filter narrows to EXACTLY ownerA's two accounts — never ownerB's.
      const onlyA = await accounts.listAccounts({ ownerId: ownerA });
      expect(idsOf(onlyA).sort()).toEqual([a1.id, a2.id].sort());
      expect(idsOf(onlyA)).not.toContain(b1.id);

      // A seeded balance/held round-trips as the exact minor-unit string (no float coercion).
      const a1Row = onlyA.find((r: any) => r.id === a1.id);
      expect(a1Row.balance).toBe('123400');
      expect(a1Row.held).toBe('400');

      // Both reads wrote NO audit row.
      expect(await countAuditRows(ds)).toBe(auditBefore);
    }, 30_000);

    it('paginates by limit/offset — two consecutive pages of one owner do NOT overlap; no audit row', async () => {
      const owner = newOwner();
      const seeded: string[] = [];
      for (let i = 0; i < 5; i++) {
        const acc = await mkAccount(owner, { balance: 1000 + i });
        seeded.push(acc.id);
      }

      const auditBefore = await countAuditRows(ds);

      const page1 = await accounts.listAccounts({ ownerId: owner, limit: 2, offset: 0 });
      const page2 = await accounts.listAccounts({ ownerId: owner, limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);

      const p1 = idsOf(page1);
      const p2 = idsOf(page2);
      // The two pages are disjoint (offset genuinely skipped the first page) and both are this
      // owner's accounts — a paging bug that ignored offset would return the same page twice.
      expect(p2.every((id) => !p1.includes(id))).toBe(true);
      for (const id of [...p1, ...p2]) expect(seeded).toContain(id);

      expect(await countAuditRows(ds)).toBe(auditBefore);
    }, 30_000);

    // =========================================================================================
    // GET /admin/limits — global baseline + customer override; scope / ownerId narrow
    // =========================================================================================

    it('returns the seeded GLOBAL baseline AND a customer override unfiltered; scope/ownerId narrow; no audit row', async () => {
      const owner = newOwner();
      const override = await insertUserLimits(ds, {
        scope: 'customer',
        ownerId: owner,
        currency: MXN,
        perTransactionMax: '5000',
        dailyMax: '20000',
        monthlyMax: '100000',
      });

      const auditBefore = await countAuditRows(ds);

      // Unfiltered: BOTH a global baseline row (seeded by migration, ownerId null) AND the customer
      // override are present.
      const all = await limits.listLimits({});
      expect(idsOf(all)).toContain(override.id);
      const globals = all.filter((r: any) => r.scope === UserLimitsScope.Global);
      expect(globals.length).toBeGreaterThanOrEqual(1);
      expect(globals.every((r: any) => r.ownerId === null)).toBe(true);

      // scope: 'customer' → ONLY customer-scope rows (the global baseline is excluded), incl. ours.
      const customerRows = await limits.listLimits({ scope: 'customer' });
      expect(customerRows.every((r: any) => r.scope === UserLimitsScope.Customer)).toBe(true);
      expect(idsOf(customerRows)).toContain(override.id);

      // ownerId → ONLY that owner's row(s).
      const byOwner = await limits.listLimits({ ownerId: owner });
      expect(byOwner.every((r: any) => r.ownerId === owner)).toBe(true);
      expect(idsOf(byOwner)).toContain(override.id);

      expect(await countAuditRows(ds)).toBe(auditBefore);
    }, 30_000);

    // =========================================================================================
    // GET /admin/approvals — PENDING is the default; status filter narrows
    // =========================================================================================

    it('DEFAULTS to the PENDING queue when no status is given; an explicit status returns that status; no audit row', async () => {
      const pendingTarget = await mkTargetTx();
      const rejectedTarget = await mkTargetTx();
      const makerP = `admin-${randomUUID()}`;
      const makerR = `admin-${randomUUID()}`;
      const checkerR = `admin-${randomUUID()}`;

      const pending = await insertApprovalRow(ds, {
        makerId: makerP,
        targetTransactionId: pendingTarget.id,
        status: 'PENDING',
      });
      const rejected = await insertApprovalRow(ds, {
        makerId: makerR,
        checkerId: checkerR, // four-eyes CHECK: checker <> maker
        targetTransactionId: rejectedTarget.id,
        status: 'REJECTED',
      });

      const auditBefore = await countAuditRows(ds);

      // No status → the PENDING default (the checker's queue). Our pending row is present; every
      // returned row is PENDING; the rejected row is absent. A dropped default would surface the
      // rejected row (or an empty/wrong queue).
      const defaulted = await approvals.listApprovals({});
      expect(idsOf(defaulted)).toContain(pending.id);
      expect(defaulted.every((r: any) => r.status === ApprovalStatus.Pending)).toBe(true);
      expect(idsOf(defaulted)).not.toContain(rejected.id);

      // Explicit status passes through: REJECTED returns our rejected row, never the pending one.
      const rejectedList = await approvals.listApprovals({ status: ApprovalStatus.Rejected });
      expect(idsOf(rejectedList)).toContain(rejected.id);
      expect(rejectedList.every((r: any) => r.status === ApprovalStatus.Rejected)).toBe(true);
      expect(idsOf(rejectedList)).not.toContain(pending.id);

      expect(await countAuditRows(ds)).toBe(auditBefore);
    }, 30_000);
  },
);
