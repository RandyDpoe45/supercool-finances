/**
 * Spec 04 — Balance Service, step 8b: the MAKER-CHECKER (four-eyes) reversal `/admin` surface END-TO-END
 * over supertest, booting the REAL AppModule (global gateway identity guard — which enforces the
 * `admin` role on `/admin` — + the exception filter + zod validation + request-id middleware). Written
 * FROM the developer-locked HTTP contract (spec 04 "/admin Maker-checker (four-eyes)" bullet + the DoD
 * "A reversal requires a second approver (maker-checker) and writes an audit row"), NOT from the
 * implementor's code.
 *
 * Endpoints under test:
 *   POST /admin/transfers/:id/reverse         → a MAKER proposes a reversal → ApprovalRequest PENDING
 *   POST /admin/approvals/:id/approve|reject   → a DIFFERENT checker decides; approve executes the reversal
 *
 * It proves at the HTTP edge:
 *   - ROLE GATING: /reverse and /approvals/:id/approve with NO X-User-Id → 401; WITH X-User-Id but
 *     WITHOUT the `admin` role → 403.
 *   - FOUR-EYES: a maker proposes (PENDING); the MAKER approving their OWN request → 403
 *     SELF_APPROVAL_FORBIDDEN (no money moves, target still POSTED, approval still PENDING); a DIFFERENT
 *     admin approving → executes (2xx), original → REVERSED, money moves (A restored, B debited), a
 *     compensating tx links to the original, and the ledger nets to zero.
 *   - GUARDS: approve an already-EXECUTED approval → 409 APPROVAL_NOT_PENDING; approve/reject an unknown
 *     id → 404 APPROVAL_NOT_FOUND; reverse a non-POSTED / already-REVERSED / external_outbound target →
 *     409 TRANSACTION_NOT_REVERSIBLE; a second reverse-proposal for a target with a live approval → 409
 *     REVERSAL_ALREADY_REQUESTED.
 *   - REJECT: a different checker rejects → 2xx REJECTED, no money moves, audits reversal.rejected; the
 *     maker rejecting their own → 403.
 *   - AUDIT: propose writes reversal.proposed, approve writes reversal.executed, reject writes
 *     reversal.rejected.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (Postgres AND Redis — AppModule boots both). beforeAll
 * TCP-probes both and fails loud if unreachable; boots AppModule (migrationsRun:true). Unique
 * owners/accounts/admins per test; committed rows (approvals → compensating tx → the seed) + audit rows
 * cleaned up per-test.
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
  insertRow,
  insertCustomer,
  insertTransaction,
  localAccountNumber,
  getApprovalRow,
  getReversalTxsFor,
  getTransactionStatus,
  findLedgerByTx,
  getAuditRows,
  deleteApprovalsByTarget,
  deleteAuditRowsByActor,
  TODAY,
  MONTH_START,
} from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[e2e] SKIPPED admin maker-checker HTTP suite: set BALANCE_INTEGRATION=1 (and point DB_* at ' +
      'Postgres AND REDIS_* at Redis) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const MXN = 'MXN';

const ACTION_PROPOSED = 'reversal.proposed';
const ACTION_EXECUTED = 'reversal.executed';
const ACTION_REJECTED = 'reversal.rejected';

const suite = ENABLED ? describe : describe.skip;

suite(
  'admin maker-checker HTTP surface (step 8b) — role gating, four-eyes, reversal money movement, guards, audit (e2e, needs Postgres + Redis)',
  () => {
    let app: INestApplication;
    let ds: any;
    let http: any;

    let createdAccountIds: string[] = [];
    let trackedOwners: string[] = [];
    let trackedAdmins: string[] = [];

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
      createdAccountIds = [];
      trackedOwners = [];
      trackedAdmins = [];
      try {
        await cleanup(ids, owners, admins);
      } catch {
        /* best-effort */
      }
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    // ---- helpers --------------------------------------------------------------------------

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
      await insertCustomer(ds, owner, {});
      const accountNumber = localAccountNumber();
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
        ...overrides,
      });
      createdAccountIds.push(acc.id);
      return acc;
    }

    /** Seed the POST-transfer state of a POSTED internal A→B (A debited to 6000, B credited to 4000). */
    async function seedPostedInternal(
      amount = 4000,
    ): Promise<{ a: any; b: any; tx: any; sender: string }> {
      const sender = newOwner();
      const a = await mkCustomer(sender, { balance: 6000 });
      const b = await mkCustomer(newOwner(), { balance: amount });
      const tx = await insertTransaction(ds, {
        type: 'internal',
        status: 'POSTED',
        initiatedBy: sender,
        debitAccountId: a.id,
        creditAccountId: b.id,
        amount: String(amount),
        currency: MXN,
        postedAt: new Date(),
      });
      return { a, b, tx, sender };
    }

    async function cleanup(ids: string[], owners: string[], admins: string[]): Promise<void> {
      await deleteAuditRowsByActor(ds, admins);
      if (ids.length || owners.length) {
        const txRows = await ds.query(
          `SELECT id FROM "transaction"
          WHERE debit_account_id = ANY($1) OR credit_account_id = ANY($1) OR initiated_by = ANY($2)
          UNION SELECT DISTINCT transaction_id AS id FROM ledger_entry WHERE account_id = ANY($1)`,
          [ids, owners],
        );
        const txIds = txRows.map((r: any) => r.id);
        if (txIds.length) {
          await deleteApprovalsByTarget(ds, txIds);
          await ds.query(
            `UPDATE "transaction" SET reverses_transaction_id = NULL WHERE reverses_transaction_id = ANY($1)`,
            [txIds],
          );
          await ds.query(`DELETE FROM idempotency_key WHERE transaction_id = ANY($1)`, [txIds]);
          await ds.query(`DELETE FROM outbox_event WHERE transaction_id = ANY($1)`, [txIds]);
          await ds.query(`DELETE FROM hold WHERE transaction_id = ANY($1)`, [txIds]);
          await ds.query(`DELETE FROM ledger_entry WHERE transaction_id = ANY($1)`, [txIds]);
          await ds.query(`DELETE FROM "transaction" WHERE id = ANY($1)`, [txIds]);
        }
      }
      if (owners.length) {
        await ds.query(`DELETE FROM idempotency_key WHERE owner_id = ANY($1)`, [owners]);
      }
      if (ids.length) await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
      if (owners.length) await ds.query(`DELETE FROM customer WHERE id = ANY($1)`, [owners]);
    }

    const asUser = (userId: string) => ({
      post: (path: string) =>
        request(http).post(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
    });
    const asAdmin = (adminId: string) => ({
      post: (path: string) =>
        request(http).post(path).set('X-User-Id', adminId).set('X-Roles', 'admin'),
    });

    function expectErrorDto(body: any, code?: string): void {
      expect(body).toBeDefined();
      expect(body.error).toBeDefined();
      expect(typeof body.error.code).toBe('string');
      if (code !== undefined) expect(body.error.code).toBe(code);
    }

    function approvalIdOf(body: any): string {
      const a = body?.approval ?? body?.approvalRequest ?? body;
      return (a?.id ?? a?.approvalId) as string;
    }

    async function balanceOf(id: string): Promise<string> {
      const r = await ds.query(`SELECT balance FROM account WHERE id = $1`, [id]);
      return r[0].balance as string;
    }

    // =========================================================================================
    // ROLE GATING — /reverse + /approve require the admin role
    // =========================================================================================

    it('role gating: /admin/transfers/:id/reverse and /admin/approvals/:id/approve reject no-user-id (401) and a non-admin (403)', async () => {
      const { tx } = await seedPostedInternal();

      const anonReverse = await request(http).post(`/admin/transfers/${tx.id}/reverse`).send({});
      expect(anonReverse.status).toBe(401);
      const userReverse = await asUser(newOwner())
        .post(`/admin/transfers/${tx.id}/reverse`)
        .send({});
      expect(userReverse.status).toBe(403);

      const someApprovalId = randomUUID();
      const anonApprove = await request(http)
        .post(`/admin/approvals/${someApprovalId}/approve`)
        .send({});
      expect(anonApprove.status).toBe(401);
      const userApprove = await asUser(newOwner())
        .post(`/admin/approvals/${someApprovalId}/approve`)
        .send({});
      expect(userApprove.status).toBe(403);

      // The non-admin attempts left the target untouched.
      expect(await getTransactionStatus(ds, tx.id)).toBe('POSTED');
      expect(await getReversalTxsFor(ds, tx.id)).toHaveLength(0);
    }, 45_000);

    // =========================================================================================
    // FOUR-EYES — self-approval forbidden; a different checker executes the reversal (money moves)
    // =========================================================================================

    it('four-eyes: maker proposes (PENDING) → the MAKER approving OWN → 403 SELF_APPROVAL_FORBIDDEN (no money, still POSTED) → a DIFFERENT admin approves → REVERSED + money moves + compensating tx + balanced ledger', async () => {
      const AMOUNT = 4000;
      const { a, b, tx } = await seedPostedInternal(AMOUNT);
      const maker = newAdmin();
      const checker = newAdmin();

      // MAKER proposes.
      const proposed = await asAdmin(maker).post(`/admin/transfers/${tx.id}/reverse`).send({});
      expect([200, 201]).toContain(proposed.status);
      const approvalId = approvalIdOf(proposed.body);
      expect(approvalId).toBeTruthy();
      expect((await getApprovalRow(ds, approvalId))?.status).toBe('PENDING');

      // MAKER approves their OWN request → 403; nothing moves; target still POSTED; approval PENDING.
      const selfApprove = await asAdmin(maker)
        .post(`/admin/approvals/${approvalId}/approve`)
        .send({});
      expect(selfApprove.status).toBe(403);
      expectErrorDto(selfApprove.body, 'SELF_APPROVAL_FORBIDDEN');
      expect(await balanceOf(a.id)).toBe('6000');
      expect(await balanceOf(b.id)).toBe(String(AMOUNT));
      expect(await getTransactionStatus(ds, tx.id)).toBe('POSTED');
      expect((await getApprovalRow(ds, approvalId))?.status).toBe('PENDING');
      expect(await getReversalTxsFor(ds, tx.id)).toHaveLength(0);

      // A DIFFERENT admin approves → executes the reversal.
      const approve = await asAdmin(checker)
        .post(`/admin/approvals/${approvalId}/approve`)
        .send({});
      expect([200, 201]).toContain(approve.status);

      // Money moved: A restored (+amount), B debited (−amount); original REVERSED.
      expect(await balanceOf(a.id)).toBe('10000'); // 6000 + 4000
      expect(await balanceOf(b.id)).toBe('0'); // 4000 − 4000
      expect(await getTransactionStatus(ds, tx.id)).toBe('REVERSED');

      // A compensating tx links to the original; its double-entry nets to zero.
      const comp = await getReversalTxsFor(ds, tx.id);
      expect(comp).toHaveLength(1);
      expect(comp[0].reverses_transaction_id).toBe(tx.id);
      const legs = await findLedgerByTx(ds, comp[0].id);
      expect(legs).toHaveLength(2);
      expect(legs.reduce((s: bigint, l: any) => s + BigInt(l.delta), 0n)).toBe(0n);

      // The approval ended EXECUTED with checker <> maker (the four-eyes invariant, DB-backstopped).
      const appr = await getApprovalRow(ds, approvalId);
      expect(appr?.status).toBe('EXECUTED');
      expect(appr?.checker_id).toBe(checker);
      expect(appr?.maker_id).toBe(maker);
    }, 60_000);

    // =========================================================================================
    // GUARDS — reversibility + approval lifecycle
    // =========================================================================================

    it('reverse a NON-POSTED (PENDING) target → 409 TRANSACTION_NOT_REVERSIBLE (no approval created)', async () => {
      const owner = newOwner();
      const a = await mkCustomer(owner, { balance: 6000 });
      const b = await mkCustomer(newOwner(), { balance: 0 });
      const pending = await insertTransaction(ds, {
        type: 'internal',
        status: 'PENDING',
        initiatedBy: owner,
        debitAccountId: a.id,
        creditAccountId: b.id,
        amount: '4000',
        currency: MXN,
        expiresAt: new Date(Date.now() + 120_000),
      });

      const res = await asAdmin(newAdmin()).post(`/admin/transfers/${pending.id}/reverse`).send({});
      expect(res.status).toBe(409);
      expectErrorDto(res.body, 'TRANSACTION_NOT_REVERSIBLE');
    }, 45_000);

    it('reverse an already-REVERSED target → 409 TRANSACTION_NOT_REVERSIBLE', async () => {
      const owner = newOwner();
      const a = await mkCustomer(owner, { balance: 6000 });
      const b = await mkCustomer(newOwner(), { balance: 4000 });
      const reversed = await insertTransaction(ds, {
        type: 'internal',
        status: 'REVERSED',
        initiatedBy: owner,
        debitAccountId: a.id,
        creditAccountId: b.id,
        amount: '4000',
        currency: MXN,
        postedAt: new Date(),
      });

      const res = await asAdmin(newAdmin())
        .post(`/admin/transfers/${reversed.id}/reverse`)
        .send({});
      expect(res.status).toBe(409);
      expectErrorDto(res.body, 'TRANSACTION_NOT_REVERSIBLE');
    }, 45_000);

    it('reverse an external_outbound transfer → 409 TRANSACTION_NOT_REVERSIBLE (its reversal is the rail-failure path, not admin)', async () => {
      const owner = newOwner();
      const a = await mkCustomer(owner, { balance: 6000 });
      const outbound = await insertTransaction(ds, {
        type: 'external_outbound',
        status: 'POSTED',
        initiatedBy: owner,
        debitAccountId: a.id,
        creditAccountId: null,
        amount: '4000',
        currency: MXN,
        postedAt: new Date(),
      });

      const res = await asAdmin(newAdmin())
        .post(`/admin/transfers/${outbound.id}/reverse`)
        .send({});
      expect(res.status).toBe(409);
      expectErrorDto(res.body, 'TRANSACTION_NOT_REVERSIBLE');
    }, 45_000);

    it('a SECOND reverse-proposal for a target that already has a live approval → 409 REVERSAL_ALREADY_REQUESTED (still exactly one approval)', async () => {
      const { tx } = await seedPostedInternal();

      const first = await asAdmin(newAdmin()).post(`/admin/transfers/${tx.id}/reverse`).send({});
      expect([200, 201]).toContain(first.status);

      const second = await asAdmin(newAdmin()).post(`/admin/transfers/${tx.id}/reverse`).send({});
      expect(second.status).toBe(409);
      expectErrorDto(second.body, 'REVERSAL_ALREADY_REQUESTED');
    }, 45_000);

    it('approve an already-EXECUTED approval → 409 APPROVAL_NOT_PENDING (no second reversal); approve/reject an unknown id → 404 APPROVAL_NOT_FOUND', async () => {
      const { tx } = await seedPostedInternal();
      const maker = newAdmin();
      const checker = newAdmin();

      const proposed = await asAdmin(maker).post(`/admin/transfers/${tx.id}/reverse`).send({});
      const approvalId = approvalIdOf(proposed.body);
      const first = await asAdmin(checker).post(`/admin/approvals/${approvalId}/approve`).send({});
      expect([200, 201]).toContain(first.status);
      expect(await getTransactionStatus(ds, tx.id)).toBe('REVERSED');

      // Approving the already-EXECUTED approval again → 409, and NO second compensating tx.
      const again = await asAdmin(newAdmin())
        .post(`/admin/approvals/${approvalId}/approve`)
        .send({});
      expect(again.status).toBe(409);
      expectErrorDto(again.body, 'APPROVAL_NOT_PENDING');
      expect(await getReversalTxsFor(ds, tx.id)).toHaveLength(1);

      // Unknown approval id on approve AND reject → 404.
      const unknownApprove = await asAdmin(newAdmin())
        .post(`/admin/approvals/${randomUUID()}/approve`)
        .send({});
      expect(unknownApprove.status).toBe(404);
      expectErrorDto(unknownApprove.body, 'APPROVAL_NOT_FOUND');
      const unknownReject = await asAdmin(newAdmin())
        .post(`/admin/approvals/${randomUUID()}/reject`)
        .send({});
      expect(unknownReject.status).toBe(404);
      expectErrorDto(unknownReject.body, 'APPROVAL_NOT_FOUND');
    }, 60_000);

    // =========================================================================================
    // REJECT — a different checker rejects (no money moves); the maker rejecting own → 403
    // =========================================================================================

    it('reject: a DIFFERENT checker rejects → REJECTED, no money moves, audits reversal.rejected; the MAKER rejecting own → 403', async () => {
      const AMOUNT = 4000;
      const { a, b, tx } = await seedPostedInternal(AMOUNT);
      const maker = newAdmin();
      const checker = newAdmin();

      const proposed = await asAdmin(maker).post(`/admin/transfers/${tx.id}/reverse`).send({});
      const approvalId = approvalIdOf(proposed.body);

      // The MAKER rejecting their own request is also a four-eyes violation → 403.
      const selfReject = await asAdmin(maker)
        .post(`/admin/approvals/${approvalId}/reject`)
        .send({});
      expect(selfReject.status).toBe(403);
      expectErrorDto(selfReject.body, 'SELF_APPROVAL_FORBIDDEN');
      expect((await getApprovalRow(ds, approvalId))?.status).toBe('PENDING');

      // A DIFFERENT checker rejects → REJECTED, and NOTHING moved.
      const reject = await asAdmin(checker).post(`/admin/approvals/${approvalId}/reject`).send({});
      expect([200, 201]).toContain(reject.status);
      expect((await getApprovalRow(ds, approvalId))?.status).toBe('REJECTED');
      expect(await getTransactionStatus(ds, tx.id)).toBe('POSTED'); // still posted
      expect(await getReversalTxsFor(ds, tx.id)).toHaveLength(0); // no compensating movement
      expect(await balanceOf(a.id)).toBe('6000');
      expect(await balanceOf(b.id)).toBe(String(AMOUNT));

      // The rejection was audited by the checker.
      expect(await getAuditRows(ds, { actorId: checker, action: ACTION_REJECTED })).toHaveLength(1);
    }, 60_000);

    // =========================================================================================
    // AUDIT — every reversal step writes exactly one audit row (DoD)
    // =========================================================================================

    it('audit: propose writes reversal.proposed (maker), approve writes reversal.executed (checker) referencing the original tx', async () => {
      const { tx } = await seedPostedInternal();
      const maker = newAdmin();
      const checker = newAdmin();

      const proposed = await asAdmin(maker).post(`/admin/transfers/${tx.id}/reverse`).send({});
      const approvalId = approvalIdOf(proposed.body);
      const proposedAudit = await getAuditRows(ds, { actorId: maker, action: ACTION_PROPOSED });
      expect(proposedAudit).toHaveLength(1);

      const approve = await asAdmin(checker)
        .post(`/admin/approvals/${approvalId}/approve`)
        .send({});
      expect([200, 201]).toContain(approve.status);
      const executedAudit = await getAuditRows(ds, { actorId: checker, action: ACTION_EXECUTED });
      expect(executedAudit).toHaveLength(1);
      // The executed audit references the original transaction (metadata or target linkage).
      const linkage =
        JSON.stringify(executedAudit[0].metadata ?? {}) + String(executedAudit[0].target_id ?? '');
      expect(linkage).toContain(tx.id);
    }, 60_000);
  },
);
