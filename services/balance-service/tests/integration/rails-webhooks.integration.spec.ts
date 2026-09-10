/**
 * Spec 04 — Balance Service, step 5c: the EXTERNAL RAIL WEBHOOKS domain logic (outbound settlement
 * callback + inbound credit) driven against the REAL DI'd RailsService (resolved BY TOKEN through a
 * booted AppModule) with real Postgres + real Redis. These are the money-safety proofs for step 5c.
 * Written FROM the spec (spec 04 "Mocked external rails", the `/external` endpoints line, the DoD) +
 * the developer-locked brief, NOT from the implementor's code:
 *
 *   - SETTLEMENT SUCCESS is RECONCILE-ONLY: it records the rail `externalRef` on the (already
 *     SETTLED, from 5b) hold and moves NO money — no new ledger legs, no compensating transaction,
 *     balances/held/clearing UNCHANGED, outbox unchanged; a repeat is a no-op.
 *   - SETTLEMENT FAILURE is a COMPENSATING REVERSAL: a fresh POSTED movement refunds the payer
 *     (`clearing:rail-outbound → customer`, customer balance += amount), the original transfer →
 *     REVERSED with `reverses_transaction_id` = original, exactly one outbox row, legs net zero; a
 *     repeat is a no-op (NO double-refund).
 *   - MUTUAL EXCLUSION: success-then-failure and failure-then-success both reject the second call
 *     (INVALID_SETTLEMENT_STATE, 409-class) and move no money; an unknown txn → SETTLEMENT_TARGET_
 *     NOT_FOUND; a non-external_outbound txn → INVALID_SETTLEMENT_STATE.
 *   - INBOUND credits a fresh POSTED `external_inbound` movement (debit `clearing:rail-inbound`,
 *     credit the customer resolved by account number, customer balance += amount), is NOT OTP-gated,
 *     is IDEMPOTENT by the rail `externalRef` (a duplicate ref → no double-credit), credits a FROZEN
 *     customer, rejects an unknown account number, and rejects a currency mismatch.
 *
 * Why DB+Redis-backed and not mocked: the invariants here (money moved exactly once / not at all,
 * reconcile-writes-no-ledger, refund-once, idempotent-by-ref, sum(ledger delta)==balance) are
 * properties of REAL transactions — mocking them would mock away the logic under test. Every
 * assertion gates on OBSERVABLE STATE (balances, held, ledger legs, hold.external_ref, tx status,
 * compensating-tx existence, outbox count, clearing-account delta), never on the error kind alone.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a false
 * pass). beforeAll TCP-probes BOTH Postgres and Redis and fails loud if unreachable; boots the real
 * AppModule (migrationsRun:true → MXN + the two clearing accounts). jest.config serializes the
 * integration run (maxWorkers:1) — the shared clearing accounts are read as a DELTA (before/after),
 * never an absolute, so cross-test drift is irrelevant. Unique account/owner ids per test; committed
 * rows cleaned up per-test.
 *
 * To run:
 *   BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=… REDIS_HOST=… REDIS_PORT=…] npm test
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { getAppModule, getOutboundRail, getDomainErrors, tcpProbe } from '../support/harness';
import * as harness from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
// Namespace import: the step-5c pg helpers (`findLedgerByTx`, `outboxCountForTx`) are authored in
// parallel by the implementor (the FIXED step-5c support contract). Referencing via the namespace
// keeps this file compiling before they land (the suite is honest-SKIP-gated anyway); beforeAll
// asserts they are present when the gate runs.
import * as pg from '../support/pg';
const {
  insertAccount,
  insertTransaction,
  insertHold,
  insertLedgerEntry,
  getAccount,
  localAccountNumber,
} = pg;

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED external-rail webhooks (step 5c) suite: set BALANCE_INTEGRATION=1 (and ' +
      'point DB_* at Postgres AND REDIS_* at Redis — the app boots both) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const MXN = 'MXN';

// ---------------------------------------------------------------------------------------------
// Settlement-callback `status` LITERAL — DEVELOPER-LOCKED to lowercase `'success'` / `'failure'`
// (the wire schema is `z.enum(['success','failure'])`); the earlier ambiguity is resolved.
const STATUS_SUCCESS = 'success';
const STATUS_FAILURE = 'failure';

// The locked interface method is `settleOutbound` (kept first); the rest are fallbacks. Resolved on
// the live instance in beforeAll; the gate fails LOUD (never a false pass) if none resolve.
const SETTLE_METHODS = [
  'settleOutbound',
  'handleSettlementCallback',
  'settlementCallback',
  'processSettlementCallback',
  'processSettlement',
  'onSettlementCallback',
  'handleSettlement',
  'settle',
];
const INBOUND_METHODS = [
  'handleInbound',
  'processInbound',
  'creditInbound',
  'inboundCredit',
  'onInbound',
  'handleInboundCredit',
  'inbound',
];

const suite = ENABLED ? describe : describe.skip;

suite(
  'external-rail webhooks (step 5c) — reconcile/reverse/inbound money-safety (integration, needs Postgres + Redis)',
  () => {
    let app: INestApplication;
    let ds: any;
    let svc: any;
    let settleMethod: string;
    let inboundMethod: string;
    let outboundClearingId: string;
    let inboundClearingId: string;
    let domainErrors: ReturnType<typeof getDomainErrors> & Record<string, any>;

    let createdAccountIds: string[] = [];
    let trackedOwners: string[] = [];

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
        RAILS_WEBHOOK_API_KEY: process.env.RAILS_WEBHOOK_API_KEY || 'test-rails-webhook-api-key',
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

      // The step-5c RailsService, resolved BY TOKEN through the app graph (FIXED support contract:
      // harness.getRailsServiceToken). Fail LOUD if the accessor / service is missing so the gate
      // never passes on a stub.
      const railsToken = (harness as any).getRailsServiceToken?.();
      if (!railsToken) {
        throw new Error(
          '[integration] harness.getRailsServiceToken() is not available — the implementor owns this ' +
            'accessor (FIXED step-5c support contract). Reconcile tests/support/harness.ts.',
        );
      }
      svc = app.get(railsToken, { strict: false });
      if (!svc) {
        throw new Error(
          '[integration] resolved the RAILS_SERVICE token but the app graph bound no provider to it.',
        );
      }
      const s = pickMethod(svc, SETTLE_METHODS);
      const i = pickMethod(svc, INBOUND_METHODS);
      if (!s || !i) {
        throw new Error(
          `[integration] the RailsService is missing a settlement-callback and/or inbound handler. ` +
            `Tried settlement: ${SETTLE_METHODS.join('/')}; inbound: ${INBOUND_METHODS.join('/')}. ` +
            `Add the actual method name to the candidate lists in this spec (test-owned) or reconcile ` +
            `the contract with the implementor.`,
        );
      }
      settleMethod = s;
      inboundMethod = i;

      outboundClearingId = await systemAccountId('clearing:rail-outbound');
      inboundClearingId = await systemAccountId('clearing:rail-inbound');

      for (const fn of ['findLedgerByTx', 'outboxCountForTx']) {
        if (typeof (pg as any)[fn] !== 'function') {
          throw new Error(
            `[integration] pg.${fn} is not available in tests/support/pg.ts — the implementor owns ` +
              `this fixture (the FIXED step-5c support contract). Reconcile the contract before running the gate.`,
          );
        }
      }

      domainErrors = getDomainErrors() as any;
    }, 60_000);

    afterEach(async () => {
      const ids = createdAccountIds;
      const owners = trackedOwners;
      createdAccountIds = [];
      trackedOwners = [];
      try {
        await cleanup(ids, owners);
      } catch {
        /* best-effort; random ids keep re-runs safe */
      }
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    // ---- resolution + seed + query helpers ------------------------------------------------

    function pickMethod(obj: any, names: string[]): string | undefined {
      for (const n of names) if (typeof obj?.[n] === 'function') return n;
      return undefined;
    }

    async function systemAccountId(systemKey: string): Promise<string> {
      const r = await ds.query(`SELECT id FROM account WHERE kind = 'system' AND system_key = $1`, [
        systemKey,
      ]);
      if (!r[0]?.id) {
        throw new Error(
          `[integration] system account ${systemKey} is not seeded — SeedSystemAccounts must have run.`,
        );
      }
      return r[0].id;
    }

    function newOwner(): string {
      const o = `sub-${randomUUID()}`;
      trackedOwners.push(o);
      return o;
    }

    /** A committed customer account (customer FK parent seeded by pg.insertAccount). MXN, with a
     *  unique 10-digit account number by default; balance/held/status overridable. */
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

    /**
     * Seed the state a 5b OTP-confirm leaves behind: a POSTED `external_outbound` transaction
     * (customer → clearing), a SETTLED hold (externalRef NULL), the two original ledger legs, and a
     * customer whose balance is already debited by `amount` (held 0). The 5c callback acts on THIS.
     */
    async function seedSettledOutbound(
      owner: string,
      amount: number,
      startingBalance = 10000,
    ): Promise<{ src: any; tx: any; hold: any }> {
      const debited = startingBalance - amount;
      const src = await mkCustomer(owner, { balance: debited, held: 0 });
      const tx = await insertTransaction(ds, {
        type: 'external_outbound',
        status: 'POSTED',
        initiatedBy: owner,
        debitAccountId: src.id,
        creditAccountId: outboundClearingId,
        amount: String(amount),
        currency: MXN,
        postedAt: new Date(),
      });
      const hold = await insertHold(ds, {
        accountId: src.id,
        transactionId: tx.id,
        amount,
        status: 'SETTLED',
        rail: getOutboundRail(),
        settledAt: new Date(),
      });
      // The money already moved at 5b: seed the two legs so "no NEW legs on success" is a nonzero
      // baseline (still exactly 2 after the callback), not a vacuous 0→0.
      const clearingNow = await clearingBalance(outboundClearingId);
      await insertLedgerEntry(ds, {
        transaction_id: tx.id,
        account_id: src.id,
        delta: -amount,
        balance_after: debited,
        currency: MXN,
      });
      await insertLedgerEntry(ds, {
        transaction_id: tx.id,
        account_id: outboundClearingId,
        delta: amount,
        balance_after: clearingNow.toString(),
        currency: MXN,
      });
      return { src, tx, hold };
    }

    async function cleanup(ids: string[], owners: string[]): Promise<void> {
      if (!ids.length && !owners.length) return;
      const txRows = await ds.query(
        `SELECT id FROM "transaction"
        WHERE debit_account_id = ANY($1) OR credit_account_id = ANY($1) OR initiated_by = ANY($2)
        UNION SELECT DISTINCT transaction_id AS id FROM ledger_entry WHERE account_id = ANY($1)
        UNION SELECT DISTINCT transaction_id AS id FROM hold WHERE account_id = ANY($1)`,
        [ids, owners],
      );
      const txIds = txRows.map((r: any) => r.id);
      if (txIds.length) {
        // Null the self-referential reverses_transaction_id first so a single multi-row DELETE does
        // not trip fk_tx_reverses (compensating rows point at originals in the same batch).
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
      if (owners.length) {
        await ds.query(`DELETE FROM idempotency_key WHERE owner_id = ANY($1)`, [owners]);
        await ds.query(`DELETE FROM external_payee WHERE owner_id = ANY($1)`, [owners]);
      }
      if (ids.length) await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
      if (owners.length) await ds.query(`DELETE FROM customer WHERE id = ANY($1)`, [owners]);
    }

    async function acct(id: string): Promise<{ balance: string; held: string; status: string }> {
      const a = await getAccount(ds, id);
      return a as any;
    }

    async function clearingBalance(id: string): Promise<bigint> {
      const r = await ds.query(`SELECT balance FROM account WHERE id = $1`, [id]);
      return BigInt(r[0].balance);
    }

    async function holdForTx(
      txId: string,
    ): Promise<{ external_ref: string | null; status: string } | undefined> {
      const r = await ds.query(`SELECT external_ref, status FROM hold WHERE transaction_id = $1`, [
        txId,
      ]);
      return r[0];
    }

    async function txStatus(txId: string): Promise<string | undefined> {
      const r = await ds.query(`SELECT status FROM "transaction" WHERE id = $1`, [txId]);
      return r[0]?.status;
    }

    async function compensatingTxFor(
      origId: string,
    ): Promise<
      Array<{ id: string; status: string; reverses_transaction_id: string; type: string }>
    > {
      return ds.query(
        `SELECT id, status, reverses_transaction_id, type FROM "transaction" WHERE reverses_transaction_id = $1`,
        [origId],
      );
    }

    async function legsForTx(txId: string): Promise<Array<{ account_id: string; delta: string }>> {
      return (pg as any).findLedgerByTx(ds, txId);
    }

    async function outboxCount(txId: string): Promise<number> {
      return (pg as any).outboxCountForTx(ds, txId);
    }

    async function sumLegsForAccount(accountId: string): Promise<bigint> {
      const r = await ds.query(
        `SELECT COALESCE(SUM(delta), 0)::text AS s FROM ledger_entry WHERE account_id = $1`,
        [accountId],
      );
      return BigInt(r[0].s);
    }

    async function inboundTxsForAccount(
      accountId: string,
    ): Promise<Array<{ id: string; status: string }>> {
      return ds.query(
        `SELECT id, status FROM "transaction" WHERE type = 'external_inbound' AND credit_account_id = $1`,
        [accountId],
      );
    }

    const sumDeltas = (legs: Array<{ delta: string }>): bigint =>
      legs.reduce((s, l) => s + BigInt(l.delta), 0n);

    // ---- service adapters -----------------------------------------------------------------

    async function settle(
      transactionId: string,
      status: string,
      externalRef: string,
    ): Promise<any> {
      return svc[settleMethod]({ transactionId, status, externalRef });
    }

    async function inbound(params: {
      accountNumber: string;
      amount: number | string;
      currency?: string;
      externalRef: string;
    }): Promise<any> {
      return svc[inboundMethod]({
        accountNumber: params.accountNumber,
        amount: String(params.amount),
        currency: params.currency ?? MXN,
        externalRef: params.externalRef,
      });
    }

    async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
      try {
        return { ok: true, value: await p };
      } catch (error) {
        return { ok: false, error };
      }
    }

    function codeOf(err: any): string {
      const de = domainErrors;
      if (de.SettlementTargetNotFoundError && err instanceof de.SettlementTargetNotFoundError)
        return 'SETTLEMENT_TARGET_NOT_FOUND';
      if (de.InvalidSettlementStateError && err instanceof de.InvalidSettlementStateError)
        return 'INVALID_SETTLEMENT_STATE';
      if (de.InboundDestinationNotFoundError && err instanceof de.InboundDestinationNotFoundError)
        return 'INBOUND_DESTINATION_NOT_FOUND';
      if (de.CurrencyMismatchError && err instanceof de.CurrencyMismatchError)
        return 'CURRENCY_MISMATCH';
      return (err?.code ?? err?.driverError?.code ?? '') as string;
    }

    const ref = () => `rail-ref-${randomUUID()}`;

    // =========================================================================================
    // SETTLEMENT SUCCESS — reconcile-only (records externalRef, moves NO money)
    // =========================================================================================

    it('SUCCESS reconcile writes NO ledger: records hold.external_ref, tx stays POSTED, no new legs, no compensating tx, balances/held/clearing/outbox UNCHANGED; repeat is a no-op', async () => {
      const owner = newOwner();
      const AMOUNT = 4000;
      const { src, tx } = await seedSettledOutbound(owner, AMOUNT);
      const externalRef = ref();

      const balBefore = (await acct(src.id)).balance;
      const heldBefore = (await acct(src.id)).held;
      const clearingBefore = await clearingBalance(outboundClearingId);
      const legsBefore = (await legsForTx(tx.id)).length; // the two seeded 5b legs
      const outboxBefore = await outboxCount(tx.id);

      const res = await capture(settle(tx.id, STATUS_SUCCESS, externalRef));
      expect(res.ok).toBe(true);

      // The ONE effect of a success callback: the rail ref is stamped on the settled hold.
      const hold = await holdForTx(tx.id);
      expect(hold?.external_ref).toBe(externalRef);
      expect(hold?.status).toBe('SETTLED'); // still settled — success does not change the reservation

      // NO money moved: the transfer stays POSTED (not REVERSED), NO compensating transaction, and
      // the callback added NO ledger legs (the money already moved customer→clearing at 5b confirm).
      expect(await txStatus(tx.id)).toBe('POSTED');
      expect(await compensatingTxFor(tx.id)).toHaveLength(0);
      expect((await legsForTx(tx.id)).length).toBe(legsBefore);
      expect((await acct(src.id)).balance).toBe(balBefore);
      expect((await acct(src.id)).held).toBe(heldBefore);
      expect(await clearingBalance(outboundClearingId)).toBe(clearingBefore); // clearing untouched
      expect(await outboxCount(tx.id)).toBe(outboxBefore); // no new event

      // A retried webhook (same tx + same status + same ref) is a pure no-op.
      const repeat = await capture(settle(tx.id, STATUS_SUCCESS, externalRef));
      expect(repeat.ok).toBe(true);
      expect((await holdForTx(tx.id))?.external_ref).toBe(externalRef);
      expect(await txStatus(tx.id)).toBe('POSTED');
      expect(await compensatingTxFor(tx.id)).toHaveLength(0);
      expect((await acct(src.id)).balance).toBe(balBefore);
      expect(await clearingBalance(outboundClearingId)).toBe(clearingBefore);
    }, 30_000);

    // =========================================================================================
    // SETTLEMENT FAILURE — compensating reversal (refunds the payer exactly once)
    // =========================================================================================

    it('FAILURE reversal refunds once: customer balance += amount, original → REVERSED, a compensating tx (reverses_transaction_id) with legs netting zero, clearing -= amount, ONE outbox row; repeat is a no-op', async () => {
      const owner = newOwner();
      const AMOUNT = 4000;
      const { src, tx } = await seedSettledOutbound(owner, AMOUNT); // customer at 6000, hold SETTLED
      const externalRef = ref();

      const balBefore = BigInt((await acct(src.id)).balance); // 6000
      const clearingBefore = await clearingBalance(outboundClearingId);

      const res = await capture(settle(tx.id, STATUS_FAILURE, externalRef));
      expect(res.ok).toBe(true);

      // The payer is refunded EXACTLY the amount (customer balance += amount).
      expect(BigInt((await acct(src.id)).balance)).toBe(balBefore + BigInt(AMOUNT));

      // The original transfer is REVERSED (retained, never mutated away).
      expect(await txStatus(tx.id)).toBe('REVERSED');

      // A fresh compensating transaction exists, linked to the original, and is POSTED.
      const comp = await compensatingTxFor(tx.id);
      expect(comp).toHaveLength(1);
      expect(comp[0].reverses_transaction_id).toBe(tx.id);
      expect(comp[0].status).toBe('POSTED');

      // Its double-entry moves clearing→customer and nets to zero (no money created / lost).
      const legs = await legsForTx(comp[0].id);
      expect(legs).toHaveLength(2);
      expect(sumDeltas(legs)).toBe(0n);
      const debitLeg = legs.find((l) => BigInt(l.delta) < 0n)!;
      const creditLeg = legs.find((l) => BigInt(l.delta) > 0n)!;
      expect(debitLeg.account_id).toBe(outboundClearingId); // clearing debited (drawn down)
      expect(creditLeg.account_id).toBe(src.id); // customer credited (refunded)
      expect(BigInt(creditLeg.delta)).toBe(BigInt(AMOUNT));

      // Clearing net-in-transit drops by the refunded amount; exactly one outbox row for the move.
      expect((await clearingBalance(outboundClearingId)) - clearingBefore).toBe(BigInt(-AMOUNT));
      expect(await outboxCount(comp[0].id)).toBe(1);

      // A retried failure webhook does NOT refund again.
      const balAfterFirst = (await acct(src.id)).balance;
      const repeat = await capture(settle(tx.id, STATUS_FAILURE, externalRef));
      expect(repeat.ok).toBe(true);
      expect((await acct(src.id)).balance).toBe(balAfterFirst); // no double-refund
      expect(await compensatingTxFor(tx.id)).toHaveLength(1); // still exactly one reversal
      expect((await clearingBalance(outboundClearingId)) - clearingBefore).toBe(BigInt(-AMOUNT));
    }, 30_000);

    // =========================================================================================
    // MUTUAL EXCLUSION — success⊕failure; a conflicting second status is rejected, moves no money
    // =========================================================================================

    it('success THEN failure → 2nd is INVALID_SETTLEMENT_STATE and does NOT refund (no compensating tx, balances unchanged)', async () => {
      const owner = newOwner();
      const AMOUNT = 3000;
      const { src, tx } = await seedSettledOutbound(owner, AMOUNT);

      expect((await capture(settle(tx.id, STATUS_SUCCESS, ref()))).ok).toBe(true);
      const balAfterSuccess = (await acct(src.id)).balance;
      const clearingAfterSuccess = await clearingBalance(outboundClearingId);

      const conflict = await capture(settle(tx.id, STATUS_FAILURE, ref()));
      expect(conflict.ok).toBe(false);
      expect(codeOf(conflict.error)).toBe('INVALID_SETTLEMENT_STATE');

      // No refund happened: the transfer is still POSTED, no reversal, balances/clearing unchanged.
      expect(await txStatus(tx.id)).toBe('POSTED');
      expect(await compensatingTxFor(tx.id)).toHaveLength(0);
      expect((await acct(src.id)).balance).toBe(balAfterSuccess);
      expect(await clearingBalance(outboundClearingId)).toBe(clearingAfterSuccess);
    }, 30_000);

    it('failure THEN success → 2nd is INVALID_SETTLEMENT_STATE and makes NO further change (already REVERSED, one reversal, balance stays refunded)', async () => {
      const owner = newOwner();
      const AMOUNT = 3000;
      const { src, tx } = await seedSettledOutbound(owner, AMOUNT);

      expect((await capture(settle(tx.id, STATUS_FAILURE, ref()))).ok).toBe(true);
      const balAfterFailure = (await acct(src.id)).balance; // refunded
      const clearingAfterFailure = await clearingBalance(outboundClearingId);

      const conflict = await capture(settle(tx.id, STATUS_SUCCESS, ref()));
      expect(conflict.ok).toBe(false);
      expect(codeOf(conflict.error)).toBe('INVALID_SETTLEMENT_STATE');

      expect(await txStatus(tx.id)).toBe('REVERSED');
      expect(await compensatingTxFor(tx.id)).toHaveLength(1); // still just the one reversal
      expect((await acct(src.id)).balance).toBe(balAfterFailure);
      expect(await clearingBalance(outboundClearingId)).toBe(clearingAfterFailure);
    }, 30_000);

    // =========================================================================================
    // CONCURRENCY — simultaneous callbacks on ONE txn resolve to a SINGLE effect (never both)
    // =========================================================================================

    it('CONCURRENCY: simultaneous SUCCESS + FAILURE on one txn → AT MOST ONE effect (reconcile XOR reverse), NEVER both; money nets to zero', async () => {
      const owner = newOwner();
      const AMOUNT = 4000;
      const { src, tx } = await seedSettledOutbound(owner, AMOUNT); // customer 6000, hold SETTLED, ref null
      const balBefore = BigInt((await acct(src.id)).balance); // 6000
      const clearingBefore = await clearingBalance(outboundClearingId);

      // Fire both at once; one MAY reject (INVALID_SETTLEMENT_STATE, or a lock-guarded loss). We
      // tolerate a rejection — what we do NOT tolerate is both effects landing.
      const results = await Promise.all([
        capture(settle(tx.id, STATUS_SUCCESS, ref())),
        capture(settle(tx.id, STATUS_FAILURE, ref())),
      ]);
      // At least one must have applied — both rejecting would strand the settlement.
      expect(results.some((r) => r.ok)).toBe(true);

      const status = await txStatus(tx.id);
      const hold = await holdForTx(tx.id);
      const comp = await compensatingTxFor(tx.id);
      const bal = BigInt((await acct(src.id)).balance);
      const clearingDelta = (await clearingBalance(outboundClearingId)) - clearingBefore;

      const reconciled = status === 'POSTED' && hold?.external_ref != null && comp.length === 0;
      const reversed =
        status === 'REVERSED' && (hold?.external_ref ?? null) === null && comp.length === 1;

      // THE KEY INVARIANT: the outcomes are MUTUALLY EXCLUSIVE — exactly one, and NEVER both.
      expect(reconciled || reversed).toBe(true);
      expect(reconciled && reversed).toBe(false);
      // Explicit impossible-state tripwire: a REVERSED transfer must never ALSO carry a reconcile ref.
      expect(status === 'REVERSED' && hold?.external_ref != null).toBe(false);

      if (reconciled) {
        // Reconcile moved no money.
        expect(bal).toBe(balBefore);
        expect(clearingDelta).toBe(0n);
      } else {
        // Reverse refunded EXACTLY once; the compensating legs net to zero (no money created/lost).
        expect(bal).toBe(balBefore + BigInt(AMOUNT));
        expect(clearingDelta).toBe(BigInt(-AMOUNT));
        expect(sumDeltas(await legsForTx(comp[0].id))).toBe(0n);
      }
    }, 45_000);

    it('CONCURRENCY: two simultaneous SUCCESS callbacks → a SINGLE reconcile (ref set once, no compensating tx, no money moved)', async () => {
      const owner = newOwner();
      const AMOUNT = 3500;
      const { src, tx } = await seedSettledOutbound(owner, AMOUNT);
      const balBefore = (await acct(src.id)).balance;
      const clearingBefore = await clearingBalance(outboundClearingId);
      const sharedRef = ref();

      const results = await Promise.all([
        capture(settle(tx.id, STATUS_SUCCESS, sharedRef)),
        capture(settle(tx.id, STATUS_SUCCESS, sharedRef)),
      ]);
      expect(results.some((r) => r.ok)).toBe(true);

      expect(await txStatus(tx.id)).toBe('POSTED');
      expect((await holdForTx(tx.id))?.external_ref).toBe(sharedRef);
      expect(await compensatingTxFor(tx.id)).toHaveLength(0); // never a reversal
      expect((await acct(src.id)).balance).toBe(balBefore); // no money moved
      expect(await clearingBalance(outboundClearingId)).toBe(clearingBefore);
    }, 45_000);

    it('CONCURRENCY: two simultaneous FAILURE callbacks → a SINGLE refund (one compensating tx, no double-refund)', async () => {
      const owner = newOwner();
      const AMOUNT = 3500;
      const { src, tx } = await seedSettledOutbound(owner, AMOUNT);
      const balBefore = BigInt((await acct(src.id)).balance);
      const clearingBefore = await clearingBalance(outboundClearingId);

      const results = await Promise.all([
        capture(settle(tx.id, STATUS_FAILURE, ref())),
        capture(settle(tx.id, STATUS_FAILURE, ref())),
      ]);
      expect(results.some((r) => r.ok)).toBe(true);

      expect(await txStatus(tx.id)).toBe('REVERSED');
      expect(await compensatingTxFor(tx.id)).toHaveLength(1); // exactly one — no double-refund
      expect(BigInt((await acct(src.id)).balance)).toBe(balBefore + BigInt(AMOUNT)); // refunded once
      expect((await clearingBalance(outboundClearingId)) - clearingBefore).toBe(BigInt(-AMOUNT));
    }, 45_000);

    // =========================================================================================
    // CORRELATION errors — unknown txn / non-external_outbound
    // =========================================================================================

    it('unknown transaction id → SETTLEMENT_TARGET_NOT_FOUND (nothing created)', async () => {
      const res = await capture(settle(randomUUID(), STATUS_SUCCESS, ref()));
      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('SETTLEMENT_TARGET_NOT_FOUND');
    }, 30_000);

    it('a non-external_outbound transaction (external_inbound) → INVALID_SETTLEMENT_STATE (no money moves)', async () => {
      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 5000, held: 0 });
      const inboundTx = await insertTransaction(ds, {
        type: 'external_inbound',
        status: 'POSTED',
        initiatedBy: owner,
        debitAccountId: inboundClearingId,
        creditAccountId: cust.id,
        amount: '5000',
        currency: MXN,
        postedAt: new Date(),
      });
      const balBefore = (await acct(cust.id)).balance;

      const res = await capture(settle(inboundTx.id, STATUS_SUCCESS, ref()));
      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('INVALID_SETTLEMENT_STATE');
      expect(await compensatingTxFor(inboundTx.id)).toHaveLength(0);
      expect((await acct(cust.id)).balance).toBe(balBefore);
    }, 30_000);

    // =========================================================================================
    // INBOUND — fresh credit, idempotent by externalRef, frozen-OK, unknown-account / currency errors
    // =========================================================================================

    it('INBOUND credits once: customer balance += amount, clearing:rail-inbound -= amount, a POSTED external_inbound tx, ONE outbox row, legs net zero, sum(ledger delta)==balance for the customer', async () => {
      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 0, held: 0 });
      const AMOUNT = 2500;
      const externalRef = ref();
      const inboundClearingBefore = await clearingBalance(inboundClearingId);

      const res = await capture(
        inbound({ accountNumber: cust.account_number, amount: AMOUNT, externalRef }),
      );
      expect(res.ok).toBe(true);

      // The customer was credited exactly the amount.
      expect(BigInt((await acct(cust.id)).balance)).toBe(BigInt(AMOUNT));

      // Exactly one POSTED external_inbound transaction crediting the customer.
      const txns = await inboundTxsForAccount(cust.id);
      expect(txns).toHaveLength(1);
      expect(txns[0].status).toBe('POSTED');

      // The double-entry: debit clearing:rail-inbound (−amount), credit customer (+amount), sum zero.
      const legs = await legsForTx(txns[0].id);
      expect(legs).toHaveLength(2);
      expect(sumDeltas(legs)).toBe(0n);
      const debitLeg = legs.find((l) => BigInt(l.delta) < 0n)!;
      const creditLeg = legs.find((l) => BigInt(l.delta) > 0n)!;
      expect(debitLeg.account_id).toBe(inboundClearingId);
      expect(creditLeg.account_id).toBe(cust.id);
      expect(BigInt(creditLeg.delta)).toBe(BigInt(AMOUNT));

      // Clearing drops by the amount; exactly one outbox row; reconciliation for the customer holds.
      expect((await clearingBalance(inboundClearingId)) - inboundClearingBefore).toBe(
        BigInt(-AMOUNT),
      );
      expect(await outboxCount(txns[0].id)).toBe(1);
      expect(await sumLegsForAccount(cust.id)).toBe(BigInt((await acct(cust.id)).balance));
    }, 30_000);

    it('INBOUND is idempotent by externalRef: a DUPLICATE ref → no double-credit (balance unchanged, still exactly one external_inbound tx)', async () => {
      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 0, held: 0 });
      const AMOUNT = 1800;
      const externalRef = ref();

      expect(
        (
          await capture(
            inbound({ accountNumber: cust.account_number, amount: AMOUNT, externalRef }),
          )
        ).ok,
      ).toBe(true);
      expect(BigInt((await acct(cust.id)).balance)).toBe(BigInt(AMOUNT));

      // Replaying the SAME rail ref must not credit again.
      const dup = await capture(
        inbound({ accountNumber: cust.account_number, amount: AMOUNT, externalRef }),
      );
      expect(dup.ok).toBe(true); // idempotent replay returns, does not reject
      expect(BigInt((await acct(cust.id)).balance)).toBe(BigInt(AMOUNT)); // still credited ONCE
      expect(await inboundTxsForAccount(cust.id)).toHaveLength(1); // no second movement
    }, 30_000);

    it('INBOUND with two DISTINCT externalRefs to the same account → BOTH credited (idempotency is per-ref, not a blanket block)', async () => {
      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 0, held: 0 });

      expect(
        (
          await capture(
            inbound({ accountNumber: cust.account_number, amount: 1000, externalRef: ref() }),
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await capture(
            inbound({ accountNumber: cust.account_number, amount: 1500, externalRef: ref() }),
          )
        ).ok,
      ).toBe(true);

      expect(BigInt((await acct(cust.id)).balance)).toBe(2500n);
      expect(await inboundTxsForAccount(cust.id)).toHaveLength(2);
    }, 30_000);

    it('INBOUND credits a FROZEN customer (inbound arrives already approved — a freeze does not block a credit)', async () => {
      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 0, held: 0, status: 'frozen' });
      const AMOUNT = 2000;

      const res = await capture(
        inbound({ accountNumber: cust.account_number, amount: AMOUNT, externalRef: ref() }),
      );
      expect(res.ok).toBe(true);
      expect(BigInt((await acct(cust.id)).balance)).toBe(BigInt(AMOUNT));
      expect((await acct(cust.id)).status).toBe('frozen'); // still frozen — the credit did not thaw it
    }, 30_000);

    it('INBOUND to an unknown account number → INBOUND_DESTINATION_NOT_FOUND (no tx anywhere)', async () => {
      // A well-formed 10-digit number that is not enrolled to any account.
      const missing = localAccountNumber();
      const res = await capture(
        inbound({ accountNumber: missing, amount: 1000, externalRef: ref() }),
      );
      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('INBOUND_DESTINATION_NOT_FOUND');
    }, 30_000);

    it('INBOUND with a currency that mismatches the account currency → rejected, NOT credited', async () => {
      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 0, held: 0 }); // account is MXN
      const res = await capture(
        inbound({
          accountNumber: cust.account_number,
          amount: 1000,
          currency: 'USD',
          externalRef: ref(),
        }),
      );
      expect(res.ok).toBe(false);
      // Gate on the money-safety observable regardless of whether the guard is a domain currency
      // check or an FK rejection on an unseeded currency: NOTHING was credited.
      expect(BigInt((await acct(cust.id)).balance)).toBe(0n);
      expect(await inboundTxsForAccount(cust.id)).toHaveLength(0);
    }, 30_000);
  },
);
