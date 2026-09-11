/**
 * Spec 04 — Balance Service, Transfers + the confirmation-of-payee follow-up: internal transfers
 * END-TO-END at the service layer, driven against the REAL DI'd TransfersService (resolved BY
 * TOKEN through a booted AppModule) with real Postgres + real Redis. These are the
 * Definition-of-Done money-safety proofs PLUS the human resolve→confirm→initiate gate. Written
 * FROM the spec + the developer-locked contract, NOT from the implementor's code:
 *   - resolve is a QUERY (masked name + a caller-/destination-bound token) that moves no money;
 *   - initiate requires a valid token and stays PENDING; confirm posts on the single-use OTP with
 *     the funds check under the account lock;
 *   - Idempotency (replay moves money once); soft-duplicate; concurrency (post AT MOST once);
 *     reconciliation `balance == seeded + SUM(ledger delta)`.
 *
 * Why DB+Redis-backed and not mocked: the invariants here (money moves exactly once under a
 * replay/concurrency, the confirm-time funds check under the FOR UPDATE lock, the atomic
 * ledger/balance fold, the caller/destination token binding, one-outbox-per-post) are properties
 * of REAL transactions and REAL Redis — mocking them would mock away the very logic under test.
 * Every assertion gates on OBSERVABLE STATE (balances, ledger rows, transaction status, outbox
 * count, absence of a created transaction), never on the error kind alone.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a
 * false pass). beforeAll TCP-probes BOTH Postgres and Redis and fails loud if unreachable; boots
 * the real AppModule (migrationsRun:true → MXN + clearing accounts + the customer/account_number
 * schema). jest.config.ts serializes the integration run (maxWorkers:1). Unique account/owner ids
 * per test; committed rows + minted OTP/confirmation keys are cleaned up per-test (Redis keys via
 * `del`, NEVER flushall).
 *
 * To run:
 *   1. bring up the compose datastores (Postgres + Redis reachable to the runner);
 *   2. BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=… REDIS_HOST=… REDIS_PORT=…] npm test
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
  getPostingServiceToken,
  getRepositoryToken,
  getGenerateAccountNumber,
  getRunInTransactionWithRetry,
  getDomainErrors,
  tcpProbe,
} from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import {
  insertRow,
  insertCustomer,
  insertTransaction,
  localAccountNumber,
  TODAY,
  MONTH_START,
} from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED transfers suite: set BALANCE_INTEGRATION=1 (and point DB_* at Postgres ' +
      'AND REDIS_* at Redis — the confirm write path needs both) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789';
const MXN = 'MXN';

/** A valid, likely-unique 10-digit account number (production helper when resolvable). */
const genAccountNumber = getGenerateAccountNumber() ?? localAccountNumber;

const suite = ENABLED ? describe : describe.skip;

