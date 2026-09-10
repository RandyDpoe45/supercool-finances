/**
 * Spec 04 — Balance Service, Transfers: EXTERNAL OUTBOUND (initiate places a hold, OTP-confirm
 * SETTLES it) + the reservation ledger, driven against the REAL DI'd TransfersService (resolved BY
 * TOKEN through a booted AppModule) with real Postgres + real Redis. These are the money-safety
 * proofs for spec 04, step 5b. Written FROM the spec (Transfers "External outbound", "Holds
 * (reservation ledger)", the DoD) + the developer-locked brief, NOT from the implementor's code:
 *   - INITIATE reserves, never moves: available drops (`held += amount`), balance UNCHANGED; a
 *     `Hold(PLACED)` is inserted; a PENDING `external_outbound` txn credits the outbound clearing
 *     account; SUM(PLACED holds) == account.held.
 *   - CONFIRM settles at confirm: one tx decrements `held`, marks the hold SETTLED, posts the
 *     customer→clearing double-entry (balance −= amount, clearing += amount), transitions
 *     PENDING→POSTED, writes ONE outbox row.
 *   - RELEASE paths (expiry / auto-supersede / cancel) return the funds (`held −=`, hold RELEASED)
 *     with NO ledger entry and NO balance change.
 *   - MONEY-ONCE under N concurrent confirms; INSUFFICIENT_FUNDS / frozen-source / cooling-off gates.
 *   - RECONCILIATION across a mixed sequence: SUM(PLACED per account) == account.held for every
 *     account, and the clearing account nets the settled outflows.
 *
 * Why DB+Redis-backed and not mocked: the invariants here (funds reserved-not-moved, the
 * held-decrement-BEFORE-post ordering that lets a fully-reserved balance still settle, money moving
 * exactly once under a concurrent confirm, holds reconciling to `held`) are properties of REAL
 * transactions and REAL Redis — mocking them would mock away the very logic under test. Every
 * assertion gates on OBSERVABLE STATE (balances, held, hold rows, ledger legs, txn status, outbox
 * count, clearing-account delta), never on the error kind alone.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a
 * false pass). beforeAll TCP-probes BOTH Postgres and Redis and fails loud if unreachable; boots the
 * real AppModule (migrationsRun:true → MXN + clearing accounts + schema). jest.config.ts serializes
 * the integration run (maxWorkers:1) — the shared clearing account is read as a DELTA (before/after),
 * never an absolute, so cross-test drift is irrelevant. Unique account/owner ids per test; committed
 * rows (incl. holds + payees) and minted OTP keys cleaned up per-test.
 *
 * To run:
 *   BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=… REDIS_HOST=… REDIS_PORT=…] npm test
 */
