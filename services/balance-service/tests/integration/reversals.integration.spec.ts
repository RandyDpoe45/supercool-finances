/**
 * Spec 04 — Balance Service, step 8b: the MAKER-CHECKER REVERSAL money-safety proofs, driven against
 * the REAL DI'd `ApprovalService` (resolved BY TOKEN through a booted AppModule) with real Postgres +
 * real Redis. Written FROM the spec's "/admin Maker-checker (four-eyes)" bullet + the DoD ("A reversal
 * requires a second approver (maker-checker) and writes an audit row"), NOT from the implementor's
 * code. These are the KEYSTONE money proofs for the final balance step:
 *
 *   - FORCED (the key money proof): reversing a POSTED internal A→B whose beneficiary B has since
 *     spent the funds AND is frozen STILL executes — B's balance goes NEGATIVE (the compensating
 *     debit bypasses the overdraft + frozen checks), A is restored, the original is REVERSED, and the
 *     compensating legs net to zero (no money created/lost). CONTROL: a NORMAL customer-initiated
 *     debit on the now-negative/frozen B still fails the usual check — proving `forced` did NOT leak
 *     beyond the reversal.
 *   - CONCURRENCY KEYSTONE: one PENDING approval, TWO concurrent `approve(checker, id)` → EXACTLY ONE
 *     executes (one EXECUTED approval, one compensating transaction, the target REVERSED once, money
 *     moved once); the other rejects. The guarded PENDING→EXECUTED + POSTED→REVERSED transitions
 *     serialize — never two reversals, never double money movement.
 *   - INBOUND reversal: reversing a POSTED external_inbound credit DEBITS the customer (forced, may go
 *     negative), CREDITS clearing:rail-inbound, REVERSES the original.
 *   - SPEND COUNTERS: a reversal does NOT refund the sender's `spent_today` (the compensating post
 *     carries no limitAccountId).
 *   - RECONCILIATION: after a reversal, `sum(ledger delta) == account.balance` for the affected
 *     accounts and the compensating double-entry nets to zero.
 *
 * Why DB+Redis-backed and not mocked: money-moved-once / goes-negative-safely / no-double-reversal /
 * reconciliation are properties of REAL transactions — mocking them would mock away the logic under
 * test. Every assertion gates on OBSERVABLE STATE (balances, ledger legs, tx status, compensating-tx
 * existence, approval status, spend counters), never on the error kind alone.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a false
 * pass). beforeAll TCP-probes BOTH Postgres and Redis and fails loud if unreachable; boots the real
 * AppModule (migrationsRun:true → MXN + the two clearing accounts + the approval_request table).
 * jest.config serializes the integration run (maxWorkers:1). Unique account/owner/admin ids per test;
 * committed rows (approvals → compensating tx → the seed) + audit rows cleaned up per-test.
 *
 * To run:
 *   BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=… REDIS_HOST=… REDIS_PORT=…] npm test
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import * as harness from '../support/harness';
import { getAppModule, getDomainErrors, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import * as pg from '../support/pg';
const {
  insertAccount,
  insertTransaction,
  insertLedgerEntry,
  getAccount,
  getApprovalRow,
  getApprovalsByTarget,
  getReversalTxsFor,
  getTransactionStatus,
  insertApprovalRow,
  getAccountCounters,
  setAccountSpendCounters,
  findLedgerByTx,
  getAuditRows,
  deleteApprovalsByTarget,
  deleteAuditRowsByActor,
  localAccountNumber,
  TODAY,
  MONTH_START,
} = pg;

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED maker-checker reversals (step 8b) suite: set BALANCE_INTEGRATION=1 (and ' +
      'point DB_* at Postgres AND REDIS_* at Redis — the app boots both) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const MXN = 'MXN';

const suite = ENABLED ? describe : describe.skip;

suite(
  'maker-checker reversals (step 8b) — forced/concurrency/inbound/counters/reconciliation (integration, needs Postgres + Redis)',
  () => {
    let app: INestApplication;
    let ds: any;
    let approvals: any;
    let posting: any;
    let inboundClearingId: string;
    let domainErrors: ReturnType<typeof getDomainErrors> & Record<string, any>;
    const approvalErrors: Record<string, any> = harness.getApprovalErrors();

    let createdAccountIds: string[] = [];
    let trackedOwners: string[] = [];
    let trackedAdmins: string[] = [];

    beforeAll(async () => {
      const [pgOk, redisOk] = await Promise.all([
        tcpProbe(DB_HOST, DB_PORT),
        tcpProbe(REDIS_HOST, REDIS_PORT),
      ]);
      if (!pgOk) throw new Error(`[integration] Postgres not reachable at ${DB_HOST}:${DB_PORT}.`);
      if (!redisOk)
        throw new Error(`[integration] Redis not reachable at ${REDIS_HOST}:${REDIS_PORT}.`);

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

      try {
        const { DataSource } = require('typeorm');
        ds = app.get(DataSource);
      } catch {
        const { getDataSourceToken } = require('@nestjs/typeorm');
        ds = app.get(getDataSourceToken());
      }
      if (!ds)
        throw new Error('[integration] could not resolve the TypeORM DataSource from the app');

      // The step-8b ApprovalService, resolved BY TOKEN through the app graph. Fail LOUD if missing so
      // the gate never passes on a stub.
      const approvalToken = harness.getApprovalServiceToken();
      approvals = app.get(approvalToken, { strict: false });
      if (
        !approvals ||
        typeof approvals.proposeReversal !== 'function' ||
        typeof approvals.approve !== 'function' ||
        typeof approvals.reject !== 'function'
      ) {
        throw new Error(
          '[integration] resolved APPROVAL_SERVICE but it lacks proposeReversal / approve / reject. ' +
            'Reconcile the contract at tests/support/harness.ts:getApprovalServiceToken.',
        );
      }

      // The posting reducer — used to drive the NO-LEAK control (a normal, non-forced debit).
      posting = app.get(harness.getPostingServiceToken(), { strict: false });
      if (!posting || typeof posting.postTransaction !== 'function') {
        throw new Error('[integration] resolved POSTING_SERVICE but it has no postTransaction.');
      }

      inboundClearingId = await systemAccountId('clearing:rail-inbound');
      domainErrors = getDomainErrors() as any;
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
        /* best-effort; random ids keep re-runs safe */
      }
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    // ---- resolution + seed + query helpers ------------------------------------------------

    async function systemAccountId(systemKey: string): Promise<string> {
      const r = await ds.query(`SELECT id FROM account WHERE kind = 'system' AND system_key = $1`, [
        systemKey,
      ]);
      if (!r[0]?.id) {
        throw new Error(`[integration] system account ${systemKey} is not seeded.`);
      }
      return r[0].id;
    }

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

    interface SeedInternalOpts {
      amount: number;
      senderBalance: number;
      beneficiaryBalance: number;
      beneficiaryStatus?: 'active' | 'frozen';
      senderSpentToday?: number;
      /** Seed the original transfer's ledger legs (so per-account reconciliation holds pre-reversal). */
      seedLegs?: boolean;
      senderGenesis?: number;
    }

    /** Seed the POST-transfer state of a POSTED internal A→B (the reversible target). */
    async function seedPostedInternal(
      opts: SeedInternalOpts,
    ): Promise<{ sender: string; a: any; b: any; tx: any }> {
      const sender = newOwner();
      const beneficiary = newOwner();
      const a = await mkCustomer(sender, { balance: opts.senderBalance });
      const b = await mkCustomer(beneficiary, {
        balance: opts.beneficiaryBalance,
        status: opts.beneficiaryStatus ?? 'active',
      });
      if (opts.senderSpentToday !== undefined) {
        await setAccountSpendCounters(ds, a.id, {
          spentToday: String(opts.senderSpentToday),
          spentTodayDate: TODAY,
        });
      }
      const tx = await insertTransaction(ds, {
        type: 'internal',
        status: 'POSTED',
        initiatedBy: sender,
        debitAccountId: a.id,
        creditAccountId: b.id,
        amount: String(opts.amount),
        currency: MXN,
        postedAt: new Date(),
      });
      if (opts.seedLegs) {
        // Optional genesis credit on the sender so its ledger sums to its seeded balance.
        if (opts.senderGenesis !== undefined) {
          const g = await insertTransaction(ds, {
            type: 'external_inbound',
            status: 'POSTED',
            initiatedBy: sender,
            debitAccountId: inboundClearingId,
            creditAccountId: a.id,
            amount: String(opts.senderGenesis),
            currency: MXN,
            postedAt: new Date(Date.now() - 1000),
          });
          await insertLedgerEntry(ds, {
            transaction_id: g.id,
            account_id: a.id,
            delta: opts.senderGenesis,
            balance_after: opts.senderGenesis,
            currency: MXN,
          });
        }
        await insertLedgerEntry(ds, {
          transaction_id: tx.id,
          account_id: a.id,
          delta: -opts.amount,
          balance_after: opts.senderBalance,
          currency: MXN,
        });
        await insertLedgerEntry(ds, {
          transaction_id: tx.id,
          account_id: b.id,
          delta: opts.amount,
          balance_after: opts.beneficiaryBalance,
          currency: MXN,
        });
      }
      return { sender, a, b, tx };
    }

    /** Seed a POSTED external_inbound credit (clearing:rail-inbound → customer) — the reversible
     *  inbound case. The customer is seeded UNDERFUNDED so a forced reverse-debit goes negative. */
    async function seedPostedInbound(opts: {
      amount: number;
      custBalance: number;
      custStatus?: 'active' | 'frozen';
    }): Promise<{ owner: string; cust: any; tx: any }> {
      const owner = newOwner();
      const cust = await mkCustomer(owner, {
        balance: opts.custBalance,
        status: opts.custStatus ?? 'active',
      });
      const tx = await insertTransaction(ds, {
        type: 'external_inbound',
        status: 'POSTED',
        initiatedBy: owner,
        debitAccountId: inboundClearingId,
        creditAccountId: cust.id,
        amount: String(opts.amount),
        currency: MXN,
        postedAt: new Date(),
      });
      return { owner, cust, tx };
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
          // Approvals FK the target transaction — delete them BEFORE the transactions.
          await deleteApprovalsByTarget(ds, txIds);
          // Null the self-referential reverses_transaction_id so a multi-row DELETE does not trip
          // fk_tx_reverses (compensating rows point at originals in the same batch).
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

    async function bal(id: string): Promise<bigint> {
      const a = await getAccount(ds, id);
      return BigInt((a as any).balance);
    }
    async function status(id: string): Promise<string> {
      return (await getAccount(ds, id))!.status;
    }
    const sumDeltas = (legs: Array<{ delta: string }>): bigint =>
      legs.reduce((s, l) => s + BigInt(l.delta), 0n);
    async function sumLegsForAccount(accountId: string): Promise<bigint> {
      const r = await ds.query(
        `SELECT COALESCE(SUM(delta), 0)::text AS s FROM ledger_entry WHERE account_id = $1`,
        [accountId],
      );
      return BigInt(r[0].s);
    }

    async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
      try {
        return { ok: true, value: await p };
      } catch (error) {
        return { ok: false, error };
      }
    }
    function idOf(x: any): string {
      const v = x?.value ?? x;
      return (v?.id ?? v?.approvalId ?? v?.approval?.id) as string;
    }
    function codeOf(err: any): string {
      const ae = approvalErrors;
      const de = domainErrors;
      if (ae.ApprovalNotPendingError && err instanceof ae.ApprovalNotPendingError)
        return 'APPROVAL_NOT_PENDING';
      if (ae.SelfApprovalForbiddenError && err instanceof ae.SelfApprovalForbiddenError)
        return 'SELF_APPROVAL_FORBIDDEN';
      if (ae.TransactionNotReversibleError && err instanceof ae.TransactionNotReversibleError)
        return 'TRANSACTION_NOT_REVERSIBLE';
      if (de.AccountFrozenError && err instanceof de.AccountFrozenError) return 'ACCOUNT_FROZEN';
      if (de.InsufficientFundsError && err instanceof de.InsufficientFundsError)
        return 'INSUFFICIENT_FUNDS';
      return (err?.code ?? '') as string;
    }

    /** propose (maker) → approve (checker); returns the approval id after approve resolves. */
    async function proposeAndApprove(
      txId: string,
    ): Promise<{ maker: string; checker: string; approvalId: string; approveRes: any }> {
      const maker = newAdmin();
      const checker = newAdmin();
      const proposal = await approvals.proposeReversal(maker, txId);
      const approvalId = idOf(proposal);
      const approveRes = await capture(approvals.approve(checker, approvalId));
      return { maker, checker, approvalId, approveRes };
    }

    // =========================================================================================
    // FORCED — the key money proof: beneficiary goes NEGATIVE despite frozen; + the no-leak control
    // =========================================================================================

    it('FORCED reverse of a POSTED internal A→B where B is frozen + underfunded: B goes NEGATIVE, A is restored, original REVERSED, legs net zero; a normal debit on B still fails (no leak)', async () => {
      const AMOUNT = 4000;
      // A already debited (10000 → 6000); B frozen and holding only 1000 (spent 3000 of the 4000).
      const { a, b, tx } = await seedPostedInternal({
        amount: AMOUNT,
        senderBalance: 6000,
        beneficiaryBalance: 1000,
        beneficiaryStatus: 'frozen',
      });
      const aBefore = await bal(a.id);
      const bBefore = await bal(b.id);

      const { approvalId, approveRes } = await proposeAndApprove(tx.id);
      expect(approveRes.ok).toBe(true); // the forced admin correction ALWAYS executes

      // B's balance goes NEGATIVE (1000 − 4000 = −3000): the forced debit bypassed frozen + overdraft.
      const bAfter = await bal(b.id);
      expect(bAfter).toBe(bBefore - BigInt(AMOUNT));
      expect(bAfter < 0n).toBe(true);
      expect(await status(b.id)).toBe('frozen'); // the reversal did NOT thaw it

      // A is restored by exactly the amount; between A and B, no money was created or lost.
      expect(await bal(a.id)).toBe(aBefore + BigInt(AMOUNT));

      // The original is REVERSED (retained), and exactly one compensating tx links to it, POSTED,
      // with mirrored legs netting to zero.
      expect(await getTransactionStatus(ds, tx.id)).toBe('REVERSED');
      const comp = await getReversalTxsFor(ds, tx.id);
      expect(comp).toHaveLength(1);
      expect(comp[0].status).toBe('POSTED');
      const legs = await findLedgerByTx(ds, comp[0].id);
      expect(legs).toHaveLength(2);
      expect(sumDeltas(legs)).toBe(0n);
      const credited = legs.find((l: any) => BigInt(l.delta) > 0n)!;
      const debited = legs.find((l: any) => BigInt(l.delta) < 0n)!;
      expect(credited.account_id).toBe(a.id); // original debit account credited back
      expect(debited.account_id).toBe(b.id); // original credit account debited (forced)

      // The approval ended EXECUTED with a checker distinct from the maker.
      const appr = await getApprovalRow(ds, approvalId);
      expect(appr?.status).toBe('EXECUTED');
      expect(appr?.checker_id).not.toBe(appr?.maker_id);

      // NO-LEAK CONTROL: a NORMAL customer-initiated debit on the now-negative/frozen B still fails
      // the usual check — proving `forced` was scoped to the reversal command, not the account.
      const control = await capture(
        posting.postTransaction({
          type: 'internal',
          currency: MXN,
          amount: '100',
          legs: [
            { accountId: b.id, delta: '-100' },
            { accountId: inboundClearingId, delta: '100' },
          ],
          initiatedBy: b.owner_id ?? 'sub-x',
        }),
      );
      expect(control.ok).toBe(false);
      expect(['ACCOUNT_FROZEN', 'INSUFFICIENT_FUNDS']).toContain(codeOf(control.error));
      // The failed normal debit moved no money — B is unchanged from the reversal outcome.
      expect(await bal(b.id)).toBe(bAfter);
    }, 45_000);

    // =========================================================================================
    // CONCURRENCY KEYSTONE — two simultaneous approves → exactly one reversal, never two
    // =========================================================================================

    it('CONCURRENCY: two simultaneous approve() on one PENDING approval → EXACTLY ONE executes (one compensating tx, target REVERSED once, money moved once); the other rejects', async () => {
      const AMOUNT = 4000;
      const { a, b, tx } = await seedPostedInternal({
        amount: AMOUNT,
        senderBalance: 6000,
        beneficiaryBalance: 4000,
      });
      const aBefore = await bal(a.id);
      const bBefore = await bal(b.id);

      const maker = newAdmin();
      const checker1 = newAdmin();
      const checker2 = newAdmin();
      const proposal = await approvals.proposeReversal(maker, tx.id);
      const approvalId = idOf(proposal);

      // Fire two DIFFERENT checkers at the same PENDING approval simultaneously.
      const results = await Promise.all([
        capture(approvals.approve(checker1, approvalId)),
        capture(approvals.approve(checker2, approvalId)),
      ]);

      // EXACTLY ONE approve succeeded — the guarded PENDING→EXECUTED transition serialized them.
      const oks = results.filter((r) => r.ok);
      expect(oks).toHaveLength(1);
      const loser = results.find((r) => !r.ok)!;
      expect(['APPROVAL_NOT_PENDING', 'TRANSACTION_NOT_REVERSIBLE']).toContain(codeOf(loser.error));

      // The money invariants: EXACTLY ONE compensating tx, the target REVERSED once, money moved once.
      const comp = await getReversalTxsFor(ds, tx.id);
      expect(comp).toHaveLength(1); // NEVER two reversals
      expect(await getTransactionStatus(ds, tx.id)).toBe('REVERSED');
      expect(await bal(a.id)).toBe(aBefore + BigInt(AMOUNT)); // credited once (not twice)
      expect(await bal(b.id)).toBe(bBefore - BigInt(AMOUNT)); // debited once
      expect(sumDeltas(await findLedgerByTx(ds, comp[0].id))).toBe(0n);

      // The single approval row ends EXECUTED (not double-processed).
      const approvalsForTarget = await getApprovalsByTarget(ds, tx.id);
      expect(approvalsForTarget).toHaveLength(1);
      expect(approvalsForTarget[0].status).toBe('EXECUTED');
    }, 45_000);

    // =========================================================================================
    // NO-DOUBLE-REVERSAL BACKSTOP (gate #2) — TWO DISTINCT approvals for one target, both approved
    // → the guarded POSTED→REVERSED transition lets only the first reverse; the second is rejected
    // =========================================================================================

    it('BACKSTOP: two DISTINCT PENDING approvals for the SAME target (the propose-guard TOCTOU) both approved → EXACTLY ONE compensating tx, target REVERSED once, money moved once; the second → TRANSACTION_NOT_REVERSIBLE and its approval stays PENDING (rolled back)', async () => {
      const AMOUNT = 4000;
      const { a, b, tx } = await seedPostedInternal({
        amount: AMOUNT,
        senderBalance: 6000,
        beneficiaryBalance: 4000,
      });
      const aBefore = await bal(a.id);
      const bBefore = await bal(b.id);

      // Approval #1 via the real propose path (maker1). Approval #2 inserted DIRECTLY for the SAME
      // target by a DIFFERENT maker — bypassing the best-effort propose-time duplicate guard on
      // purpose, to reproduce the TOCTOU the guard admits (two live PENDING approvals for one target).
      const maker1 = newAdmin();
      const maker2 = newAdmin();
      const checker1 = newAdmin();
      const checker2 = newAdmin();
      const approval1 = idOf(await approvals.proposeReversal(maker1, tx.id));
      const approval2Row = await insertApprovalRow(ds, {
        makerId: maker2,
        targetTransactionId: tx.id,
        payload: { reason: 'toctou-sibling', amount: String(AMOUNT) },
      });
      const approval2 = approval2Row.id as string;
      // Sanity: the target really does carry TWO live PENDING approvals before either is approved.
      expect(await getApprovalsByTarget(ds, tx.id)).toHaveLength(2);

      // First checker approves approval #1 → executes the reversal.
      const first = await capture(approvals.approve(checker1, approval1));
      expect(first.ok).toBe(true);

      // Second checker approves the SIBLING approval #2. Its OWN gate #1 (PENDING→EXECUTED) succeeds,
      // but gate #2 (the guarded original POSTED→REVERSED) finds the target already REVERSED → 0 rows
      // → the hard backstop aborts with TRANSACTION_NOT_REVERSIBLE.
      const second = await capture(approvals.approve(checker2, approval2));
      expect(second.ok).toBe(false);
      expect(codeOf(second.error)).toBe('TRANSACTION_NOT_REVERSIBLE');

      // MONEY-SAFETY: exactly ONE compensating tx, the target REVERSED once, money moved exactly once.
      const comp = await getReversalTxsFor(ds, tx.id);
      expect(comp).toHaveLength(1); // NEVER two — no double-reversal
      expect(comp[0].status).toBe('POSTED');
      expect(await getTransactionStatus(ds, tx.id)).toBe('REVERSED');
      expect(await bal(a.id)).toBe(aBefore + BigInt(AMOUNT)); // credited ONCE
      expect(await bal(b.id)).toBe(bBefore - BigInt(AMOUNT)); // debited ONCE
      expect(sumDeltas(await findLedgerByTx(ds, comp[0].id))).toBe(0n);

      // Approval #1 executed; approval #2 rolled back to PENDING (its gate-#1 EXECUTED flip was undone
      // when the whole tx rolled back on the gate-#2 abort — the EXECUTED slot is not consumed).
      expect((await getApprovalRow(ds, approval1))?.status).toBe('EXECUTED');
      expect((await getApprovalRow(ds, approval2))?.status).toBe('PENDING');
    }, 45_000);

    // =========================================================================================
    // INBOUND reversal — clearing:rail-inbound → customer credit reversed (customer debited, forced)
    // =========================================================================================

    it('INBOUND reverse: reversing a POSTED external_inbound DEBITS the customer (forced, may go negative), CREDITS clearing:rail-inbound, REVERSES the original; legs net zero', async () => {
      const AMOUNT = 4000;
      // The inbound credited the customer 4000, but they spent 3000 → balance 1000 (underfunded).
      const { cust, tx } = await seedPostedInbound({ amount: AMOUNT, custBalance: 1000 });
      const custBefore = await bal(cust.id);
      const clearingBefore = await bal(inboundClearingId);

      const { approveRes } = await proposeAndApprove(tx.id);
      expect(approveRes.ok).toBe(true);

      // The customer is debited (forced) and goes NEGATIVE; clearing:rail-inbound is credited back.
      const custAfter = await bal(cust.id);
      expect(custAfter).toBe(custBefore - BigInt(AMOUNT));
      expect(custAfter < 0n).toBe(true);
      expect((await bal(inboundClearingId)) - clearingBefore).toBe(BigInt(AMOUNT));

      expect(await getTransactionStatus(ds, tx.id)).toBe('REVERSED');
      const comp = await getReversalTxsFor(ds, tx.id);
      expect(comp).toHaveLength(1);
      const legs = await findLedgerByTx(ds, comp[0].id);
      expect(legs).toHaveLength(2);
      expect(sumDeltas(legs)).toBe(0n);
      const debited = legs.find((l: any) => BigInt(l.delta) < 0n)!;
      const credited = legs.find((l: any) => BigInt(l.delta) > 0n)!;
      expect(debited.account_id).toBe(cust.id); // customer debited (the original credit leg)
      expect(credited.account_id).toBe(inboundClearingId); // clearing credited (the original debit leg)
    }, 45_000);

    // =========================================================================================
    // SPEND COUNTERS — a reversal does NOT refund the sender's fixed-window spend
    // =========================================================================================

    it('a reversal does NOT decrement the sender spend counters (the compensating post carries no limitAccountId)', async () => {
      const AMOUNT = 4000;
      const { a, tx } = await seedPostedInternal({
        amount: AMOUNT,
        senderBalance: 6000,
        beneficiaryBalance: 4000,
        senderSpentToday: AMOUNT, // the original outbound had counted against A's daily spend
      });
      const before = await getAccountCounters(ds, a.id);
      expect(before?.spent_today).toBe(String(AMOUNT)); // sanity: the seed took

      const { approveRes } = await proposeAndApprove(tx.id);
      expect(approveRes.ok).toBe(true);
      expect(await getTransactionStatus(ds, tx.id)).toBe('REVERSED');

      // The fixed-window slot is held: reversing does NOT give the amount back.
      const after = await getAccountCounters(ds, a.id);
      expect(after?.spent_today).toBe(String(AMOUNT)); // UNCHANGED — not decremented
      expect(after?.spent_today_date).toBe(TODAY);
    }, 45_000);

    // =========================================================================================
    // RECONCILIATION — after a reversal, sum(ledger delta) == balance for the affected accounts
    // =========================================================================================

    it('RECONCILIATION: after a reversal, sum(ledger delta) == account.balance for both A and B, and the compensating double-entry nets to zero', async () => {
      const AMOUNT = 4000;
      // Seed the ORIGINAL legs (+ a genesis credit on A) so pre-reversal sum(legs) == balance.
      const { a, b, tx } = await seedPostedInternal({
        amount: AMOUNT,
        senderBalance: 6000,
        beneficiaryBalance: 4000,
        seedLegs: true,
        senderGenesis: 10000, // A: +10000 genesis, −4000 transfer ⇒ balance 6000
      });
      // Sanity: the seed reconciles before the reversal.
      expect(await sumLegsForAccount(a.id)).toBe(await bal(a.id));
      expect(await sumLegsForAccount(b.id)).toBe(await bal(b.id));

      const { approveRes } = await proposeAndApprove(tx.id);
      expect(approveRes.ok).toBe(true);

      // After the reversal, each affected account's ledger still folds to its materialized balance.
      expect(await sumLegsForAccount(a.id)).toBe(await bal(a.id));
      expect(await sumLegsForAccount(b.id)).toBe(await bal(b.id));

      const comp = await getReversalTxsFor(ds, tx.id);
      expect(comp).toHaveLength(1);
      expect(sumDeltas(await findLedgerByTx(ds, comp[0].id))).toBe(0n); // no money created / lost
    }, 45_000);

    // =========================================================================================
    // AUDIT — every reversal step writes an audit row (DoD)
    // =========================================================================================

    it('AUDIT: propose writes reversal.proposed; approve writes reversal.executed naming the reversal + original tx', async () => {
      const AMOUNT = 4000;
      const { tx } = await seedPostedInternal({
        amount: AMOUNT,
        senderBalance: 6000,
        beneficiaryBalance: 4000,
      });
      const maker = newAdmin();
      const checker = newAdmin();

      const proposal = await approvals.proposeReversal(maker, tx.id);
      const approvalId = idOf(proposal);
      const proposed = await getAuditRows(ds, { actorId: maker, action: 'reversal.proposed' });
      expect(proposed).toHaveLength(1);

      const approveRes = await capture(approvals.approve(checker, approvalId));
      expect(approveRes.ok).toBe(true);
      const executed = await getAuditRows(ds, { actorId: checker, action: 'reversal.executed' });
      expect(executed).toHaveLength(1);
      // The executed audit references the original transaction (the metadata carries the linkage).
      const comp = await getReversalTxsFor(ds, tx.id);
      const meta = JSON.stringify(executed[0].metadata ?? {}) + String(executed[0].target_id ?? '');
      expect(meta).toContain(tx.id);
      expect(comp).toHaveLength(1);
    }, 45_000);
  },
);
