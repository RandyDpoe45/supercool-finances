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
  getAuditServiceToken,
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
  deleteAuditRowsByActor,
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
    let audit: any;

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
      audit = app.get(getAuditServiceToken(), { strict: false });
      if (!audit || typeof audit.listAudit !== 'function') {
        throw new Error(
          '[integration] resolved AUDIT_SERVICE but it lacks listAudit({ actorId?, action?, ' +
            'targetType?, targetId?, limit?, offset? }).',
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

    // =========================================================================================
    // GET /admin/audit — newest-first (created_at DESC, id DESC), exact-match filters, paging,
    // metadata round-trip, NULL-target row surfaced (NON-owner-scoped browse of the audit log).
    //
    // Driven against the REAL `AUDIT_SERVICE.listAudit(query)` (the service clamp + the repo's
    // parameterized ORDER BY / WHERE / LIMIT-OFFSET), so a wrong ordering, a lost filter, an
    // ignored offset, or a lexicographic id tiebreak FAILS here. Audit rows are seeded directly
    // (a GET writes none) with controlled `created_at`, and TWO rows sharing a `created_at` so the
    // numeric bigint `id DESC` tiebreak is observable. Cleaned up per-test by actor id.
    // =========================================================================================

    // A locally-scoped audit-row seeder (there is no shared insertAuditRow helper): a parameterized
    // INSERT ... RETURNING, with `metadata` written as a JSON string so Postgres parses text → jsonb
    // (the read-back deep-equals the seeded object). `id` is DB-generated (bigint identity → the
    // insertion order IS the id order); `created_at` is settable so ordering is deterministic.
    let auditActors: string[] = [];
    async function seedAudit(row: {
      actorId: string;
      action: string;
      targetType?: string | null;
      targetId?: string | null;
      metadata?: Record<string, unknown> | null;
      createdAt?: Date;
    }): Promise<{ id: string; created_at: Date }> {
      if (!auditActors.includes(row.actorId)) auditActors.push(row.actorId);
      const res = await ds.query(
        `INSERT INTO "audit_log" (actor_id, action, target_type, target_id, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id, created_at`,
        [
          row.actorId,
          row.action,
          row.targetType ?? null,
          row.targetId ?? null,
          row.metadata === undefined || row.metadata === null ? null : JSON.stringify(row.metadata),
          row.createdAt ?? new Date(),
        ],
      );
      return res[0];
    }

    afterEach(async () => {
      const actors = auditActors;
      auditActors = [];
      try {
        await deleteAuditRowsByActor(ds, actors);
      } catch {
        /* best-effort; random actor ids keep re-runs safe */
      }
    });

    /** Assert a returned page respects `created_at DESC, id DESC` (numeric bigint tiebreak): each row
     * is no newer than the one before it, and among equal timestamps the id strictly DECREASES as a
     * BigInt — a lexicographic or ascending tiebreak fails this. */
    function expectNewestFirst(rows: any[]): void {
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const cur = rows[i];
        const prevT = new Date(prev.createdAt).getTime();
        const curT = new Date(cur.createdAt).getTime();
        expect(prevT).toBeGreaterThanOrEqual(curT);
        if (prevT === curT) {
          expect(BigInt(prev.id) > BigInt(cur.id)).toBe(true);
        }
      }
    }

    it('orders newest-first (created_at DESC, id DESC) — a shared-timestamp pair proves the numeric bigint tiebreak', async () => {
      const actor = `admin-${randomUUID()}`;
      const base = new Date('2026-01-01T00:00:00.000Z');
      const T0 = new Date(base.getTime());
      const T1 = new Date(base.getTime() + 60_000);
      const T2 = new Date(base.getTime() + 120_000);

      const oldest = await seedAudit({ actorId: actor, action: 'account.freeze', createdAt: T0 });
      // TWO rows sharing created_at T1; the SECOND insert gets the higher (numerically larger) id.
      const tieEarlier = await seedAudit({
        actorId: actor,
        action: 'account.unfreeze',
        createdAt: T1,
      });
      const tieLater = await seedAudit({
        actorId: actor,
        action: 'limits.change',
        createdAt: T1,
      });
      const newest = await seedAudit({
        actorId: actor,
        action: 'external.inbound.simulated',
        createdAt: T2,
      });

      expect(BigInt(tieLater.id) > BigInt(tieEarlier.id)).toBe(true); // sanity: later insert → higher id

      const rows = await audit.listAudit({ actorId: actor, limit: 50, offset: 0 });
      const order = rows.map((r: any) => r.id);
      // Exactly our four, newest-first; the T1 tie resolves to the higher-id (later-inserted) row FIRST.
      expect(order).toEqual([newest.id, tieLater.id, tieEarlier.id, oldest.id]);
      expectNewestFirst(rows);
    }, 30_000);

    it('applies exact-match filters (actorId / action / targetType); an unmatched value → empty', async () => {
      const actorA = `admin-${randomUUID()}`;
      const actorB = `admin-${randomUUID()}`;

      const aFreeze = await seedAudit({
        actorId: actorA,
        action: 'account.freeze',
        targetType: 'account',
        targetId: 'acc-A1',
      });
      const aLimits = await seedAudit({
        actorId: actorA,
        action: 'limits.change',
        targetType: 'user_limits',
        targetId: 'lim-A1',
      });
      const bFreeze = await seedAudit({
        actorId: actorB,
        action: 'account.freeze',
        targetType: 'account',
        targetId: 'acc-B1',
      });

      // actorId → ONLY actorA's rows (never actorB's) — a non-owner-scoped log still filters exactly.
      const byActor = await audit.listAudit({ actorId: actorA, limit: 50, offset: 0 });
      const byActorIds = byActor.map((r: any) => r.id);
      expect(byActorIds).toEqual(expect.arrayContaining([aFreeze.id, aLimits.id]));
      expect(byActorIds).not.toContain(bFreeze.id);
      expect(byActor.every((r: any) => r.actorId === actorA)).toBe(true);

      // action → ONLY 'limits.change' among actorA's rows (excludes the freeze).
      const byAction = await audit.listAudit({
        actorId: actorA,
        action: 'limits.change',
        limit: 50,
      });
      expect(byAction.map((r: any) => r.id)).toEqual([aLimits.id]);
      expect(byAction.every((r: any) => r.action === 'limits.change')).toBe(true);

      // targetType → both actors' 'account' rows carry targetType 'account'; scope to actorA to
      // keep the assertion deterministic across a shared DB.
      const byTarget = await audit.listAudit({
        actorId: actorA,
        targetType: 'account',
        limit: 50,
      });
      expect(byTarget.map((r: any) => r.id)).toEqual([aFreeze.id]);
      expect(byTarget.every((r: any) => r.targetType === 'account')).toBe(true);

      // An unmatched exact value → empty.
      const none = await audit.listAudit({
        actorId: actorA,
        action: 'reversal.executed',
        limit: 50,
      });
      expect(none).toEqual([]);
    }, 30_000);

    it('paginates by limit/offset — disjoint pages that concatenate to a prefix of the full order; over-large limit clamps', async () => {
      const actor = `admin-${randomUUID()}`;
      const base = new Date('2026-02-01T00:00:00.000Z');
      // Seed 5 rows with STRICTLY increasing created_at → a total, deterministic newest-first order.
      const seeded: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await seedAudit({
          actorId: actor,
          action: 'account.freeze',
          createdAt: new Date(base.getTime() + i * 60_000),
        });
        seeded.push(r.id);
      }
      const newestFirst = [...seeded].reverse(); // i=4 (latest) first

      const full = await audit.listAudit({ actorId: actor, limit: 50, offset: 0 });
      expect(full.map((r: any) => r.id)).toEqual(newestFirst);

      const page1 = await audit.listAudit({ actorId: actor, limit: 2, offset: 0 });
      const page2 = await audit.listAudit({ actorId: actor, limit: 2, offset: 2 });
      const p1 = page1.map((r: any) => r.id);
      const p2 = page2.map((r: any) => r.id);
      expect(p1).toHaveLength(2);
      expect(p2).toHaveLength(2);
      // Disjoint (offset genuinely skipped page 1) AND the two pages are the first-4 prefix in order.
      expect(p2.every((id: string) => !p1.includes(id))).toBe(true);
      expect([...p1, ...p2]).toEqual(newestFirst.slice(0, 4));

      // The service clamps an over-large limit to ≤ 200 (no unbounded scan); our rows are still there.
      const huge = await audit.listAudit({ actorId: actor, limit: 5000, offset: 0 });
      expect(huge.length).toBeLessThanOrEqual(200);
      expect(huge.map((r: any) => r.id)).toEqual(expect.arrayContaining(seeded));
    }, 30_000);

    it('round-trips a jsonb metadata blob intact and surfaces a NULL-target / NULL-metadata row (non-owner-scoped — nothing filtered out)', async () => {
      const actor = `admin-${randomUUID()}`;
      const metadata = {
        before: { status: 'active', dailyMax: '20000' },
        after: { status: 'frozen', dailyMax: '5000' },
        nested: { list: [1, 2, 3], flag: true },
      };
      const withMeta = await seedAudit({
        actorId: actor,
        action: 'limits.change',
        targetType: 'user_limits',
        targetId: 'lim-1',
        metadata,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      });
      // A row with NO target and NO metadata (the polymorphic pointer may be absent) — a
      // non-owner-scoped read must still return it, not silently drop it.
      const nullTarget = await seedAudit({
        actorId: actor,
        action: 'account.freeze',
        targetType: null,
        targetId: null,
        metadata: null,
        createdAt: new Date('2026-03-01T00:01:00.000Z'),
      });

      const rows = await audit.listAudit({ actorId: actor, limit: 50, offset: 0 });
      const byId = new Map(rows.map((r: any) => [r.id, r]));

      const metaRow: any = byId.get(withMeta.id);
      expect(metaRow).toBeTruthy();
      expect(metaRow.metadata).toEqual(metadata); // jsonb parsed back to the exact object

      const nullRow: any = byId.get(nullTarget.id);
      expect(nullRow).toBeTruthy();
      expect(nullRow.targetType).toBeNull();
      expect(nullRow.targetId).toBeNull();
      expect(nullRow.metadata).toBeNull();
    }, 30_000);
  },
);
