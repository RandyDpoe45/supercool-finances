/**
 * Spec 04 — Balance Service, FAILED-transaction persistence at OTP-confirm: when a user transfer
 * fails its confirm-time BUSINESS check, the service persists a terminal FAILED transaction and
 * emits ONE `transaction.failed` outbox event — instead of the previous silent behavior (the
 * transfer stayed PENDING and an external hold stayed stuck until TTL expiry). These are the
 * money-safety proofs for that step. Written FROM the developer-locked brief + the spec (the
 * `transaction.failed` event is the reserved union member in the balance service's own
 * transaction-event contract), NOT from the implementor's code (parallel development):
 *
 *   1. INTERNAL confirm business-failure (drain the source below the amount AFTER initiate, since
 *      internal is hold-less and funds are checked at confirm) → the row goes FAILED
 *      (`failure_reason` set, `failed_at` non-null), NO ledger legs, both balances UNCHANGED
 *      (no money moved), the confirm STILL throws the business error (INSUFFICIENT_FUNDS), and
 *      EXACTLY ONE `transaction.failed` outbox row carries `transaction.status='FAILED'`, empty
 *      `legs`, null `postedAt`, and the `failureReason`.
 *   2. EXTERNAL confirm business-failure (FREEZE the source AFTER initiate, so the settle-time
 *      customer debit is rejected) → FAILED, and the placed hold is RELEASED — `account.held`
 *      returns to its pre-initiate value (the reservation is FREED, not left stuck), no money
 *      moved (no ledger legs, clearing untouched), exactly one `transaction.failed`, the business
 *      error (ACCOUNT_FROZEN) still surfaces.
 *   3. TERMINAL: after a FAILED confirm, a second confirm (fresh OTP) rejects TRANSFER_NOT_PENDING
 *      and writes NO second FAILED row + NO second event (idempotent terminality; exactly-once).
 *   4. TERMINAL-NOT-REFLIPPED: confirming an already-terminal (CANCELLED) transfer is refused at the
 *      confirm PRE-check → TRANSFER_NOT_PENDING, and the terminal record is NOT re-flipped to FAILED
 *      nor a `transaction.failed` event re-emitted. (The `isBusinessFailure` allowlist itself — which
 *      codes become FAILED — is pinned by the pure unit spec tests/unit/failure-classification.spec.ts,
 *      since this pre-check rejection never reaches that predicate.)
 *
 * Exactly-once (proof 5) is folded into proofs 1 + 3: a single failed confirm yields exactly ONE
 * `transaction.failed` row (test 1 asserts total outbox == 1 and it is the failed event), and a
 * replayed confirm keeps it at ONE (test 3).
 *
 * Why DB+Redis-backed and not mocked: the invariants here (a failed attempt moves NO money,
 * releases any reservation, and is recorded EXACTLY ONCE, while a structural rejection records
 * NOTHING) are properties of REAL committed transactions + REAL Redis OTP — mocking them would
 * mock away the very logic under test. Every assertion gates on OBSERVABLE STATE (the transaction
 * row, ledger legs, account balance/held, hold rows, the committed outbox row + its payload),
 * never on the error kind alone. The FAILED persistence + event are asserted AFTER capturing the
 * thrown business error, since they must commit even though confirm re-raises.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a
 * false pass). beforeAll TCP-probes BOTH Postgres and Redis and fails loud if unreachable; boots
 * the real AppModule (migrationsRun:true → schema + MXN + clearing accounts). RELAY_ENABLED=false
 * (env fixture) so no background relay drains/marks the outbox out from under the assertions.
 * Unique account/owner ids per test; committed rows (incl. holds + outbox) and minted OTP keys
 * cleaned up per-test.
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
import {
  insertRow,
  insertCustomer,
  insertExternalPayee,
  localAccountNumber,
  TODAY,
  MONTH_START,
} from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED failed-persistence suite: set BALANCE_INTEGRATION=1 (and point DB_* at ' +
      'Postgres AND REDIS_* at Redis — the confirm path needs both) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789';
const MXN = 'MXN';

/** The reserved stream event type for a persisted failed transfer (contract of record — the
 * `transaction.failed` member of the balance service's own transaction-event union). */
const FAILED_EVENT_TYPE = 'transaction.failed';

const suite = ENABLED ? describe : describe.skip;