suite(
  'internal transfers end-to-end — DoD money-safety + confirmation-of-payee (integration, needs Postgres + Redis)',
  () => {
    let app: INestApplication;
    let ds: any;
    let svc: any;
    let otp: any;
    let redis: any;
    let domainErrors: ReturnType<typeof getDomainErrors>;

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
        typeof svc.confirmTransfer !== 'function' ||
        typeof svc.cancelTransfer !== 'function' ||
        typeof svc.getPendingAuthorization !== 'function'
      ) {
        throw new Error(
          '[integration] resolved the transfers service but it lacks resolveDestination / ' +
            'initiateTransfer / confirmTransfer / cancelTransfer / getPendingAuthorization. ' +
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

      domainErrors = getDomainErrors();
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

    /**
     * A committed customer account: a `customer` row (id = owner sub — the FK parent) plus an
     * `account` carrying a unique 10-digit `account_number`. `overrides.name` sets the holder
     * name (so a suite can prove the mask against a KNOWN name); the rest are account columns.
     */
    async function mkCustomer(
      owner: string,
      overrides: Record<string, unknown> = {},
    ): Promise<any> {
      const { name, account_number: numberOverride, ...accountOverrides } = overrides as any;
      await insertCustomer(ds, owner, { name });
      const accountNumber = (numberOverride as string) ?? genAccountNumber();
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

    async function cleanup(ids: string[], owners: string[]): Promise<void> {
      if (!ids.length && !owners.length) return;
      const txRows = await ds.query(
        `SELECT id FROM "transaction"
        WHERE debit_account_id = ANY($1) OR credit_account_id = ANY($1) OR initiated_by = ANY($2)
        UNION SELECT DISTINCT transaction_id AS id FROM ledger_entry WHERE account_id = ANY($1)`,
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
      if (owners.length)
        await ds.query(`DELETE FROM idempotency_key WHERE owner_id = ANY($1)`, [owners]);
      // Accounts FK owner_id → customer.id, so accounts drop BEFORE their customer parents.
      if (ids.length) await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
      if (owners.length) await ds.query(`DELETE FROM customer WHERE id = ANY($1)`, [owners]);
    }

    async function acct(id: string): Promise<{ balance: string; held: string; status: string }> {
      const r = await ds.query(`SELECT balance, held, status FROM account WHERE id = $1`, [id]);
      return r[0];
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

    async function postedCountFor(owner: string): Promise<number> {
      const r = await ds.query(
        `SELECT count(*)::int AS n FROM "transaction" WHERE initiated_by = $1 AND status = 'POSTED'`,
        [owner],
      );
      return r[0].n;
    }

    async function txRow(txId: string): Promise<
      | {
          status: string;
          failure_reason: string | null;
          failed_at: Date | null;
          expires_at: string | null;
        }
      | undefined
    > {
      const r = await ds.query(
        `SELECT status, failure_reason, failed_at, expires_at FROM "transaction" WHERE id = $1`,
        [txId],
      );
      return r[0];
    }

    const sumDeltas = (legs: Array<{ delta: string }>): bigint =>
      legs.reduce((s, l) => s + BigInt(l.delta), 0n);

    // ---- service adapters (documented assumed shapes; alias-hedged) -----------------------

    function idOf(r: any): string {
      const id =
        r?.transaction?.id ?? r?.id ?? r?.transactionId ?? r?.transferId ?? r?.transfer?.id;
      return id as string;
    }
    function statusOf(r: any): string | undefined {
      return r?.transaction?.status ?? r?.status ?? r?.transfer?.status;
    }

    function trackConfirmToken(owner: string, token: string): void {
      // The service binds the token to the caller under `xfer:confirm:<owner>:<token>` with a 300s
      // TTL; track it for explicit cleanup (TTL would also reap it).
      if (token) trackedRedisKeys.push(`xfer:confirm:${owner}:${token}`);
    }

    async function resolveDest(
      owner: string,
      accountNumber: string,
    ): Promise<{ maskedName: string; currency: string; confirmationToken: string }> {
      const r = await svc.resolveDestination({ ownerId: owner, sub: owner, accountNumber });
      trackConfirmToken(owner, r.confirmationToken);
      return r;
    }

    async function initiateRaw(
      owner: string,
      sourceId: string,
      destNumber: string,
      token: string,
      amount: number,
      opts: { currency?: string; key?: string; confirmDuplicate?: boolean } = {},
    ): Promise<any> {
      const k = opts.key ?? `key-${randomUUID()}`;
      const params: any = {
        ownerId: owner,
        sub: owner,
        sourceAccountId: sourceId,
        destinationAccountNumber: destNumber,
        amount: String(amount), // canonical unsigned minor-unit string (never a JS number)
        currency: opts.currency ?? MXN,
        idempotencyKey: k,
        key: k,
        confirmationToken: token,
      };
      if (opts.confirmDuplicate !== undefined) params.confirmDuplicate = opts.confirmDuplicate;
      return svc.initiateTransfer(params);
    }

    /** The common happy path: resolve the destination (fresh token) then initiate. */
    async function initiate(
      owner: string,
      sourceId: string,
      destAccount: any,
      amount: number,
      opts: { currency?: string; key?: string; confirmDuplicate?: boolean } = {},
    ): Promise<any> {
      const resolution = await resolveDest(owner, destAccount.account_number);
      return initiateRaw(
        owner,
        sourceId,
        destAccount.account_number,
        resolution.confirmationToken,
        amount,
        opts,
      );
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

    /** The single active pending authorization for the caller (a read model, or null). */
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
      if (de.InsufficientFundsError && err instanceof de.InsufficientFundsError)
        return 'INSUFFICIENT_FUNDS';
      if (de.SuspectedDuplicateError && err instanceof de.SuspectedDuplicateError)
        return 'SUSPECTED_DUPLICATE';
      if (de.InvalidOtpError && err instanceof de.InvalidOtpError) return 'INVALID_OTP';
      if (de.DestinationNotConfirmedError && err instanceof de.DestinationNotConfirmedError)
        return 'DESTINATION_NOT_CONFIRMED';
      if (de.TransferExpiredError && err instanceof de.TransferExpiredError)
        return 'TRANSFER_EXPIRED';
      if (de.PendingTransferConflictError && err instanceof de.PendingTransferConflictError)
        return 'PENDING_TRANSFER_CONFLICT';
      // TransferNotPendingError (service pre-check) and TransactionNotPendingError (posting
      // reducer) are distinct classes sharing the TRANSFER_NOT_PENDING code.
      if (de.TransferNotPendingError && err instanceof de.TransferNotPendingError)
        return 'TRANSFER_NOT_PENDING';
      if (de.TransactionNotPendingError && err instanceof de.TransactionNotPendingError)
        return 'TRANSFER_NOT_PENDING';
      if (de.TransferNotFoundError && err instanceof de.TransferNotFoundError)
        return 'TRANSFER_NOT_FOUND';
      return (err?.code ?? err?.errorCode ?? '') as string;
    }

    // ---- reducer-gate adapters (drive the confirm-time seam DIRECTLY, off the OTP path) ----

    async function postPendingSecondTime(
      posting: any,
      transferId: string,
      command: any,
    ): Promise<{ ok: boolean; value?: any; error?: any }> {
      const runInTx = getRunInTransactionWithRetry();
      if (runInTx) {
        return capture(runInTx(ds, (qr: any) => posting.postPendingInTx(qr, transferId, command)));
      }
      const qr = ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        const value = await posting.postPendingInTx(qr, transferId, command);
        await qr.commitTransaction();
        return { ok: true, value };
      } catch (error) {
        if (qr.isTransactionActive) await qr.rollbackTransaction();
        return { ok: false, error };
      } finally {
        await qr.release();
      }
    }

    async function inRolledBackTx<T>(fn: (qr: any) => Promise<T>): Promise<T> {
      const qr = ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        return await fn(qr);
      } finally {
        try {
          await qr.rollbackTransaction();
        } catch {
          /* best-effort */
        }
        await qr.release();
      }
    }

    // ---- CONFIRMATION-OF-PAYEE: resolve is a QUERY (masked name + token, NO transaction) ----

    it('resolves a destination by account number to the MASKED holder name + a token, creating NO transaction', async () => {
      const caller = newOwner();
      // A destination customer explicitly named "Juan Perez" so the mask is exactly predictable.
      const dst = await mkCustomer(newOwner(), { name: 'Juan Perez', balance: 500 });

      const resolution = await resolveDest(caller, dst.account_number);

      expect(resolution.maskedName).toBe('Jua** Per**'); // fixed-two-asterisks mask, PII withheld
      expect(JSON.stringify(resolution)).not.toContain('Juan Perez'); // raw name never crosses
      expect(resolution.currency).toBe(MXN);
      expect(typeof resolution.confirmationToken).toBe('string');
      expect(resolution.confirmationToken.length).toBeGreaterThan(0);

      // A pure query: NO transaction was created for the caller (resolve alone moves nothing).
      expect(await anyTxCountFor(caller)).toBe(0);
      // The token IS bound to the caller in Redis (a later initiate can consume it).
      const stored = await redis.get(`xfer:confirm:${caller}:${resolution.confirmationToken}`);
      expect(stored).not.toBeNull();
    }, 30_000);

    it('rejects resolving an UNKNOWN account number with a 404-class TransferNotFound (no reveal)', async () => {
      const caller = newOwner();
      // A well-formed 10-digit number that was never assigned.
      const res = await capture(resolveDest(caller, '0000000042'));
      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('TRANSFER_NOT_FOUND');
      // No token minted, no transaction created.
      expect(await anyTxCountFor(caller)).toBe(0);
    }, 30_000);

    // ---- END-TO-END HUMAN FLOW: resolve → initiate (PENDING) → OTP → confirm (POSTED) -------

    it('runs the full human flow: resolve → initiate PENDING (debit=source, credit=resolved dest) → confirm POSTED, balances move once', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { name: 'Ana Lopez', balance: 1500, held: 0 });
      const AMOUNT = 4000;

      const resolution = await resolveDest(owner, dst.account_number);
      expect(resolution.maskedName).toBe('Ana** Lop**');

      const initiated = await initiateRaw(
        owner,
        src.id,
        dst.account_number,
        resolution.confirmationToken,
        AMOUNT,
      );
      const transferId = idOf(initiated);
      expect(typeof transferId).toBe('string');
      expect(statusOf(initiated)).toBe('PENDING');

      // NO money moved at initiate (internal transfers place no hold): both balances untouched.
      expect((await acct(src.id)).balance).toBe('10000');
      expect((await acct(dst.id)).balance).toBe('1500');
      expect(await txStatus(transferId)).toBe('PENDING');
      expect(await legsForTx(transferId)).toHaveLength(0);
      // Regression lock (5b extended the SHARED insertPendingInTx to persist payee_id for external
      // transfers): an INTERNAL transfer has no payee, so its header's payee_id MUST stay NULL.
      const [{ payee_id: internalPayeeId }] = await ds.query(
        `SELECT payee_id FROM "transaction" WHERE id = $1`,
        [transferId],
      );
      expect(internalPayeeId).toBeNull();

      const code = await generateOtp(owner);
      const confirmed = await confirm(owner, transferId, code);
      expect(statusOf(confirmed)).toBe('POSTED');

      // Money moved exactly once: source debited, destination credited.
      expect((await acct(src.id)).balance).toBe('6000');
      expect((await acct(dst.id)).balance).toBe('5500');
      expect(await txStatus(transferId)).toBe('POSTED');

      // The ledger legs map to the RESOLVED destination account (not merely "some" account): the
      // debit leg is the source, the credit leg is the destination the number resolved to.
      const legs = await legsForTx(transferId);
      expect(legs).toHaveLength(2);
      expect(sumDeltas(legs)).toBe(0n);
      const debitLeg = legs.find((l) => BigInt(l.delta) < 0n)!;
      const creditLeg = legs.find((l) => BigInt(l.delta) > 0n)!;
      expect(debitLeg.account_id).toBe(src.id);
      expect(creditLeg.account_id).toBe(dst.id);
      expect(await outboxCount(transferId)).toBe(1);
    }, 30_000);

    // ---- INITIATE IS GATED BY CONFIRMATION -------------------------------------------------

    it('rejects initiate with NO valid confirmation token (DESTINATION_NOT_CONFIRMED); no transfer is created', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const dst = await mkCustomer(newOwner(), { balance: 0 });

      // A syntactically fine but never-issued token: initiate must refuse and create nothing.
      const res = await capture(
        initiateRaw(owner, src.id, dst.account_number, 'not-a-real-token', 1000),
      );
      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('DESTINATION_NOT_CONFIRMED');
      expect(await anyTxCountFor(owner)).toBe(0); // the money machinery never ran
    }, 30_000);

    it("rejects a token bound to a DIFFERENT destination (resolve B, initiate to C with B's token)", async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const dstB = await mkCustomer(newOwner(), { balance: 0 });
      const dstC = await mkCustomer(newOwner(), { balance: 0 });

      // Resolve B → a token that binds to B's account. Try to pay C with it.
      const resolutionB = await resolveDest(owner, dstB.account_number);
      const res = await capture(
        initiateRaw(owner, src.id, dstC.account_number, resolutionB.confirmationToken, 1000),
      );

      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('DESTINATION_NOT_CONFIRMED'); // token doesn't bind to C
      expect(await anyTxCountFor(owner)).toBe(0);
    }, 30_000);

    it('token is caller-bound: a token issued to user A cannot be used to initiate as user B', async () => {
      const ownerA = newOwner();
      const ownerB = newOwner();
      const srcB = await mkCustomer(ownerB, { balance: 10000 }); // B's own source account
      const dst = await mkCustomer(newOwner(), { balance: 0 });

      // A resolves the destination → a token bound to A. B tries to spend it (with B's own source).
      const resolutionA = await resolveDest(ownerA, dst.account_number);
      const res = await capture(
        initiateRaw(ownerB, srcB.id, dst.account_number, resolutionA.confirmationToken, 1000),
      );

      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('DESTINATION_NOT_CONFIRMED'); // the token key embeds the caller
      expect(await anyTxCountFor(ownerB)).toBe(0);
    }, 30_000);

    // ---- IDEMPOTENCY (DoD): a replayed key produces ONE pending transfer; money moves once ----

    it('replays the SAME Idempotency-Key to the SAME pending transfer (no duplicate), and money moves once on confirm', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
      const key = `key-${randomUUID()}`;
      const AMOUNT = 2500;

      const r1 = await initiate(owner, src.id, dst, AMOUNT, { key });
      const r2 = await initiate(owner, src.id, dst, AMOUNT, { key });
      const id1 = idOf(r1);
      const id2 = idOf(r2);

      expect(id2).toBe(id1); // same pending transfer, not a duplicate
      expect(await pendingCountFor(owner)).toBe(1); // exactly ONE pending transfer created

      const code = await generateOtp(owner);
      await confirm(owner, id1, code);

      expect((await acct(src.id)).balance).toBe(String(10000 - AMOUNT));
      expect((await acct(dst.id)).balance).toBe(String(AMOUNT));
      expect(await legsForTx(id1)).toHaveLength(2);
    }, 30_000);

    // ---- CONCURRENCY (DoD): N concurrent confirms → transfer posts AT MOST ONCE ------------

    it('posts AT MOST ONCE under N concurrent confirms of one transfer with one OTP: no double-spend, money conserved', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 2000, held: 0 });
      const AMOUNT = 3000;
      const N = 8;

      const initiated = await initiate(owner, src.id, dst, AMOUNT);
      const transferId = idOf(initiated);
      const code = await generateOtp(owner);

      await Promise.allSettled(Array.from({ length: N }, () => confirm(owner, transferId, code)));

      const legs = await legsForTx(transferId);
      expect(legs).toHaveLength(2); // NOT 2*k — the transfer posted once
      expect(sumDeltas(legs)).toBe(0n); // no money created or lost
      expect(await outboxCount(transferId)).toBe(1);
      expect(await txStatus(transferId)).toBe('POSTED');
      expect((await acct(src.id)).balance).toBe(String(10000 - AMOUNT)); // debited once, no overdraft
      expect((await acct(dst.id)).balance).toBe(String(2000 + AMOUNT)); // credited once
    }, 45_000);

    // ---- OTP gating: wrong/lockout keeps the transfer PENDING; single-use posts once -------

    it('a wrong OTP up to lockout never posts (stays PENDING), and the correct code after lockout still cannot post (burned)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });

      const initiated = await initiate(owner, src.id, dst, 1000);
      const transferId = idOf(initiated);
      const code = await generateOtp(owner);
      const wrong = code.slice(0, -1) + (code.endsWith('0') ? '1' : '0');

      for (let i = 0; i < 4; i++) {
        const res = await capture(confirm(owner, transferId, wrong));
        expect(res.ok).toBe(false); // never posts on a wrong code
      }
      expect(await txStatus(transferId)).toBe('PENDING');
      expect(await legsForTx(transferId)).toHaveLength(0);
      expect((await acct(src.id)).balance).toBe('10000');

      const after = await capture(confirm(owner, transferId, code));
      expect(after.ok).toBe(false);
      expect(await txStatus(transferId)).toBe('PENDING');
      expect(await legsForTx(transferId)).toHaveLength(0);
    }, 30_000);

    it('single-use: two confirms with the SAME correct code post the money exactly once (no double movement)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
      const AMOUNT = 3500;

      const initiated = await initiate(owner, src.id, dst, AMOUNT);
      const transferId = idOf(initiated);
      const code = await generateOtp(owner);

      const first = await capture(confirm(owner, transferId, code));
      expect(first.ok).toBe(true);
      expect(statusOf(first.value)).toBe('POSTED');

      await capture(confirm(owner, transferId, code));

      expect(await legsForTx(transferId)).toHaveLength(2); // still exactly one pair
      expect((await acct(src.id)).balance).toBe(String(10000 - AMOUNT));
      expect((await acct(dst.id)).balance).toBe(String(AMOUNT));
      expect(await outboxCount(transferId)).toBe(1);
    }, 30_000);

    // ---- Confirm-time funds check: overdraft caught at confirm, transfer marked FAILED ------

    it('lets an over-available transfer stay PENDING at initiate, then rejects it at confirm with INSUFFICIENT_FUNDS → FAILED (nothing posted)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 1000, held: 0 }); // available = 1000
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
      const AMOUNT = 5000; // more than available

      const initiated = await initiate(owner, src.id, dst, AMOUNT);
      const transferId = idOf(initiated);
      expect(await txStatus(transferId)).toBe('PENDING'); // initiate never checks funds

      const code = await generateOtp(owner);
      const res = await capture(confirm(owner, transferId, code));

      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('INSUFFICIENT_FUNDS');
      // A confirm-time BUSINESS failure is now TERMINAL: the transfer is FAILED (stamped with a
      // reason + failed_at), not left PENDING. Money-safety is unchanged: nothing posted.
      const failedRow = await txRow(transferId);
      expect(failedRow?.status).toBe('FAILED');
      expect((failedRow?.failure_reason ?? '').length).toBeGreaterThan(0);
      expect(failedRow?.failed_at).not.toBeNull();
      expect(await legsForTx(transferId)).toHaveLength(0);
      // The only outbox row for a failed confirm is the single transaction.failed event (no post).
      expect(await outboxCount(transferId)).toBe(1);
      expect((await acct(src.id)).balance).toBe('1000');
      expect((await acct(dst.id)).balance).toBe('0');
    }, 30_000);

    // ---- Soft-duplicate: same fingerprint within 60s suppressed; confirmDuplicate overrides ----

    it('suppresses a second initiate with a DIFFERENT key but the SAME fingerprint within 60s; confirmDuplicate proceeds', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 20000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
      const AMOUNT = 1200;

      const first = await initiate(owner, src.id, dst, AMOUNT);
      const firstId = idOf(first);

      const dup = await capture(initiate(owner, src.id, dst, AMOUNT));
      expect(dup.ok).toBe(false);
      expect(codeOf(dup.error)).toBe('SUSPECTED_DUPLICATE');

      const override = await initiate(owner, src.id, dst, AMOUNT, { confirmDuplicate: true });
      const overrideId = idOf(override);
      expect(overrideId).not.toBe(firstId);

      // Single-pending invariant: the confirmed-duplicate initiate is itself a NEW initiate, so it
      // auto-supersedes the first pending → exactly ONE pending remains (the override), and the
      // superseded first transfer is retained as CANCELLED. (The suppressed middle attempt created
      // nothing.) This is robust to the supersede/duplicate-check ordering: either way the end
      // state is one PENDING.
      expect(await pendingCountFor(owner)).toBe(1);
      expect(await txStatus(overrideId)).toBe('PENDING');
      expect(await txStatus(firstId)).toBe('CANCELLED');
    }, 30_000);

    // ---- getPendingAuthorization: the caller's SINGLE active pending (or null), masked, scoped ----

    it("returns the caller's SINGLE active pending with the destination masked name; null once none; never another user's", async () => {
      const ownerA = newOwner();
      const ownerB = newOwner();
      const srcA = await mkCustomer(ownerA, { balance: 20000, held: 0 });
      const srcB = await mkCustomer(ownerB, { balance: 20000, held: 0 });
      const dst = await mkCustomer(newOwner(), { name: 'Juan Perez', balance: 0, held: 0 });

      // Before any initiate the caller has NO pending authorization.
      expect((await getPending(ownerA)) ?? null).toBeNull();

      const a1 = idOf(await initiate(ownerA, srcA.id, dst, 1000));
      const b1 = idOf(await initiate(ownerB, srcB.id, dst, 3000));

      // A's single pending is exactly a1, carrying the destination holder's MASKED name.
      const pendingA = await getPending(ownerA);
      expect(pendingA).toBeTruthy();
      expect(idOf(pendingA)).toBe(a1);
      expect(pendingA.destinationMaskedName).toBe('Jua** Per**'); // masked, never the raw name
      expect(pendingA.destinationAccountNumber).toBe(dst.account_number);
      expect(JSON.stringify(pendingA)).not.toContain('Juan Perez');

      // Anti-IDOR: B's pending never surfaces for A, and B sees its own.
      expect(idOf(pendingA)).not.toBe(b1);
      expect(idOf(await getPending(ownerB))).toBe(b1);

      // Once A confirms (POSTED), the single-pending read returns null (POSTED is not pending).
      const codeA = await generateOtp(ownerA);
      await confirm(ownerA, a1, codeA);
      expect(await txStatus(a1)).toBe('POSTED');
      expect((await getPending(ownerA)) ?? null).toBeNull();
    }, 30_000);

    // ---- Single pending + auto-supersede: a new initiate cancels the prior pending (retained) ----

    it('auto-supersedes the prior pending on a new initiate: old → CANCELLED (superseded, retained), exactly ONE pending remains', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 20000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });

      // Two DISTINCT initiates (different amounts → different fingerprints, so no soft-duplicate).
      const aId = idOf(await initiate(owner, src.id, dst, 1000));
      const bId = idOf(await initiate(owner, src.id, dst, 2000));
      expect(bId).not.toBe(aId);

      // The old pending is CANCELLED + retained, stamped with the superseded reason; exactly one
      // PENDING (the new one) exists for the initiator.
      const rowA = await txRow(aId);
      expect(rowA?.status).toBe('CANCELLED');
      expect(rowA?.failure_reason).toBe('superseded');
      expect(await txStatus(bId)).toBe('PENDING');
      expect(await pendingCountFor(owner)).toBe(1);

      // The live transfer posts on its OTP (money moves once); the superseded one never moves money.
      const code = await generateOtp(owner);
      const goodConfirm = await capture(confirm(owner, bId, code));
      expect(goodConfirm.ok).toBe(true);
      expect(await txStatus(bId)).toBe('POSTED');
      expect((await acct(src.id)).balance).toBe(String(20000 - 2000)); // only the live transfer moved

      // Confirming the superseded (CANCELLED) transfer is refused as not-pending — with a FRESH,
      // valid code in play (the prior one was single-used by bId) so the rejection is the status
      // guard, not a missing code; nothing moves regardless of whether the code is consumed.
      const freshCode = await generateOtp(owner);
      const badConfirm = await capture(confirm(owner, aId, freshCode));
      expect(badConfirm.ok).toBe(false);
      expect(codeOf(badConfirm.error)).toBe('TRANSFER_NOT_PENDING');
      expect(await legsForTx(aId)).toHaveLength(0); // superseded transfer never moved money
    }, 45_000);

    // ---- Concurrency (DoD): a double-initiate race yields AT MOST ONE pending, no money moved ----

    it('two concurrent initiates for one user settle to EXACTLY ONE pending — never two, never a double-post', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 20000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });

      // Two distinct destinations/amounts would still be one pending; use distinct amounts (distinct
      // fingerprints) so neither is soft-duplicate-suppressed, then fire them together.
      const [tokenX, tokenY] = await Promise.all([
        resolveDest(owner, dst.account_number),
        resolveDest(owner, dst.account_number),
      ]);
      const results = await Promise.allSettled([
        initiateRaw(owner, src.id, dst.account_number, tokenX.confirmationToken, 1000, {
          key: `key-${randomUUID()}`,
        }),
        initiateRaw(owner, src.id, dst.account_number, tokenY.confirmationToken, 2000, {
          key: `key-${randomUUID()}`,
        }),
      ]);

      // At most one PENDING for the initiator (partial unique index, not just a service check).
      expect(await pendingCountFor(owner)).toBe(1);
      // Nobody posted (no confirm yet) → no money moved, both balances intact.
      expect(await postedCountFor(owner)).toBe(0);
      expect((await acct(src.id)).balance).toBe('20000');
      expect((await acct(dst.id)).balance).toBe('0');

      // The loser either superseded the earlier pending (a retained CANCELLED row) or surfaced a
      // PendingTransferConflictError — never two live pendings, never a double-post.
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      for (const r of rejected) {
        expect(['PENDING_TRANSFER_CONFLICT', 'SUSPECTED_DUPLICATE']).toContain(codeOf(r.reason));
      }
      const anyCancelledSuperseded = await ds.query(
        `SELECT count(*)::int AS n FROM "transaction"
          WHERE initiated_by = $1 AND status = 'CANCELLED' AND failure_reason = 'superseded'`,
        [owner],
      );
      // Consistency: fulfilled_count - 1 supersedes happened, OR the loser rejected with a conflict.
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      expect(anyCancelledSuperseded[0].n + rejected.length).toBeGreaterThanOrEqual(fulfilled - 1);
    }, 45_000);

    // ---- Lazy expiry ON READ: an overdue pending transitions to EXPIRED (retained) on next access ----

    it('reading an OVERDUE pending returns null AND lazily transitions the row to EXPIRED (retained, not deleted)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });

      // A PENDING transfer whose expires_at is already in the past (no scheduler ran).
      const overdue = await insertTransaction(ds, {
        initiatedBy: owner,
        debitAccountId: src.id,
        creditAccountId: dst.id,
        amount: '3000',
        currency: MXN,
        expiresAt: new Date(Date.now() - 60_000),
      });
      expect(overdue.status).toBe('PENDING');

      // The next read finds nothing valid (the overdue one is not returned) ...
      expect((await getPending(owner)) ?? null).toBeNull();
      // ... and it has been lazily transitioned to EXPIRED — retained, still queryable, not deleted.
      const row = await txRow(overdue.id);
      expect(row?.status).toBe('EXPIRED');
      expect(await legsForTx(overdue.id)).toHaveLength(0); // never moved money
    }, 30_000);

    // ---- MONEY-SAFETY: confirm checks expiry BEFORE consuming the OTP (the code is NOT burned) ----

    it('an OVERDUE confirm throws TransferExpired and does NOT burn the OTP — the same code still posts a fresh transfer', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });

      // An overdue PENDING transfer (T1) is the caller's single pending.
      const t1 = await insertTransaction(ds, {
        initiatedBy: owner,
        debitAccountId: src.id,
        creditAccountId: dst.id,
        amount: '3000',
        currency: MXN,
        expiresAt: new Date(Date.now() - 60_000),
      });

      // A valid, active OTP for the caller.
      const code = await generateOtp(owner);

      // Confirming the overdue transfer is rejected as expired, and T1 becomes EXPIRED (retained).
      const expired = await capture(confirm(owner, t1.id, code));
      expect(expired.ok).toBe(false);
      expect(codeOf(expired.error)).toBe('TRANSFER_EXPIRED');
      expect((await txRow(t1.id))?.status).toBe('EXPIRED');
      expect(await legsForTx(t1.id)).toHaveLength(0);

      // PROOF the code was NOT burned: a fresh, non-overdue pending (T2) for the SAME user can be
      // confirmed with the SAME still-valid code — and money moves exactly once (only T2).
      const t2 = await initiate(owner, src.id, dst, 2500);
      const t2Id = idOf(t2);
      expect(await txStatus(t2Id)).toBe('PENDING');

      const posted = await capture(confirm(owner, t2Id, code));
      expect(posted.ok).toBe(true);
      expect(await txStatus(t2Id)).toBe('POSTED');
      expect((await acct(src.id)).balance).toBe(String(10000 - 2500)); // ONLY T2 moved
      expect((await acct(dst.id)).balance).toBe('2500');
      expect(await legsForTx(t2Id)).toHaveLength(2);
    }, 45_000);

    // ---- Cancel: guarded PENDING→CANCELLED (retained); 409 on POSTED; idempotent; owner-scoped ----

    it('cancels a pending transfer (→ CANCELLED, retained); pending read then returns null', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });

      const initiated = await initiate(owner, src.id, dst, 1000);
      const transferId = idOf(initiated);
      expect(await txStatus(transferId)).toBe('PENDING');

      const cancelled = await cancel(owner, transferId);
      expect(statusOf(cancelled)).toBe('CANCELLED');
      expect(await txStatus(transferId)).toBe('CANCELLED'); // retained, not deleted
      expect(await legsForTx(transferId)).toHaveLength(0); // no money moved
      expect((await getPending(owner)) ?? null).toBeNull();
      expect((await acct(src.id)).balance).toBe('10000');
    }, 30_000);

    it('cancelling a POSTED transfer is refused with TransferNotPendingError; the money stays put', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });

      const initiated = await initiate(owner, src.id, dst, 4000);
      const transferId = idOf(initiated);
      const code = await generateOtp(owner);
      await confirm(owner, transferId, code);
      expect(await txStatus(transferId)).toBe('POSTED');

      const res = await capture(cancel(owner, transferId));
      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('TRANSFER_NOT_PENDING');
      expect(await txStatus(transferId)).toBe('POSTED'); // unchanged
      expect((await acct(src.id)).balance).toBe(String(10000 - 4000));
    }, 30_000);

    it('cancelling an already-CANCELLED transfer is idempotent (returns CANCELLED, no throw)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });

      const initiated = await initiate(owner, src.id, dst, 1000);
      const transferId = idOf(initiated);
      await cancel(owner, transferId);
      expect(await txStatus(transferId)).toBe('CANCELLED');

      const again = await capture(cancel(owner, transferId));
      expect(again.ok).toBe(true); // idempotent: no throw
      expect(statusOf(again.value)).toBe('CANCELLED');
    }, 30_000);

    it("cancelling another user's pending transfer is a 404-class TransferNotFound (anti-IDOR); it stays PENDING", async () => {
      const ownerA = newOwner();
      const ownerB = newOwner();
      const srcA = await mkCustomer(ownerA, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });

      const initiated = await initiate(ownerA, srcA.id, dst, 1000);
      const transferId = idOf(initiated);

      const res = await capture(cancel(ownerB, transferId)); // B tries to cancel A's transfer
      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('TRANSFER_NOT_FOUND');
      expect(await txStatus(transferId)).toBe('PENDING'); // A's transfer untouched
    }, 30_000);

    // ---- Reducer gate DIRECT: a re-post of an already-POSTED transfer is refused (money-once) --

    it('refuses a DIRECT second postPendingInTx on an already-POSTED transfer (guarded PENDING→POSTED gate) and moves nothing', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 1500, held: 0 });
      const AMOUNT = 4000;

      const initiated = await initiate(owner, src.id, dst, AMOUNT);
      const transferId = idOf(initiated);
      const code = await generateOtp(owner);
      const confirmed = await confirm(owner, transferId, code);
      expect(statusOf(confirmed)).toBe('POSTED');

      const postSrcBalance = (await acct(src.id)).balance;
      const postDstBalance = (await acct(dst.id)).balance;
      const postLegCount = (await legsForTx(transferId)).length;
      const postOutboxCount = await outboxCount(transferId);
      expect(postSrcBalance).toBe('6000');
      expect(postDstBalance).toBe('5500');
      expect(postLegCount).toBe(2);
      expect(postOutboxCount).toBe(1);

      const posting: any = app.get(getPostingServiceToken(), { strict: false });
      if (!posting || typeof posting.postPendingInTx !== 'function') {
        throw new Error(
          '[integration] resolved the posting service but it lacks ' +
            'postPendingInTx(queryRunner, transactionId, command). Reconcile the contract at ' +
            'tests/support/harness.ts:getPostingServiceToken.',
        );
      }

      const command: any = {
        type: 'internal',
        currency: MXN,
        amount: String(AMOUNT),
        legs: [
          { accountId: src.id, delta: `-${AMOUNT}` },
          { accountId: dst.id, delta: String(AMOUNT) },
        ],
        initiatedBy: owner,
      };

      const second = await postPendingSecondTime(posting, transferId, command);

      expect(second.ok).toBe(false);
      expect(codeOf(second.error)).toBe('TRANSFER_NOT_PENDING');
      const NotPending = domainErrors.TransactionNotPendingError;
      if (NotPending) expect(second.error).toBeInstanceOf(NotPending);

      let txRepo: any;
      try {
        txRepo = app.get(getRepositoryToken('TRANSACTION_REPOSITORY', 'transaction'), {
          strict: false,
        });
      } catch {
        txRepo = undefined;
      }
      if (txRepo && typeof txRepo.transitionToPostedInTx === 'function') {
        const affected = await inRolledBackTx((qr) =>
          txRepo.transitionToPostedInTx(qr, transferId),
        );
        expect(affected).toBe(false); // 0 rows updated: header is already POSTED, not PENDING
      }

      // MONEY-ONCE: nothing moved after the refused second post.
      expect((await acct(src.id)).balance).toBe(postSrcBalance);
      expect((await acct(dst.id)).balance).toBe(postDstBalance);
      expect((await legsForTx(transferId)).length).toBe(postLegCount);
      expect(await outboxCount(transferId)).toBe(postOutboxCount);
      expect(await txStatus(transferId)).toBe('POSTED');
    }, 45_000);
  },
);
