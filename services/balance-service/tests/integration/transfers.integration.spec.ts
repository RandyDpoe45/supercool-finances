/**
 * Spec 04 — Balance Service, Step-4b: internal transfers END-TO-END at the service layer. These are
 * the Definition-of-Done money-safety proofs for the transfers feature, driven against the REAL
 * DI'd TransfersService (resolved BY TOKEN through a booted AppModule) with real Postgres + real
 * Redis. Written FROM the spec (Transfers: internal transfers stay PENDING at initiate, post on
 * OTP-confirm, funds-checked at confirm-time under the account lock; Idempotency; soft-duplicate;
 * OTP single-use) and the DoD (concurrency → no double-spend / no overdraft / no money created or
 * lost; a replayed key moves money once; reconciliation `sum(ledger delta) == account.balance`),
 * NOT from the implementor's code.
 *
 * Why DB+Redis-backed and not mocked: the invariants here (money moves exactly once under a replay,
 * exactly once under N concurrent confirms via OTP single-use + the guarded PENDING→POSTED
 * transition, the confirm-time funds check under the FOR UPDATE lock, the atomic ledger/balance
 * fold, one-outbox-per-post) are properties of REAL transactions and REAL Redis GETDEL — mocking
 * them would mock away the very logic under test. Every assertion gates on OBSERVABLE STATE
 * (balances, ledger rows, transaction status, outbox count), never on the error kind alone.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a false
 * pass). beforeAll TCP-probes BOTH Postgres and Redis (the confirm write path hits both) and fails
 * loud if unreachable; boots the real AppModule (migrationsRun:true → MXN + clearing accounts).
 * jest.config.ts serializes the integration run (maxWorkers:1). Unique account/owner ids per test;
 * committed rows + minted OTP keys are cleaned up per-test (OTP keys via `del`, NEVER flushall).
 *
 * ASSUMED service contract (task/spec-derived — the coordination point; escalate if it diverges):
 *   initiateTransfer(params) → the PENDING Transaction entity; params carry ownerId,
 *     sourceAccountId, destinationAccountId, amount (integer minor units), currency, an idempotency
 *     key, and optional confirmDuplicate. (Field-name aliases are passed so the proof is robust.)
 *   confirmTransfer(params) → the POSTED Transaction entity; params carry ownerId, the transfer id,
 *     and the OTP code.
 *   listPendingAuthorizations(ownerId) → the caller's PENDING transfers.
 * The user-scoped OTP is minted via the real OTP service (resolved by token), matching the
 * `POST /api/otp` surface.
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
  getRunInTransactionWithRetry,
  getDomainErrors,
  tcpProbe,
} from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import { insertRow, TODAY, MONTH_START } from '../support/pg';

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

const suite = ENABLED ? describe : describe.skip;

suite(
  'internal transfers end-to-end — DoD money-safety proofs (integration, needs Postgres + Redis)',
  () => {
    let app: INestApplication;
    let ds: any;
    let svc: any;
    let otp: any;
    let redis: any;
    let domainErrors: ReturnType<typeof getDomainErrors>;

    let createdAccountIds: string[] = [];
    let trackedOwners: string[] = [];
    let trackedOtpKeys: string[] = [];

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
        typeof svc.initiateTransfer !== 'function' ||
        typeof svc.confirmTransfer !== 'function' ||
        typeof svc.listPendingAuthorizations !== 'function'
      ) {
        throw new Error(
          '[integration] resolved the transfers service but it lacks initiateTransfer / confirmTransfer / ' +
            'listPendingAuthorizations. Reconcile the contract at tests/support/harness.ts:getTransfersServiceToken.',
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
      const otpKeys = Array.from(new Set(trackedOtpKeys));
      createdAccountIds = [];
      trackedOwners = [];
      trackedOtpKeys = [];
      if (redis && otpKeys.length) {
        try {
          await redis.del(...otpKeys);
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

    async function mkCustomer(
      owner: string,
      overrides: Record<string, unknown> = {},
    ): Promise<any> {
      const acc = await insertRow(ds, 'account', {
        kind: 'customer',
        owner_id: owner,
        currency: MXN,
        status: 'active',
        balance: 0,
        held: 0,
        spent_today_date: TODAY,
        spent_month_date: MONTH_START,
        ...overrides,
      });
      createdAccountIds.push(acc.id);
      return acc;
    }

    function newOwner(): string {
      const o = `sub-${randomUUID()}`;
      trackedOwners.push(o);
      return o;
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
      if (ids.length) await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
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

    const sumDeltas = (legs: Array<{ delta: string }>): bigint =>
      legs.reduce((s, l) => s + BigInt(l.delta), 0n);

    // ---- service adapters (documented assumed shapes; alias-hedged) -----------------------

    function idOf(r: any): string {
      const id =
        r?.id ?? r?.transactionId ?? r?.transferId ?? r?.transfer?.id ?? r?.transaction?.id;
      return id as string;
    }
    function statusOf(r: any): string | undefined {
      return r?.status ?? r?.transfer?.status ?? r?.transaction?.status;
    }

    async function initiate(
      owner: string,
      source: string,
      dest: string,
      amount: number,
      opts: { currency?: string; key?: string; confirmDuplicate?: boolean } = {},
    ): Promise<any> {
      const k = opts.key ?? `key-${randomUUID()}`;
      const params: any = {
        ownerId: owner,
        sub: owner,
        sourceAccountId: source,
        destinationAccountId: dest,
        amount: String(amount), // canonical unsigned minor-unit string (never a JS number)
        currency: opts.currency ?? MXN,
        idempotencyKey: k,
        key: k,
      };
      if (opts.confirmDuplicate !== undefined) params.confirmDuplicate = opts.confirmDuplicate;
      return svc.initiateTransfer(params);
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

    async function generateOtp(owner: string): Promise<string> {
      const r = await otp.generate(owner);
      const code = r.code as string;
      trackedOtpKeys.push(`otp:${owner}`);
      trackedOtpKeys.push(
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
      const de = domainErrors;
      if (de.InsufficientFundsError && err instanceof de.InsufficientFundsError)
        return 'INSUFFICIENT_FUNDS';
      if (de.SuspectedDuplicateError && err instanceof de.SuspectedDuplicateError)
        return 'SUSPECTED_DUPLICATE';
      if (de.InvalidOtpError && err instanceof de.InvalidOtpError) return 'INVALID_OTP';
      return (err?.code ?? err?.errorCode ?? '') as string;
    }

    // ---- reducer-gate adapters (drive the confirm-time seam DIRECTLY, off the OTP path) ----

    /**
     * Invoke the reducer's confirm-time seam `postPendingInTx(queryRunner, transferId, command)`
     * inside ONE DB transaction — the SAME path `confirmTransfer` takes (via
     * `runInTransactionWithRetry`). Falls back to a manually managed QueryRunner transaction if
     * the wrapper is not resolvable, mirroring its commit-on-success / rollback-and-rethrow
     * semantics so the money-once proof holds either way (a broken gate that POSTS twice would
     * commit and be caught by the state assertions; a correct gate throws and rolls back).
     */
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

    /** Run `fn` inside a QueryRunner transaction that is ALWAYS rolled back — used for the
     *  repo-level predicate probe so the assertion never mutates committed state. */
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

    // ---- 1) Happy path: PENDING at initiate (no money moves), POSTED on confirm -----------

    it('initiates PENDING with balances UNCHANGED, then confirm posts exactly one balanced ledger pair + one outbox', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 1500, held: 0 });
      const AMOUNT = 4000;

      const initiated = await initiate(owner, src.id, dst.id, AMOUNT);
      const transferId = idOf(initiated);
      expect(typeof transferId).toBe('string');

      // NO money moved at initiate (internal transfers place no hold): both balances untouched, and
      // the transaction sits PENDING.
      expect((await acct(src.id)).balance).toBe('10000');
      expect((await acct(src.id)).held).toBe('0');
      expect((await acct(dst.id)).balance).toBe('1500');
      expect(await txStatus(transferId)).toBe('PENDING');
      expect(await legsForTx(transferId)).toHaveLength(0); // nothing posted yet

      const code = await generateOtp(owner);
      const confirmed = await confirm(owner, transferId, code);
      expect(statusOf(confirmed)).toBe('POSTED');

      // Money moved exactly once: source debited, destination credited.
      expect((await acct(src.id)).balance).toBe('6000'); // 10000 - 4000
      expect((await acct(dst.id)).balance).toBe('5500'); // 1500 + 4000
      expect(await txStatus(transferId)).toBe('POSTED');

      // Exactly one double-entry pair (deltas sum to 0) and exactly one outbox row.
      const legs = await legsForTx(transferId);
      expect(legs).toHaveLength(2);
      expect(sumDeltas(legs)).toBe(0n);
      expect(await outboxCount(transferId)).toBe(1);

      // Reconciliation (the materialized balance tracks the ledger fold): accounts are seeded with
      // a starting balance directly (not via a ledger posting), so the projection invariant is
      // `balance == seeded_initial + SUM(ledger delta)` — every posted movement is reflected in
      // both the ledger and the cached balance, in lock-step.
      const initial: Record<string, bigint> = { [src.id]: 10000n, [dst.id]: 1500n };
      for (const id of [src.id, dst.id]) {
        const rec = await ds.query(
          `SELECT COALESCE(SUM(delta),0)::text AS s FROM ledger_entry WHERE account_id = $1`,
          [id],
        );
        expect(BigInt((await acct(id)).balance)).toBe(initial[id] + BigInt(rec[0].s));
      }
    }, 30_000);

    // ---- 2) Idempotency (DoD): a replayed key produces ONE pending transfer, money moves once ----

    it('replays the SAME Idempotency-Key to the SAME pending transfer (no duplicate), and money moves once on confirm', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
      const key = `key-${randomUUID()}`;
      const AMOUNT = 2500;

      const r1 = await initiate(owner, src.id, dst.id, AMOUNT, { key });
      const r2 = await initiate(owner, src.id, dst.id, AMOUNT, { key });
      const id1 = idOf(r1);
      const id2 = idOf(r2);

      expect(id2).toBe(id1); // same pending transfer, not a duplicate
      const pendingCount = await ds.query(
        `SELECT count(*)::int AS n FROM "transaction" WHERE initiated_by = $1 AND status = 'PENDING'`,
        [owner],
      );
      expect(pendingCount[0].n).toBe(1); // exactly ONE pending transfer created

      const code = await generateOtp(owner);
      await confirm(owner, id1, code);

      // Money moved exactly once despite the replayed initiate.
      expect((await acct(src.id)).balance).toBe(String(10000 - AMOUNT));
      expect((await acct(dst.id)).balance).toBe(String(AMOUNT));
      expect(await legsForTx(id1)).toHaveLength(2);
    }, 30_000);

    // ---- 3) Concurrency (DoD): N concurrent confirms → transfer posts AT MOST ONCE --------

    it('posts AT MOST ONCE under N concurrent confirms of one transfer with one OTP: no double-spend, money conserved', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 2000, held: 0 });
      const AMOUNT = 3000;
      const N = 8;

      const initiated = await initiate(owner, src.id, dst.id, AMOUNT);
      const transferId = idOf(initiated);
      const code = await generateOtp(owner);

      // Fire N concurrent confirms with the SAME code. OTP single-use (GETDEL) + the guarded
      // PENDING→POSTED transition must let AT MOST ONE post.
      await Promise.allSettled(Array.from({ length: N }, () => confirm(owner, transferId, code)));

      // Observable state proves exactly-once: one balanced ledger pair, one outbox, balances moved once.
      const legs = await legsForTx(transferId);
      expect(legs).toHaveLength(2); // NOT 2*k — the transfer posted once
      expect(sumDeltas(legs)).toBe(0n); // no money created or lost
      expect(await outboxCount(transferId)).toBe(1);
      expect(await txStatus(transferId)).toBe('POSTED');
      expect((await acct(src.id)).balance).toBe(String(10000 - AMOUNT)); // debited exactly once, no overdraft
      expect((await acct(dst.id)).balance).toBe(String(2000 + AMOUNT)); // credited exactly once
    }, 45_000);

    // ---- 4) OTP gating: wrong/lockout keeps the transfer PENDING; single-use posts once ----

    it('a wrong OTP up to lockout never posts (stays PENDING), and the correct code after lockout still cannot post (burned)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });

      const initiated = await initiate(owner, src.id, dst.id, 1000);
      const transferId = idOf(initiated);
      const code = await generateOtp(owner);
      const wrong = code.slice(0, -1) + (code.endsWith('0') ? '1' : '0');

      // Enough wrong attempts to hit lockout (allowance is 3; loop a few extra — post-lockout the code
      // is burned and further wrongs are harmless no-active-code misses).
      for (let i = 0; i < 4; i++) {
        const res = await capture(confirm(owner, transferId, wrong));
        expect(res.ok).toBe(false); // never posts on a wrong code
      }
      // Not posted throughout: still PENDING, no ledger legs, balances untouched.
      expect(await txStatus(transferId)).toBe('PENDING');
      expect(await legsForTx(transferId)).toHaveLength(0);
      expect((await acct(src.id)).balance).toBe('10000');

      // The correct code AFTER the lockout still cannot post — it was burned at lockout.
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

      const initiated = await initiate(owner, src.id, dst.id, AMOUNT);
      const transferId = idOf(initiated);
      const code = await generateOtp(owner);

      const first = await capture(confirm(owner, transferId, code));
      expect(first.ok).toBe(true);
      expect(statusOf(first.value)).toBe('POSTED');

      // A second confirm with the same (now consumed) code must NOT move money again — either it
      // returns the already-POSTED transfer or it is rejected, but the ledger stays a single pair.
      await capture(confirm(owner, transferId, code));

      expect(await legsForTx(transferId)).toHaveLength(2); // still exactly one pair
      expect((await acct(src.id)).balance).toBe(String(10000 - AMOUNT)); // debited once only
      expect((await acct(dst.id)).balance).toBe(String(AMOUNT));
      expect(await outboxCount(transferId)).toBe(1);
    }, 30_000);

    // ---- 5) Confirm-time funds check: overdraft is caught at confirm, transfer stays PENDING ----

    it('lets an over-available transfer stay PENDING at initiate, then rejects it at confirm with INSUFFICIENT_FUNDS (nothing posted)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 1000, held: 0 }); // available = 1000
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
      const AMOUNT = 5000; // more than available

      // Initiate does NOT funds-check — the transfer is accepted as PENDING.
      const initiated = await initiate(owner, src.id, dst.id, AMOUNT);
      const transferId = idOf(initiated);
      expect(await txStatus(transferId)).toBe('PENDING');

      const code = await generateOtp(owner);
      const res = await capture(confirm(owner, transferId, code));

      expect(res.ok).toBe(false);
      expect(codeOf(res.error)).toBe('INSUFFICIENT_FUNDS'); // the confirm-time funds check fired
      // Nothing posted: still PENDING, no ledger legs, no outbox, balances unchanged.
      expect(await txStatus(transferId)).toBe('PENDING');
      expect(await legsForTx(transferId)).toHaveLength(0);
      expect(await outboxCount(transferId)).toBe(0);
      expect((await acct(src.id)).balance).toBe('1000');
      expect((await acct(dst.id)).balance).toBe('0');
    }, 30_000);

    // ---- 6) Soft-duplicate: same fingerprint within 60s is suppressed; confirmDuplicate overrides ----

    it('suppresses a second initiate with a DIFFERENT key but the SAME fingerprint within 60s; confirmDuplicate proceeds', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 20000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
      const AMOUNT = 1200;

      const first = await initiate(owner, src.id, dst.id, AMOUNT); // key auto (k1)
      const firstId = idOf(first);

      // A DIFFERENT key, identical (type,source,destination,amount,currency) fingerprint, moments
      // later → suspected duplicate (soft block).
      const dup = await capture(initiate(owner, src.id, dst.id, AMOUNT));
      expect(dup.ok).toBe(false);
      expect(codeOf(dup.error)).toBe('SUSPECTED_DUPLICATE');

      // confirmDuplicate:true lets the explicit repeat through as a NEW pending transfer.
      const override = await initiate(owner, src.id, dst.id, AMOUNT, { confirmDuplicate: true });
      const overrideId = idOf(override);
      expect(overrideId).not.toBe(firstId);

      const pendingCount = await ds.query(
        `SELECT count(*)::int AS n FROM "transaction" WHERE initiated_by = $1 AND status = 'PENDING'`,
        [owner],
      );
      expect(pendingCount[0].n).toBe(2); // the first + the confirmed duplicate; the blocked one is absent
    }, 30_000);

    // ---- 7) pending-authorizations: caller-scoped, excludes POSTED and other users -------

    it("lists ONLY the caller's PENDING transfers (excludes POSTED and other users' transfers)", async () => {
      const ownerA = newOwner();
      const ownerB = newOwner();
      const srcA = await mkCustomer(ownerA, { balance: 20000, held: 0 });
      const srcB = await mkCustomer(ownerB, { balance: 20000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });

      // A initiates two; B initiates one. All start PENDING.
      const a1 = idOf(await initiate(ownerA, srcA.id, dst.id, 1000, { confirmDuplicate: true }));
      const a2 = idOf(await initiate(ownerA, srcA.id, dst.id, 2000, { confirmDuplicate: true }));
      const b1 = idOf(await initiate(ownerB, srcB.id, dst.id, 3000, { confirmDuplicate: true }));

      // Post A's first transfer (so it leaves the pending set).
      const codeA = await generateOtp(ownerA);
      await confirm(ownerA, a1, codeA);
      expect(await txStatus(a1)).toBe('POSTED');

      const listA = await svc.listPendingAuthorizations(ownerA);
      const idsA = (Array.isArray(listA) ? listA : []).map((t: any) => idOf(t));
      expect(idsA).toContain(a2); // A's still-pending transfer
      expect(idsA).not.toContain(a1); // the posted one is gone
      expect(idsA).not.toContain(b1); // B's transfer never appears for A (anti-IDOR)

      const listB = await svc.listPendingAuthorizations(ownerB);
      const idsB = (Array.isArray(listB) ? listB : []).map((t: any) => idOf(t));
      expect(idsB).toContain(b1);
      expect(idsB).not.toContain(a2);
    }, 30_000);

    // ---- 8) Reducer gate DIRECT: a re-post of an already-POSTED transfer is refused (money-once) --
    //
    // Every case above reaches `postPendingInTx` through the single-use OTP gate, so AT MOST ONE
    // caller ever enters the reducer and its guarded `UPDATE … WHERE status='PENDING'` always finds
    // a PENDING row (affected=1). The transfers service's `status !== PENDING` pre-check is a
    // stale-read TOCTOU guard, NOT the race-safe gate — a regression that dropped the
    // `WHERE status='PENDING'` predicate (turning it into an UNCONDITIONAL update, so a second post
    // double-applies the money) would slip past the ENTIRE OTP-driven suite above. This pins the
    // DB-level gate DIRECTLY, independent of OTP: drive a transfer to POSTED via the happy path,
    // then invoke `posting.postPendingInTx` a SECOND time on the now-POSTED header and prove it is
    // REFUSED and moves NOTHING — the exact money-once property the guarded predicate provides. A
    // companion assertion pins the same predicate one layer down at the repository seam
    // (`transitionToPostedInTx` returns false / 0 rows on the POSTED header).

    it('refuses a DIRECT second postPendingInTx on an already-POSTED transfer (guarded PENDING→POSTED gate) and moves nothing', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 1500, held: 0 });
      const AMOUNT = 4000;

      // Drive the transfer to POSTED ONCE through the real happy path (OTP generate + confirm) —
      // reusing the file's helpers so this is the exact same money movement the OTP tests exercise.
      const initiated = await initiate(owner, src.id, dst.id, AMOUNT);
      const transferId = idOf(initiated);
      const code = await generateOtp(owner);
      const confirmed = await confirm(owner, transferId, code);
      expect(statusOf(confirmed)).toBe('POSTED');

      // Capture the post-state after the ONE legitimate post: balances moved once, one ledger pair,
      // one outbox row. These are the invariants the refused second call must leave untouched.
      const postSrcBalance = (await acct(src.id)).balance;
      const postDstBalance = (await acct(dst.id)).balance;
      const postLegCount = (await legsForTx(transferId)).length;
      const postOutboxCount = await outboxCount(transferId);
      expect(postSrcBalance).toBe('6000'); // 10000 - 4000
      expect(postDstBalance).toBe('5500'); // 1500 + 4000
      expect(postLegCount).toBe(2);
      expect(postOutboxCount).toBe(1);

      // Resolve the REAL reducer BY TOKEN through the booted app graph (the module binds
      // `{ provide: POSTING_SERVICE, useClass: PostingService }`, so it resolves by Symbol).
      const posting: any = app.get(getPostingServiceToken(), { strict: false });
      if (!posting || typeof posting.postPendingInTx !== 'function') {
        throw new Error(
          '[integration] resolved the posting service but it lacks ' +
            'postPendingInTx(queryRunner, transactionId, command). Reconcile the contract at ' +
            'tests/support/harness.ts:getPostingServiceToken.',
        );
      }

      // Rebuild EXACTLY the command `confirmTransfer` hands the reducer for this transfer: an
      // internal double-entry, debit source (−amount) / credit destination (+amount). The source
      // still holds 6000 ≥ 4000 and the currency matches, so the reducer's per-leg funds/currency
      // checks PASS — the ONLY thing that can reject this call is the guarded transition finding no
      // PENDING row. (If the checks could reject first, we'd be proving the wrong gate.)
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

      // The guarded PENDING→POSTED transition finds 0 PENDING rows and MUST refuse — it throws.
      // (An unconditional UPDATE regression would instead succeed here and double-apply.)
      expect(second.ok).toBe(false);
      expect(codeOf(second.error)).toBe('TRANSFER_NOT_PENDING');
      // Exact class match when the domain error is exported (secondary signal to the code above).
      // The REDUCER gate throws posting's `TransactionNotPendingError` (distinct from the transfers
      // service pre-check's `TransferNotPendingError`, though both carry `TRANSFER_NOT_PENDING`).
      const NotPending = domainErrors.TransactionNotPendingError;
      if (NotPending) expect(second.error).toBeInstanceOf(NotPending);

      // Companion seam: the repository predicate itself returns false (0 rows) on the POSTED
      // header — this pins the `WHERE status='PENDING'` guard at the repository boundary too.
      let txRepo: any;
      try {
        txRepo = app.get(getRepositoryToken('TRANSACTION_REPOSITORY', 'transaction'), {
          strict: false,
        });
      } catch {
        txRepo = undefined; // best-effort — the reducer-gate proof above stands on its own
      }
      if (txRepo && typeof txRepo.transitionToPostedInTx === 'function') {
        const affected = await inRolledBackTx((qr) =>
          txRepo.transitionToPostedInTx(qr, transferId),
        );
        expect(affected).toBe(false); // 0 rows updated: header is already POSTED, not PENDING
      }

      // MONEY-ONCE: nothing moved after the refused second post — the whole point of the predicate.
      expect((await acct(src.id)).balance).toBe(postSrcBalance); // still 6000, not double-debited
      expect((await acct(dst.id)).balance).toBe(postDstBalance); // still 5500, not double-credited
      expect((await legsForTx(transferId)).length).toBe(postLegCount); // no extra ledger legs
      expect(await outboxCount(transferId)).toBe(postOutboxCount); // no second outbox event
      expect(await txStatus(transferId)).toBe('POSTED'); // header status unchanged
    }, 45_000);
  },
);