import 'reflect-metadata';
import { createHmac, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  getAppModule,
  getTransfersServiceToken,
  getOtpServiceToken,
  getRedisClientToken,
  getOutboundRail,
  getDomainErrors,
  tcpProbe,
} from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
// Namespace import: `insertHold` is authored in parallel by the implementor (the FIXED step-5b
// support contract). Referencing it via the namespace keeps this file compiling before that lands
// (the suite is honest-SKIP-gated anyway); beforeAll asserts it is present when the gate runs.
import * as pg from '../support/pg';
const {
  insertRow,
  insertCustomer,
  insertExternalPayee,
  insertTransaction,
  localAccountNumber,
  TODAY,
  MONTH_START,
} = pg;

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED external-outbound transfers suite: set BALANCE_INTEGRATION=1 (and point ' +
      'DB_* at Postgres AND REDIS_* at Redis — the confirm/settle path needs both) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789';
const MXN = 'MXN';

const suite = ENABLED ? describe : describe.skip;

suite(
  'external outbound transfers — holds place/settle/release, money-once, reconciliation (integration, needs Postgres + Redis)',
  () => {
    let app: INestApplication;
    let ds: any;
    let svc: any;
    let otp: any;
    let redis: any;
    let outboundRail: string;
    let clearingId: string;
    let domainErrors: ReturnType<typeof getDomainErrors> & Record<string, any>;

    let createdAccountIds: string[] = [];
    let trackedOwners: string[] = [];
    let trackedRedisKeys: string[] = [];

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
        OTP_HASH_SECRET,
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

      svc = app.get(getTransfersServiceToken(), { strict: false });
      if (
        !svc ||
        typeof svc.initiateExternalTransfer !== 'function' ||
        typeof svc.confirmTransfer !== 'function' ||
        typeof svc.cancelTransfer !== 'function' ||
        typeof svc.getPendingAuthorization !== 'function'
      ) {
        throw new Error(
          '[integration] resolved the transfers service but it lacks initiateExternalTransfer / ' +
            'confirmTransfer / cancelTransfer / getPendingAuthorization. Reconcile the contract at ' +
            'tests/support/harness.ts:getTransfersServiceToken (new method: initiateExternalTransfer).',
        );
      }

      otp = app.get(getOtpServiceToken(), { strict: false });
      if (!otp || typeof otp.generate !== 'function') {
        throw new Error('[integration] resolved the OTP service but it has no generate(userId).');
      }

      redis = app.get(getRedisClientToken(), { strict: false });
      if (!redis || typeof redis.del !== 'function') {
        throw new Error(
          '[integration] could not resolve a usable ioredis client via REDIS_CLIENT.',
        );
      }

      outboundRail = getOutboundRail();
      const clearing = await ds.query(
        `SELECT id FROM account WHERE kind = 'system' AND system_key = $1`,
        [`clearing:${outboundRail}`],
      );
      if (!clearing[0]?.id) {
        throw new Error(
          `[integration] the outbound clearing account (system_key clearing:${outboundRail}) is not ` +
            'seeded — the migration SeedSystemAccounts must have run.',
        );
      }
      clearingId = clearing[0].id;

      if (typeof (pg as any).insertHold !== 'function') {
        throw new Error(
          '[integration] pg.insertHold is not available in tests/support/pg.ts — the implementor owns ' +
            'this fixture (the FIXED step-5b support contract). Reconcile the contract before running the gate.',
        );
      }

      domainErrors = getDomainErrors() as any;
    }, 60_000);

    afterEach(async () => {
      const ids = createdAccountIds;
      const owners = trackedOwners;
      const redisKeys = Array.from(new Set(trackedRedisKeys));
      createdAccountIds = [];
      trackedOwners = [];
      trackedRedisKeys = [];
      if (redis && redisKeys.length) {
        try {
          await redis.del(...redisKeys);
        } catch {
          /* best-effort */
        }
      }
      try {
        await cleanup(ids, owners);
      } catch {
        /* best-effort; random ids keep re-runs safe */
      }
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    // ---- seed + query helpers (committed rows) --------------------------------------------

    function newOwner(): string {
      const o = `sub-${randomUUID()}`;
      trackedOwners.push(o);
      return o;
    }

    /** A committed customer account (customer FK parent + account carrying a unique 10-digit number).
     *  `overrides` may set balance / held / status. */
    async function mkCustomer(
      owner: string,
      overrides: Record<string, unknown> = {},
    ): Promise<any> {
      await insertCustomer(ds, owner);
      const acc = await insertRow(ds, 'account', {
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

    /** A committed, USABLE enrolled payee for `owner` (cooling-off in the PAST by default). */
    async function mkPayee(
      owner: string,
      opts: { displayName?: string; coolingOffUntil?: Date; destinationRef?: string } = {},
    ): Promise<any> {
      return insertExternalPayee(ds, {
        ownerId: owner,
        displayName: opts.displayName ?? 'Acme Payments',
        destinationRef: opts.destinationRef ?? localDigits(),
        rail: outboundRail,
        coolingOffUntil: opts.coolingOffUntil ?? new Date(Date.now() - 60_000),
      });
    }

    function localDigits(): string {
      let s = '';
      for (let i = 0; i < 12; i++) s += String(Math.floor(Math.random() * 10));
      return s;
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
      // Ledger legs on the shared clearing account referencing my txns are already dropped above; the
      // clearing account's materialized balance is intentionally left as-is (all clearing assertions
      // use before/after DELTAS, never absolutes) so teardown need not reverse a committed settle.
      if (ids.length) await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
      if (owners.length) await ds.query(`DELETE FROM customer WHERE id = ANY($1)`, [owners]);
    }

    async function acct(id: string): Promise<{ balance: string; held: string; status: string }> {
      const r = await ds.query(`SELECT balance, held, status FROM account WHERE id = $1`, [id]);
      return r[0];
    }

    async function clearingBalance(): Promise<bigint> {
      const r = await ds.query(`SELECT balance FROM account WHERE id = $1`, [clearingId]);
      return BigInt(r[0].balance);
    }

    /** SUM of PLACED holds for an account, as a bigint (the reconciliation left-hand side). */
    async function sumPlaced(accountId: string): Promise<bigint> {
      const r = await ds.query(
        `SELECT COALESCE(SUM(amount), 0)::text AS s FROM hold WHERE account_id = $1 AND status = 'PLACED'`,
        [accountId],
      );
      return BigInt(r[0].s);
    }

    async function holdsForTx(
      txId: string,
    ): Promise<Array<{ id: string; account_id: string; amount: string; status: string }>> {
      return ds.query(`SELECT id, account_id, amount, status FROM hold WHERE transaction_id = $1`, [
        txId,
      ]);
    }

    async function holdsForAccount(
      accountId: string,
    ): Promise<Array<{ amount: string; status: string }>> {
      return ds.query(`SELECT amount, status FROM hold WHERE account_id = $1`, [accountId]);
    }

    async function legsForTx(txId: string): Promise<Array<{ account_id: string; delta: string }>> {
      return ds.query(`SELECT account_id, delta FROM ledger_entry WHERE transaction_id = $1`, [
        txId,
      ]);
    }

    async function txStatus(txId: string): Promise<string | undefined> {
      const r = await ds.query(`SELECT status FROM "transaction" WHERE id = $1`, [txId]);
      return r[0]?.status;
    }

    async function txRow(
      txId: string,
    ): Promise<{ status: string; type: string; credit_account_id: string | null } | undefined> {
      const r = await ds.query(
        `SELECT status, type, credit_account_id FROM "transaction" WHERE id = $1`,
        [txId],
      );
      return r[0];
    }

    async function outboxCount(txId: string): Promise<number> {
      const r = await ds.query(
        `SELECT count(*)::int AS n FROM outbox_event WHERE transaction_id = $1`,
        [txId],
      );
      return r[0].n;
    }

    async function pendingCountFor(owner: string): Promise<number> {
      const r = await ds.query(
        `SELECT count(*)::int AS n FROM "transaction" WHERE initiated_by = $1 AND status = 'PENDING'`,
        [owner],
      );
      return r[0].n;
    }

    async function anyTxCountFor(owner: string): Promise<number> {
      const r = await ds.query(
        `SELECT count(*)::int AS n FROM "transaction" WHERE initiated_by = $1`,
        [owner],
      );
      return r[0].n;
    }

    const sumDeltas = (legs: Array<{ delta: string }>): bigint =>
      legs.reduce((s, l) => s + BigInt(l.delta), 0n);

    // ---- service adapters -----------------------------------------------------------------

    function idOf(r: any): string {
      return (r?.transaction?.id ?? r?.id ?? r?.transactionId ?? r?.transferId) as string;
    }
    function statusOf(r: any): string | undefined {
      return r?.transaction?.status ?? r?.status;
    }

    async function initiateExternal(
      owner: string,
      sourceId: string,
      payeeId: string,
      amount: number,
      opts: { currency?: string; key?: string; confirmDuplicate?: boolean } = {},
    ): Promise<any> {
      const k = opts.key ?? `key-${randomUUID()}`;
      const params: any = {
        ownerId: owner,
        sub: owner,
        sourceAccountId: sourceId,
        payeeId,
        amount: String(amount), // canonical unsigned minor-unit string, never a JS number
        currency: opts.currency ?? MXN,
        idempotencyKey: k,
        key: k,
      };
      if (opts.confirmDuplicate !== undefined) params.confirmDuplicate = opts.confirmDuplicate;
      return svc.initiateExternalTransfer(params);
    }

    async function confirm(owner: string, transferId: string, code: string): Promise<any> {
      return svc.confirmTransfer({
        ownerId: owner,
        sub: owner,
        transferId,
        id: transferId,
        transactionId: transferId,
        code,
      });
    }

    async function cancel(owner: string, transferId: string): Promise<any> {
      return svc.cancelTransfer({
        ownerId: owner,
        sub: owner,
        transferId,
        id: transferId,
        transactionId: transferId,
      });
    }

    async function getPending(owner: string): Promise<any> {
      return svc.getPendingAuthorization(owner);
    }

    async function generateOtp(owner: string): Promise<string> {
      const r = await otp.generate(owner);
      const code = r.code as string;
      trackedRedisKeys.push(`otp:${owner}`);
      trackedRedisKeys.push(
        `otp:${owner}:${createHmac('sha256', OTP_HASH_SECRET).update(`${owner}:${code}`).digest('hex')}`,
      );
      return code;
    }

    async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
      try {
        return { ok: true, value: await p };
      } catch (error) {
        return { ok: false, error };
      }
    }

    function codeOf(err: any): string {
      const de = domainErrors as any;
      if (de.PayeeNotFoundError && err instanceof de.PayeeNotFoundError) return 'PAYEE_NOT_FOUND';
      if (de.PayeeInCoolingOffError && err instanceof de.PayeeInCoolingOffError)
        return 'PAYEE_IN_COOLING_OFF';
      if (de.InsufficientFundsError && err instanceof de.InsufficientFundsError)
        return 'INSUFFICIENT_FUNDS';
      if (de.AccountFrozenError && err instanceof de.AccountFrozenError) return 'ACCOUNT_FROZEN';
      if (de.TransferExpiredError && err instanceof de.TransferExpiredError)
        return 'TRANSFER_EXPIRED';
      if (de.TransferNotPendingError && err instanceof de.TransferNotPendingError)
        return 'TRANSFER_NOT_PENDING';
      if (de.TransactionNotPendingError && err instanceof de.TransactionNotPendingError)
        return 'TRANSFER_NOT_PENDING';
      if (de.TransferNotFoundError && err instanceof de.TransferNotFoundError)
        return 'TRANSFER_NOT_FOUND';
      return (err?.code ?? err?.driverError?.code ?? '') as string;
    }

    // =========================================================================================
    // INITIATE reserves, does NOT move money
    // =========================================================================================

    it('INITIATE places a hold: balance UNCHANGED, held += amount, a PLACED hold exists, txn is PENDING external_outbound crediting clearing, SUM(PLACED)==held', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const payee = await mkPayee(owner, { displayName: 'Acme Payments' });
      const AMOUNT = 4000;

      const initiated = await initiateExternal(owner, src.id, payee.id, AMOUNT);
      const transferId = idOf(initiated);
      expect(typeof transferId).toBe('string');
      expect(statusOf(initiated)).toBe('PENDING');

      // No balance moved at initiate — only `available` drops via `held`.
      const a = await acct(src.id);
      expect(a.balance).toBe('10000'); // balance untouched
      expect(a.held).toBe('4000'); // available = 10000 − 4000 = 6000

      // The reservation ledger: exactly one PLACED hold on the source for this txn, of `amount`.
      const holds = await holdsForTx(transferId);
      expect(holds).toHaveLength(1);
      expect(holds[0].account_id).toBe(src.id);
      expect(holds[0].amount).toBe('4000');
      expect(holds[0].status).toBe('PLACED');

      // The header is a PENDING external_outbound crediting the outbound clearing account.
      const row = await txRow(transferId);
      expect(row?.status).toBe('PENDING');
      expect(row?.type).toBe('external_outbound');
      expect(row?.credit_account_id).toBe(clearingId);

      // NO money moved: no ledger legs, no outbox row yet (those are written at settle).
      expect(await legsForTx(transferId)).toHaveLength(0);
      expect(await outboxCount(transferId)).toBe(0);

      // Reconciliation invariant: PLACED holds sum to the materialized `held`.
      expect(await sumPlaced(src.id)).toBe(BigInt(a.held));
      expect(await sumPlaced(src.id)).toBe(4000n);
    }, 30_000);

    // =========================================================================================
    // SETTLE at confirm — the customer→clearing double-entry, hold SETTLED, money moves once
    // =========================================================================================

    it('CONFIRM settles: balance −= amount, held back to prior, hold SETTLED, txn POSTED, clearing += amount, one outbox row, legs net zero (customer→clearing)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const payee = await mkPayee(owner);
      const AMOUNT = 4000;

      const initiated = await initiateExternal(owner, src.id, payee.id, AMOUNT);
      const transferId = idOf(initiated);
      const clearingBefore = await clearingBalance();

      const code = await generateOtp(owner);
      const confirmed = await confirm(owner, transferId, code);
      expect(statusOf(confirmed)).toBe('POSTED');

      // The customer balance dropped by amount EXACTLY ONCE; held returned to its prior level (0).
      const a = await acct(src.id);
      expect(a.balance).toBe('6000');
      expect(a.held).toBe('0');

      // The backing hold is SETTLED (not RELEASED — settlement converts it to a posted movement).
      const holds = await holdsForTx(transferId);
      expect(holds).toHaveLength(1);
      expect(holds[0].status).toBe('SETTLED');

      // The header is POSTED and the money left the customer INTO the clearing account.
      expect(await txStatus(transferId)).toBe('POSTED');
      expect((await clearingBalance()) - clearingBefore).toBe(BigInt(AMOUNT)); // clearing += amount

      // The double-entry: debit leg = source (−amount), credit leg = clearing (+amount), sum zero.
      const legs = await legsForTx(transferId);
      expect(legs).toHaveLength(2);
      expect(sumDeltas(legs)).toBe(0n);
      const debitLeg = legs.find((l) => BigInt(l.delta) < 0n)!;
      const creditLeg = legs.find((l) => BigInt(l.delta) > 0n)!;
      expect(debitLeg.account_id).toBe(src.id);
      expect(BigInt(debitLeg.delta)).toBe(BigInt(-AMOUNT));
      expect(creditLeg.account_id).toBe(clearingId);
      expect(BigInt(creditLeg.delta)).toBe(BigInt(AMOUNT));

      // Exactly one outbox row for the money movement; SUM(PLACED) still tracks `held` (both 0).
      expect(await outboxCount(transferId)).toBe(1);
      expect(await sumPlaced(src.id)).toBe(0n);
      expect(await sumPlaced(src.id)).toBe(BigInt(a.held));
    }, 30_000);

    // =========================================================================================
    // FUNDS-ALREADY-RESERVED — the tripwire for held-decrement-BEFORE-post ordering
    // =========================================================================================

    it('FUNDS-ALREADY-RESERVED: a source funded EXACTLY to the amount (available==0 after the hold) still SETTLES — balance ends 0, held 0 (settle must not double-count its own hold)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 5000, held: 0 });
      const payee = await mkPayee(owner);
      const AMOUNT = 5000; // the ENTIRE balance is reserved by this hold → available == 0

      const initiated = await initiateExternal(owner, src.id, payee.id, AMOUNT);
      const transferId = idOf(initiated);
      // After the hold: balance still 5000, held 5000, available 0.
      expect((await acct(src.id)).held).toBe('5000');
      expect((await acct(src.id)).balance).toBe('5000');

      const code = await generateOtp(owner);
      const settled = await capture(confirm(owner, transferId, code));

      // If the settle checked available (balance − held) BEFORE releasing this hold, it would see
      // 0 < 5000 and wrongly reject with INSUFFICIENT_FUNDS. The hold must be decremented FIRST.
      expect(settled.ok).toBe(true);
      expect(statusOf(settled.value)).toBe('POSTED');

      const a = await acct(src.id);
      expect(a.balance).toBe('0'); // the money left exactly once
      expect(a.held).toBe('0'); // the hold was consumed, not double-counted
      const holds = await holdsForTx(transferId);
      expect(holds[0].status).toBe('SETTLED');
      expect(await sumPlaced(src.id)).toBe(0n);
      expect(await legsForTx(transferId)).toHaveLength(2);
    }, 30_000);

    // =========================================================================================
    // RELEASE on expiry — lazy EXPIRED + hold RELEASED, no ledger entry, balance untouched
    // =========================================================================================

    it('RELEASE on expiry: an OVERDUE external pending → on read it becomes EXPIRED and its hold EXPIRED (held −=, balance untouched, NO ledger entry); SUM(PLACED)==held', async () => {
      const owner = newOwner();
      const AMOUNT = 3000;
      // Seed the reserved state directly (no scheduler ran): balance intact, held == amount, one
      // PLACED hold on the source backing an OVERDUE external_outbound pending.
      const src = await mkCustomer(owner, { balance: 10000, held: AMOUNT });
      const overdue = await insertTransaction(ds, {
        type: 'external_outbound',
        initiatedBy: owner,
        debitAccountId: src.id,
        creditAccountId: clearingId,
        amount: String(AMOUNT),
        currency: MXN,
        expiresAt: new Date(Date.now() - 60_000),
      });
      await (pg as any).insertHold(ds, {
        accountId: src.id,
        transactionId: overdue.id,
        amount: AMOUNT,
        status: 'PLACED',
        rail: outboundRail,
        expiresAt: new Date(Date.now() - 60_000),
      });
      // Precondition: SUM(PLACED)==held before the lazy sweep.
      expect(await sumPlaced(src.id)).toBe(BigInt(AMOUNT));
      expect((await acct(src.id)).held).toBe(String(AMOUNT));

      // Reading the pending feed finds nothing valid AND lazily expires the overdue transfer...
      expect((await getPending(owner)) ?? null).toBeNull();

      // ...transitioning it to EXPIRED (retained) and EXPIRING its hold — the funds return.
      expect((await txRow(overdue.id))?.status).toBe('EXPIRED');
      const holds = await holdsForTx(overdue.id);
      expect(holds).toHaveLength(1);
      // Terminal hold status distinction: a TTL time-out → EXPIRED; an explicit cancel / auto-supersede
      // → RELEASED. This is the TTL path, so the hold is EXPIRED (not RELEASED).
      expect(holds[0].status).toBe('EXPIRED');

      const a = await acct(src.id);
      expect(a.balance).toBe('10000'); // balance never touched by an expiry release
      expect(a.held).toBe('0'); // funds returned
      expect(await legsForTx(overdue.id)).toHaveLength(0); // no money moved → no ledger entry
      expect(await sumPlaced(src.id)).toBe(BigInt(a.held)); // reconciliation holds after the release
    }, 30_000);

    it('CONFIRM on an OVERDUE external pending → TRANSFER_EXPIRED, hold EXPIRED, held back to prior, balance untouched, NO ledger entry', async () => {
      const owner = newOwner();
      const AMOUNT = 2500;
      const src = await mkCustomer(owner, { balance: 8000, held: AMOUNT });
      const overdue = await insertTransaction(ds, {
        type: 'external_outbound',
        initiatedBy: owner,
        debitAccountId: src.id,
        creditAccountId: clearingId,
        amount: String(AMOUNT),
        currency: MXN,
        expiresAt: new Date(Date.now() - 60_000),
      });
      await (pg as any).insertHold(ds, {
        accountId: src.id,
        transactionId: overdue.id,
        amount: AMOUNT,
        status: 'PLACED',
        rail: outboundRail,
        expiresAt: new Date(Date.now() - 60_000),
      });

      const code = await generateOtp(owner);
      const res = await capture(confirm(owner, overdue.id, code));
      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('TRANSFER_EXPIRED');

      expect((await txRow(overdue.id))?.status).toBe('EXPIRED');
      // TTL time-out → hold EXPIRED (an explicit cancel / auto-supersede would be RELEASED instead).
      expect((await holdsForTx(overdue.id))[0].status).toBe('EXPIRED');
      const a = await acct(src.id);
      expect(a.balance).toBe('8000');
      expect(a.held).toBe('0');
      expect(await legsForTx(overdue.id)).toHaveLength(0);
      expect(await sumPlaced(src.id)).toBe(0n);
    }, 30_000);

    // =========================================================================================
    // AUTO-SUPERSEDE releases the prior hold
    // =========================================================================================

    it('AUTO-SUPERSEDE: initiating B (external) while A (external) is pending → A CANCELLED + A hold RELEASED; held reflects only B; exactly one PENDING; balances untouched', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 20000, held: 0 });
      const payee = await mkPayee(owner);

      const a = await initiateExternal(owner, src.id, payee.id, 1000);
      const aId = idOf(a);
      expect((await acct(src.id)).held).toBe('1000');

      const b = await initiateExternal(owner, src.id, payee.id, 3000); // distinct amount → not soft-dup
      const bId = idOf(b);
      expect(bId).not.toBe(aId);

      // A is superseded (CANCELLED, retained) and its hold is RELEASED; B's hold is the only PLACED one.
      // Distinction is intentional: an explicit cancel / auto-supersede → hold RELEASED; a TTL time-out
      // → hold EXPIRED (see the release-on-expiry tests above).
      expect(await txStatus(aId)).toBe('CANCELLED');
      expect((await holdsForTx(aId))[0].status).toBe('RELEASED');
      expect((await holdsForTx(bId))[0].status).toBe('PLACED');
      expect(await pendingCountFor(owner)).toBe(1);
      expect(await txStatus(bId)).toBe('PENDING');

      // held now reflects ONLY B's hold (3000), and SUM(PLACED) tracks it. No balance moved.
      const acc = await acct(src.id);
      expect(acc.held).toBe('3000');
      expect(acc.balance).toBe('20000');
      expect(await sumPlaced(src.id)).toBe(3000n);
      expect(await legsForTx(aId)).toHaveLength(0);
      expect(await legsForTx(bId)).toHaveLength(0);
    }, 30_000);

    it('AUTO-SUPERSEDE of an OVERDUE prior: initiating B while A is already past its TTL → A EXPIRED + A hold EXPIRED (NOT released); B is the single PENDING; held reflects only B; balances untouched', async () => {
      const owner = newOwner();
      const A_AMOUNT = 1500;
      const B_AMOUNT = 3000;
      // Seed A directly as the initiator's single PENDING external pending, already OVERDUE, with a
      // PLACED hold and held == A's reservation (no scheduler ran).
      const src = await mkCustomer(owner, { balance: 20000, held: A_AMOUNT });
      const payee = await mkPayee(owner);
      const overdueA = await insertTransaction(ds, {
        type: 'external_outbound',
        initiatedBy: owner,
        debitAccountId: src.id,
        creditAccountId: clearingId,
        amount: String(A_AMOUNT),
        currency: MXN,
        expiresAt: new Date(Date.now() - 60_000),
      });
      await (pg as any).insertHold(ds, {
        accountId: src.id,
        transactionId: overdueA.id,
        amount: A_AMOUNT,
        status: 'PLACED',
        rail: outboundRail,
        expiresAt: new Date(Date.now() - 60_000),
      });

      // A NEW initiate triggers the prior-pending sweep. Because A is OVERDUE, its terminal labels
      // are the TTL ones (transaction EXPIRED, hold EXPIRED) — NOT the cancel/supersede RELEASED —
      // even though it was a fresh initiate (not a read/confirm) that drove the sweep. This pins the
      // overdue→EXPIRED branch of releasePriorExternalPendingHold.
      const b = await initiateExternal(owner, src.id, payee.id, B_AMOUNT);
      const bId = idOf(b);

      expect(await txStatus(overdueA.id)).toBe('EXPIRED');
      expect((await holdsForTx(overdueA.id))[0].status).toBe('EXPIRED'); // TTL time-out, not RELEASED
      expect(await txStatus(bId)).toBe('PENDING');
      expect((await holdsForTx(bId))[0].status).toBe('PLACED');
      expect(await pendingCountFor(owner)).toBe(1);

      // held reflects ONLY B's reservation (A's expired hold released its funds); balance untouched.
      const acc = await acct(src.id);
      expect(acc.held).toBe(String(B_AMOUNT));
      expect(acc.balance).toBe('20000');
      expect(await sumPlaced(src.id)).toBe(BigInt(B_AMOUNT));
      expect(await legsForTx(overdueA.id)).toHaveLength(0); // expiry moved no money
      expect(await legsForTx(bId)).toHaveLength(0); // B not yet confirmed
    }, 30_000);

    // =========================================================================================
    // CANCEL releases the hold
    // =========================================================================================

    it('CANCEL: initiate → cancel → hold RELEASED, held back to prior, balance untouched, txn CANCELLED (retained), no ledger entry', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const payee = await mkPayee(owner);
      const AMOUNT = 2000;

      const initiated = await initiateExternal(owner, src.id, payee.id, AMOUNT);
      const transferId = idOf(initiated);
      expect((await acct(src.id)).held).toBe('2000');

      const cancelled = await cancel(owner, transferId);
      expect(statusOf(cancelled)).toBe('CANCELLED');

      expect(await txStatus(transferId)).toBe('CANCELLED'); // retained, not deleted
      // Explicit cancel → hold RELEASED (a TTL time-out would be EXPIRED instead).
      expect((await holdsForTx(transferId))[0].status).toBe('RELEASED');
      const a = await acct(src.id);
      expect(a.held).toBe('0'); // funds returned
      expect(a.balance).toBe('10000'); // never moved
      expect(await legsForTx(transferId)).toHaveLength(0);
      expect(await sumPlaced(src.id)).toBe(0n);
      expect((await getPending(owner)) ?? null).toBeNull();
    }, 30_000);

    // =========================================================================================
    // MONEY-ONCE under N concurrent confirms
    // =========================================================================================

    it('MONEY-ONCE: N concurrent confirms of one external pending → balance debited once, hold SETTLED once (0 PLACED), one POSTED, one outbox row, clearing += amount once', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const payee = await mkPayee(owner);
      const AMOUNT = 3000;
      const N = 8;

      const initiated = await initiateExternal(owner, src.id, payee.id, AMOUNT);
      const transferId = idOf(initiated);
      const clearingBefore = await clearingBalance();
      const code = await generateOtp(owner);

      await Promise.allSettled(Array.from({ length: N }, () => confirm(owner, transferId, code)));

      // Settled exactly once: one pair of legs, netting zero; balance debited once; no overdraft.
      const legs = await legsForTx(transferId);
      expect(legs).toHaveLength(2); // NOT 2·k
      expect(sumDeltas(legs)).toBe(0n);
      expect(await txStatus(transferId)).toBe('POSTED');
      expect(await outboxCount(transferId)).toBe(1);
      const a = await acct(src.id);
      expect(a.balance).toBe(String(10000 - AMOUNT));
      expect(a.held).toBe('0');

      // The hold reached SETTLED exactly once — never SETTLED twice, never left PLACED.
      const holds = await holdsForAccount(src.id);
      expect(holds.filter((h) => h.status === 'SETTLED')).toHaveLength(1);
      expect(holds.filter((h) => h.status === 'PLACED')).toHaveLength(0);
      expect(await sumPlaced(src.id)).toBe(0n);

      // The clearing account gained the amount exactly once (delta), not N times.
      expect((await clearingBalance()) - clearingBefore).toBe(BigInt(AMOUNT));
    }, 45_000);

    // =========================================================================================
    // Gate rejections at INITIATE — frozen source / cooling-off payee / insufficient available
    // =========================================================================================

    it('FROZEN source: initiate external on a frozen source is rejected; NO hold placed, held unchanged, no PENDING txn', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0, status: 'frozen' });
      const payee = await mkPayee(owner);

      const res = await capture(initiateExternal(owner, src.id, payee.id, 1000));
      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('ACCOUNT_FROZEN');

      expect((await acct(src.id)).held).toBe('0'); // no reservation
      expect(await holdsForAccount(src.id)).toHaveLength(0);
      expect(await anyTxCountFor(owner)).toBe(0); // the money machinery never created a header
    }, 30_000);

    it('COOLING-OFF payee: initiate external to a payee still in cooling-off → PAYEE_IN_COOLING_OFF (409); no hold, no PENDING txn', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      // A payee whose cooling-off window is still in the FUTURE (not yet usable).
      const payee = await mkPayee(owner, { coolingOffUntil: new Date(Date.now() + 3_600_000) });

      const res = await capture(initiateExternal(owner, src.id, payee.id, 1000));
      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('PAYEE_IN_COOLING_OFF');

      expect((await acct(src.id)).held).toBe('0');
      expect(await holdsForAccount(src.id)).toHaveLength(0);
      expect(await anyTxCountFor(owner)).toBe(0);
    }, 30_000);

    it("NON-OWNED / missing payee: initiate external addressing another user's payee → 404-class (no leak); no hold, no PENDING txn", async () => {
      const attacker = newOwner();
      const victim = newOwner();
      const src = await mkCustomer(attacker, { balance: 10000, held: 0 });
      const victimPayee = await mkPayee(victim); // enrolled by the victim, not the attacker

      const res = await capture(initiateExternal(attacker, src.id, victimPayee.id, 1000));
      expect(res.ok).toBe(false);
      expect(['PAYEE_NOT_FOUND', 'TRANSFER_NOT_FOUND']).toContain(codeOf(res.error));

      expect((await acct(src.id)).held).toBe('0');
      expect(await holdsForAccount(src.id)).toHaveLength(0);
      expect(await anyTxCountFor(attacker)).toBe(0);
    }, 30_000);

    it('INSUFFICIENT available: initiate external for more than available (balance − held) → INSUFFICIENT_FUNDS; no hold, held unchanged, no PENDING txn', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 1000, held: 0 }); // available = 1000
      const payee = await mkPayee(owner);

      const res = await capture(initiateExternal(owner, src.id, payee.id, 5000)); // > available
      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('INSUFFICIENT_FUNDS');

      // No reservation was made — the funds check is the gate BEFORE a hold is placed.
      expect((await acct(src.id)).held).toBe('0');
      expect(await holdsForAccount(src.id)).toHaveLength(0);
      expect(await anyTxCountFor(owner)).toBe(0);
      expect(await sumPlaced(src.id)).toBe(0n);
    }, 30_000);

    // =========================================================================================
    // getPendingAuthorization — external pending shows type + payeeDisplayName (dest fields null)
    // =========================================================================================

    it('getPendingAuthorization for an external pending: type=external_outbound + payeeDisplayName; destinationAccountNumber/destinationMaskedName are null', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const payee = await mkPayee(owner, { displayName: 'Globex Remittance' });

      const initiated = await initiateExternal(owner, src.id, payee.id, 1500);
      const transferId = idOf(initiated);

      const pending = await getPending(owner);
      expect(pending).toBeTruthy();
      expect(idOf(pending)).toBe(transferId);
      expect(pending.type ?? pending.transaction?.type).toBe('external_outbound');
      // For external the display is the caller's OWN enrolled name (not another party's PII → not masked).
      expect(pending.payeeDisplayName).toBe('Globex Remittance');
      // The internal-only destination fields are null for an external transfer.
      expect(pending.destinationAccountNumber ?? null).toBeNull();
      expect(pending.destinationMaskedName ?? null).toBeNull();
    }, 30_000);

    // =========================================================================================
    // RECONCILIATION across a mixed initiate/confirm/cancel/expire sequence
    // =========================================================================================

    it('RECONCILIATION: after a mixed sequence, SUM(PLACED per account)==account.held for every account, and clearing nets exactly the settled outflows', async () => {
      const clearingBefore = await clearingBalance();

      // Account W — settle (money leaves into clearing): expect held 0, one SETTLED hold.
      const ownerW = newOwner();
      const srcW = await mkCustomer(ownerW, { balance: 10000, held: 0 });
      const payeeW = await mkPayee(ownerW);
      const wId = idOf(await initiateExternal(ownerW, srcW.id, payeeW.id, 4000));
      await confirm(ownerW, wId, await generateOtp(ownerW));

      // Account X — cancel (funds returned): expect held 0, one RELEASED hold.
      const ownerX = newOwner();
      const srcX = await mkCustomer(ownerX, { balance: 10000, held: 0 });
      const payeeX = await mkPayee(ownerX);
      const xId = idOf(await initiateExternal(ownerX, srcX.id, payeeX.id, 2000));
      await cancel(ownerX, xId);

      // Account Y — left PENDING (funds reserved): expect held == 2500, one PLACED hold.
      const ownerY = newOwner();
      const srcY = await mkCustomer(ownerY, { balance: 10000, held: 0 });
      const payeeY = await mkPayee(ownerY);
      await initiateExternal(ownerY, srcY.id, payeeY.id, 2500);

      // Account Z — overdue then read-expired (funds returned): expect held 0, one EXPIRED hold (the
      // TTL time-out path stamps EXPIRED, not RELEASED).
      const ownerZ = newOwner();
      const AMOUNT_Z = 1800;
      const srcZ = await mkCustomer(ownerZ, { balance: 10000, held: AMOUNT_Z });
      const zTx = await insertTransaction(ds, {
        type: 'external_outbound',
        initiatedBy: ownerZ,
        debitAccountId: srcZ.id,
        creditAccountId: clearingId,
        amount: String(AMOUNT_Z),
        currency: MXN,
        expiresAt: new Date(Date.now() - 60_000),
      });
      await (pg as any).insertHold(ds, {
        accountId: srcZ.id,
        transactionId: zTx.id,
        amount: AMOUNT_Z,
        status: 'PLACED',
        rail: outboundRail,
        expiresAt: new Date(Date.now() - 60_000),
      });
      await getPending(ownerZ); // triggers the lazy expiry + release

      // ---- INVARIANT 1: SUM(PLACED) == held for EVERY account touched.
      for (const id of [srcW.id, srcX.id, srcY.id, srcZ.id]) {
        const held = BigInt((await acct(id)).held);
        expect(await sumPlaced(id)).toBe(held);
      }
      // The concrete end-states pin the sequence semantics (not just the tautology SUM==held).
      expect((await acct(srcW.id)).held).toBe('0'); // settled
      expect((await acct(srcX.id)).held).toBe('0'); // cancelled → released
      expect((await acct(srcY.id)).held).toBe('2500'); // still reserved
      expect((await acct(srcZ.id)).held).toBe('0'); // TTL-expired → released

      // The terminal HOLD labels within the mixed sequence prove the EXPIRED-vs-RELEASED distinction
      // is genuinely applied (not merely commented): X was an explicit cancel (RELEASED); Z timed out
      // on its TTL (EXPIRED).
      expect((await holdsForTx(xId))[0].status).toBe('RELEASED');
      expect((await holdsForTx(zTx.id))[0].status).toBe('EXPIRED');

      // ---- INVARIANT 2: clearing netted ONLY the settled outflow (W's 4000); cancel/expire/pending
      // never touched it.
      expect((await clearingBalance()) - clearingBefore).toBe(4000n);
    }, 90_000);
  },
);