suite(
  'failed-transaction persistence at confirm — FAILED row + transaction.failed event, no money moved, hold released (integration, needs Postgres + Redis)',
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
        typeof svc.resolveDestination !== 'function' ||
        typeof svc.initiateTransfer !== 'function' ||
        typeof svc.initiateExternalTransfer !== 'function' ||
        typeof svc.confirmTransfer !== 'function' ||
        typeof svc.cancelTransfer !== 'function'
      ) {
        throw new Error(
          '[integration] resolved the transfers service but it lacks resolveDestination / ' +
            'initiateTransfer / initiateExternalTransfer / confirmTransfer / cancelTransfer. ' +
            'Reconcile the contract at tests/support/harness.ts:getTransfersServiceToken.',
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

    /** A committed customer account (customer FK parent + account with a unique 10-digit number). */
    async function mkCustomer(
      owner: string,
      overrides: Record<string, unknown> = {},
    ): Promise<any> {
      const { name, account_number: numberOverride, ...accountOverrides } = overrides as any;
      await insertCustomer(ds, owner, { name });
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

    /** A committed, USABLE enrolled payee for `owner` (cooling-off in the PAST). */
    async function mkPayee(owner: string): Promise<any> {
      return insertExternalPayee(ds, {
        ownerId: owner,
        displayName: 'Acme Payments',
        rail: outboundRail,
        coolingOffUntil: new Date(Date.now() - 60_000),
      });
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

    async function legsForTx(txId: string): Promise<Array<{ account_id: string; delta: string }>> {
      return ds.query(`SELECT account_id, delta FROM ledger_entry WHERE transaction_id = $1`, [
        txId,
      ]);
    }

    async function txRow(txId: string): Promise<
      | {
          status: string;
          type: string;
          failure_reason: string | null;
          failed_at: Date | null;
          posted_at: Date | null;
        }
      | undefined
    > {
      const r = await ds.query(
        `SELECT status, type, failure_reason, failed_at, posted_at
           FROM "transaction" WHERE id = $1`,
        [txId],
      );
      return r[0];
    }

    async function holdsForTx(
      txId: string,
    ): Promise<Array<{ account_id: string; amount: string; status: string }>> {
      return ds.query(`SELECT account_id, amount, status FROM hold WHERE transaction_id = $1`, [
        txId,
      ]);
    }

    async function sumPlaced(accountId: string): Promise<bigint> {
      const r = await ds.query(
        `SELECT COALESCE(SUM(amount), 0)::text AS s FROM hold WHERE account_id = $1 AND status = 'PLACED'`,
        [accountId],
      );
      return BigInt(r[0].s);
    }

    /** All outbox rows for a tx, oldest-first (event_type + parsed jsonb payload). */
    async function outboxForTx(
      txId: string,
    ): Promise<Array<{ id: string; event_type: string; payload: any }>> {
      return ds.query(
        `SELECT id, event_type, payload FROM outbox_event
           WHERE transaction_id = $1 ORDER BY created_at ASC, id ASC`,
        [txId],
      );
    }

    async function failedEventsForTx(
      txId: string,
    ): Promise<Array<{ id: string; event_type: string; payload: any }>> {
      const rows = await outboxForTx(txId);
      return rows.filter((r) => r.event_type === FAILED_EVENT_TYPE);
    }

    /** Placement-agnostic read of the failure reason the event carries (top-level or under
     * `transaction`), so the proof gates on "the reason IS carried" without pinning an exact key. */
    function payloadFailureReason(payload: any): string | null {
      return payload?.failureReason ?? payload?.transaction?.failureReason ?? null;
    }

    // ---- service adapters -----------------------------------------------------------------

    function idOf(r: any): string {
      return (r?.transaction?.id ?? r?.id ?? r?.transactionId ?? r?.transferId) as string;
    }
    function statusOf(r: any): string | undefined {
      return r?.transaction?.status ?? r?.status;
    }

    function trackConfirmToken(owner: string, token: string): void {
      if (token) trackedRedisKeys.push(`xfer:confirm:${owner}:${token}`);
    }

    async function resolveDest(owner: string, accountNumber: string): Promise<any> {
      const r = await svc.resolveDestination({ ownerId: owner, sub: owner, accountNumber });
      trackConfirmToken(owner, r.confirmationToken);
      return r;
    }

    /** Internal resolve→initiate happy path (stays PENDING; internal places no hold). */
    async function initiateInternal(
      owner: string,
      sourceId: string,
      destAccount: any,
      amount: number,
    ): Promise<any> {
      const resolution = await resolveDest(owner, destAccount.account_number);
      const k = `key-${randomUUID()}`;
      return svc.initiateTransfer({
        ownerId: owner,
        sub: owner,
        sourceAccountId: sourceId,
        destinationAccountNumber: destAccount.account_number,
        amount: String(amount),
        currency: MXN,
        idempotencyKey: k,
        key: k,
        confirmationToken: resolution.confirmationToken,
      });
    }

    /** External initiate (places a hold; stays PENDING). */
    async function initiateExternal(
      owner: string,
      sourceId: string,
      payeeId: string,
      amount: number,
    ): Promise<any> {
      const k = `key-${randomUUID()}`;
      return svc.initiateExternalTransfer({
        ownerId: owner,
        sub: owner,
        sourceAccountId: sourceId,
        payeeId,
        amount: String(amount),
        currency: MXN,
        idempotencyKey: k,
        key: k,
      });
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
      if (de.InsufficientFundsError && err instanceof de.InsufficientFundsError)
        return 'INSUFFICIENT_FUNDS';
      if (de.AccountFrozenError && err instanceof de.AccountFrozenError) return 'ACCOUNT_FROZEN';
      // The service pre-check (TransferNotPendingError) and the reducer's guarded transition
      // (TransactionNotPendingError) are distinct classes sharing the TRANSFER_NOT_PENDING code.
      if (de.TransferNotPendingError && err instanceof de.TransferNotPendingError)
        return 'TRANSFER_NOT_PENDING';
      if (de.TransactionNotPendingError && err instanceof de.TransactionNotPendingError)
        return 'TRANSFER_NOT_PENDING';
      if (de.TransferNotFoundError && err instanceof de.TransferNotFoundError)
        return 'TRANSFER_NOT_FOUND';
      return (err?.code ?? err?.errorCode ?? err?.driverError?.code ?? '') as string;
    }

    async function setBalance(id: string, value: number): Promise<void> {
      await ds.query(`UPDATE account SET balance = $2 WHERE id = $1`, [id, String(value)]);
    }

    async function freeze(id: string): Promise<void> {
      await ds.query(`UPDATE account SET status = 'frozen' WHERE id = $1`, [id]);
    }

    // =========================================================================================
    // PROOF 1 — INTERNAL confirm business-failure → FAILED, no money moved, one failed event
    // (also proves EXACTLY-ONCE: total outbox for the tx is one, and it is the failed event)
    // =========================================================================================

    it('INTERNAL: a source drained below the amount after initiate → confirm throws INSUFFICIENT_FUNDS, the row is FAILED (reason + failed_at), NO ledger legs, both balances UNCHANGED, and EXACTLY ONE transaction.failed event (status=FAILED, legs=[], postedAt=null, failureReason set)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
      const AMOUNT = 4000;

      const initiated = await initiateInternal(owner, src.id, dst, AMOUNT);
      const transferId = idOf(initiated);
      expect(statusOf(initiated)).toBe('PENDING');

      // Drain the source below the amount AFTER initiate (internal checks funds only at confirm).
      await setBalance(src.id, 3000); // available 3000 < 4000 → will fail at confirm
      expect((await acct(src.id)).balance).toBe('3000');

      const code = await generateOtp(owner);
      const res = await capture(confirm(owner, transferId, code));

      // The business error still surfaces (the confirm is not silently swallowed).
      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('INSUFFICIENT_FUNDS');

      // The transfer is now a TERMINAL FAILED record — not left PENDING (the pre-fix bug).
      const row = await txRow(transferId);
      expect(row?.status).toBe('FAILED');
      expect(typeof row?.failure_reason).toBe('string');
      expect((row?.failure_reason ?? '').length).toBeGreaterThan(0);
      expect(row?.failed_at).not.toBeNull();
      expect(row?.posted_at).toBeNull();

      // NO money moved: zero ledger legs; the source keeps its drained balance, the dest is untouched.
      expect(await legsForTx(transferId)).toHaveLength(0);
      expect((await acct(src.id)).balance).toBe('3000');
      expect((await acct(dst.id)).balance).toBe('0');

      // EXACTLY ONE outbox row for the tx, and it is the transaction.failed event (not zero, not two,
      // and NOT also a transaction.posted).
      const all = await outboxForTx(transferId);
      expect(all).toHaveLength(1);
      const failedRows = await failedEventsForTx(transferId);
      expect(failedRows).toHaveLength(1);
      expect(all[0].event_type).toBe(FAILED_EVENT_TYPE);

      // The event payload encodes the failed terminal state: status FAILED, empty legs, null postedAt,
      // and the SAME failure reason that was persisted on the row.
      const payload = failedRows[0].payload;
      expect(payload?.transaction?.id).toBe(transferId);
      expect(payload?.transaction?.status).toBe('FAILED');
      expect(payload?.transaction?.postedAt ?? null).toBeNull();
      expect(Array.isArray(payload?.legs)).toBe(true);
      expect(payload?.legs).toHaveLength(0);
      expect(payloadFailureReason(payload)).toBe(row?.failure_reason);
    }, 45_000);

    // =========================================================================================
    // PROOF 2 — EXTERNAL confirm business-failure → FAILED + hold RELEASED (held freed, not stuck)
    // =========================================================================================

    it('EXTERNAL: a source frozen after initiate → confirm throws ACCOUNT_FROZEN, the row is FAILED, the hold is RELEASED and account.held returns to its pre-initiate value (0), NO money moved (no ledger legs, clearing untouched), and EXACTLY ONE transaction.failed event', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const payee = await mkPayee(owner);
      const AMOUNT = 4000;

      const initiated = await initiateExternal(owner, src.id, payee.id, AMOUNT);
      const transferId = idOf(initiated);
      expect(statusOf(initiated)).toBe('PENDING');

      // Initiate reserved the funds: balance untouched, held == amount, one PLACED hold.
      expect((await acct(src.id)).balance).toBe('10000');
      expect((await acct(src.id)).held).toBe('4000');
      expect(await sumPlaced(src.id)).toBe(4000n);
      const clearingBefore = await clearingBalance();

      // Freeze the source AFTER initiate: the settle-time customer debit is rejected at confirm.
      await freeze(src.id);

      const code = await generateOtp(owner);
      const res = await capture(confirm(owner, transferId, code));

      // The business error still surfaces.
      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('ACCOUNT_FROZEN');

      // The transfer is a TERMINAL FAILED record.
      const row = await txRow(transferId);
      expect(row?.status).toBe('FAILED');
      expect((row?.failure_reason ?? '').length).toBeGreaterThan(0);
      expect(row?.failed_at).not.toBeNull();
      expect(row?.posted_at).toBeNull();

      // The RESERVATION is FREED, not left stuck until TTL: the hold is RELEASED and held is back to 0.
      const holds = await holdsForTx(transferId);
      expect(holds).toHaveLength(1);
      expect(holds[0].status).toBe('RELEASED');
      const a = await acct(src.id);
      expect(a.held).toBe('0'); // pre-initiate value restored — the money-safety keystone here
      expect(await sumPlaced(src.id)).toBe(0n);

      // NO money moved: balance untouched, no ledger legs, clearing account unchanged.
      expect(a.balance).toBe('10000');
      expect(await legsForTx(transferId)).toHaveLength(0);
      expect((await clearingBalance()) - clearingBefore).toBe(0n);

      // EXACTLY ONE outbox row for the tx, and it is the transaction.failed event.
      const all = await outboxForTx(transferId);
      expect(all).toHaveLength(1);
      expect(all[0].event_type).toBe(FAILED_EVENT_TYPE);
      const payload = all[0].payload;
      expect(payload?.transaction?.id).toBe(transferId);
      expect(payload?.transaction?.status).toBe('FAILED');
      expect(payload?.transaction?.postedAt ?? null).toBeNull();
      expect(payload?.legs).toHaveLength(0);
      expect(payloadFailureReason(payload)).toBe(row?.failure_reason);
    }, 45_000);

    // =========================================================================================
    // PROOF 3 — TERMINAL: a second confirm of a FAILED transfer records NOTHING new (exactly-once)
    // =========================================================================================

    it('TERMINAL: after a FAILED confirm, a second confirm with a FRESH OTP rejects TRANSFER_NOT_PENDING and writes NO second FAILED write and NO second transaction.failed event (idempotent terminality)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
      const AMOUNT = 4000;

      const initiated = await initiateInternal(owner, src.id, dst, AMOUNT);
      const transferId = idOf(initiated);
      await setBalance(src.id, 3000);

      const firstCode = await generateOtp(owner);
      const first = await capture(confirm(owner, transferId, firstCode));
      expect(first.ok).toBe(false);
      expect(codeOf(first.error)).toBe('INSUFFICIENT_FUNDS');

      const afterFirst = await txRow(transferId);
      expect(afterFirst?.status).toBe('FAILED');
      expect(afterFirst?.failed_at).not.toBeNull();
      expect(await failedEventsForTx(transferId)).toHaveLength(1);

      // A REPLAYED confirm with a FRESH, valid OTP (so the rejection is the terminality guard, not a
      // missing/burned code) must be refused as not-pending and change NOTHING.
      const secondCode = await generateOtp(owner);
      const second = await capture(confirm(owner, transferId, secondCode));
      expect(second.ok).toBe(false);
      expect(codeOf(second.error)).toBe('TRANSFER_NOT_PENDING');

      // No second FAILED write: same failed_at + same reason, still FAILED, still zero ledger legs.
      const afterSecond = await txRow(transferId);
      expect(afterSecond?.status).toBe('FAILED');
      expect(afterSecond?.failure_reason).toBe(afterFirst?.failure_reason);
      expect(new Date(afterSecond!.failed_at as any).getTime()).toBe(
        new Date(afterFirst!.failed_at as any).getTime(),
      );
      expect(await legsForTx(transferId)).toHaveLength(0);

      // Exactly-once holds under replay: still ONE transaction.failed event (never a second).
      expect(await failedEventsForTx(transferId)).toHaveLength(1);
      expect(await outboxForTx(transferId)).toHaveLength(1);
    }, 45_000);

    // =========================================================================================
    // PROOF 4 — TAXONOMY: a structural (non-business) confirm failure does NOT persist FAILED
    // =========================================================================================

    it('TAXONOMY: confirming an already-terminal (CANCELLED) transfer → TRANSFER_NOT_PENDING leaves the terminal record UNCHANGED (never flipped to FAILED, failure_reason still the cancel reason) and emits NO transaction.failed event', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });

      const initiated = await initiateInternal(owner, src.id, dst, 1000);
      const transferId = idOf(initiated);

      // Take the transfer to a terminal, NON-failed state (CANCELLED) via the normal cancel path.
      const cancelled = await cancel(owner, transferId);
      expect(statusOf(cancelled)).toBe('CANCELLED');

      // Snapshot the terminal record the CANCEL produced. `failed_at` is a SHARED terminal-timestamp
      // column (transitionToCancelled stamps it too), so the taxonomy proof is NOT "failed_at is
      // null" — it is that the confirm does NOT CHANGE the terminal record (no flip to FAILED, no
      // re-stamp, no new reason) and emits no transaction.failed event.
      const beforeConfirm = await txRow(transferId);
      expect(beforeConfirm?.status).toBe('CANCELLED');
      const failedAtBefore = beforeConfirm?.failed_at
        ? new Date(beforeConfirm.failed_at as any).getTime()
        : null;

      // Confirming a terminal transfer is refused at the confirm PRE-check (before the money tx and
      // its FAILED-persistence try/catch) → TRANSFER_NOT_PENDING. This proves the ALREADY-terminal
      // record is not RE-FLIPPED to FAILED and no second event is emitted — it does NOT exercise the
      // `isBusinessFailure` allowlist itself (that predicate is pinned by
      // tests/unit/failure-classification.spec.ts, the real taxonomy tripwire).
      const code = await generateOtp(owner);
      const res = await capture(confirm(owner, transferId, code));
      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('TRANSFER_NOT_PENDING');

      const row = await txRow(transferId);
      expect(row?.status).toBe('CANCELLED'); // NOT flipped to FAILED — unchanged from the cancel
      expect(row?.failure_reason).toBe(beforeConfirm?.failure_reason); // reason unchanged (cancel reason)
      // The shared terminal timestamp is unchanged too (the confirm did not re-stamp it).
      const failedAtAfter = row?.failed_at ? new Date(row.failed_at as any).getTime() : null;
      expect(failedAtAfter).toBe(failedAtBefore);
      expect(await legsForTx(transferId)).toHaveLength(0);
      // No transaction.failed event was emitted for a structural rejection.
      expect(await failedEventsForTx(transferId)).toHaveLength(0);
    }, 45_000);
  },
);
