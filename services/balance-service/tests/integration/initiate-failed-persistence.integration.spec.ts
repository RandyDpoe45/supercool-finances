/**
 * Spec 05 (producer side), step P2b — Balance Service, FAILED-transaction persistence at
 * EXTERNAL-OUTBOUND INITIATE. When `initiateExternalTransfer` (POST /api/transfers/external) hits a
 * BUSINESS failure, the system persists a TERMINAL FAILED transaction, COMPLETES the idempotency key
 * linked to it, and emits EXACTLY ONE `transaction.failed` event — then RETURNS the FAILED
 * transaction (so the controller answers 201-FAILED, NOT a 4xx). This is the initiate-time analogue
 * of the confirm-time proofs in failed-persistence.integration.spec.ts, and the initiate-side
 * money-safety keystone: a failed initiate MOVES NO MONEY, PLACES NO HOLD, and is recorded EXACTLY
 * ONCE. Written FROM the spec (specs/DATA-MODEL.md Part 2 — the `transaction.failed` event contract —
 * and the P2b developer brief), NOT from the implementor's code (parallel development).
 *
 * The three BUSINESS failures reachable at external initiate (per the developer-locked taxonomy,
 * pinned by tests/unit/failure-classification.spec.ts):
 *   - INSUFFICIENT_FUNDS   — source available (balance − held) < amount;
 *   - ACCOUNT_FROZEN       — source account is frozen;
 *   - PAYEE_IN_COOLING_OFF — the enrolled payee is still inside its cooling-off window (DB clock).
 * Each persists a FAILED external_outbound row (debit=source, credit=clearing, payee_id set,
 * initiated_by=caller, failure_reason=the domain code, failed_at set, posted_at/expires_at NULL),
 * completes the idempotency key (transaction_id → that FAILED row), and emits ONE `transaction.failed`
 * outbox event carrying the ENRICHED envelope (status FAILED, non-null failureReason, postedAt null,
 * EMPTY legs [], the payee snapshot {id,displayName,rail}, money as int64 STRINGS, schemaVersion 1).
 *
 * A VALIDATION / STRUCTURAL failure (here: payee-not-found / not-owned) is UNCHANGED: it propagates a
 * 4xx, persists NOTHING (no FAILED row, no event), and RELEASES the idempotency key (a same-key retry
 * proceeds fresh) — the taxonomy tripwire at initiate.
 *
 * Why DB+Redis-backed and not mocked: "a failed initiate moves NO money, reserves NOTHING, completes
 * the key exactly once, and emits exactly one event, while a structural rejection records NOTHING and
 * releases the key" are properties of REAL committed transactions + REAL Redis-backed idempotency —
 * mocking them would mock away the very logic under test. Every assertion gates on OBSERVABLE STATE
 * (the transaction row, ledger legs, account balance/held, hold rows, the idempotency_key row, and the
 * committed outbox row + its payload), never on the error kind alone.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a false
 * pass). beforeAll TCP-probes BOTH Postgres and Redis and fails loud if unreachable; boots the real
 * AppModule (migrationsRun:true → schema + MXN + clearing accounts). RELAY_ENABLED=false (env fixture)
 * so no background relay drains the outbox out from under the assertions. Unique account/owner ids per
 * test; committed rows (incl. holds + outbox + idempotency keys) cleaned up per-test.
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
  insertTransaction,
  localAccountNumber,
  TODAY,
  MONTH_START,
} from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED initiate-failed-persistence suite: set BALANCE_INTEGRATION=1 (and point ' +
      'DB_* at Postgres AND REDIS_* at Redis — external initiate under an idempotency claim needs both) ' +
      'to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789';
const MXN = 'MXN';

/** The reserved stream event type for a persisted failed transfer (contract of record). */
const FAILED_EVENT_TYPE = 'transaction.failed';

const suite = ENABLED ? describe : describe.skip;

suite(
  'FAILED-transaction persistence at EXTERNAL INITIATE — FAILED row + one transaction.failed event, no money moved, no hold, key completed/linked; structural = nothing persisted + key released (integration, needs Postgres + Redis)',
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
        typeof svc.initiateExternalTransfer !== 'function'
      ) {
        throw new Error(
          '[integration] resolved the transfers service but it lacks resolveDestination / ' +
            'initiateTransfer / initiateExternalTransfer. Reconcile the contract at ' +
            'tests/support/harness.ts:getTransfersServiceToken.',
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

    async function mkCustomer(
      owner: string,
      overrides: Record<string, unknown> = {},
    ): Promise<any> {
      const { account_number: numberOverride, ...accountOverrides } = overrides as any;
      await insertCustomer(ds, owner);
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
    async function mkPayee(owner: string, displayName = 'Acme Payments'): Promise<any> {
      return insertExternalPayee(ds, {
        ownerId: owner,
        displayName,
        rail: outboundRail,
        coolingOffUntil: new Date(Date.now() - 60_000),
      });
    }

    /** A committed payee still INSIDE its cooling-off window (DB clock < cooling_off_until). */
    async function mkCoolingOffPayee(owner: string, displayName = 'Acme Payments'): Promise<any> {
      return insertExternalPayee(ds, {
        ownerId: owner,
        displayName,
        rail: outboundRail,
        coolingOffUntil: new Date(Date.now() + 3_600_000),
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
          expires_at: Date | null;
          debit_account_id: string | null;
          credit_account_id: string | null;
          payee_id: string | null;
          initiated_by: string;
        }
      | undefined
    > {
      const r = await ds.query(
        `SELECT status, type, failure_reason, failed_at, posted_at, expires_at,
                debit_account_id, credit_account_id, payee_id, initiated_by
           FROM "transaction" WHERE id = $1`,
        [txId],
      );
      return r[0];
    }

    async function holdsForAccount(
      accountId: string,
    ): Promise<Array<{ amount: string; status: string }>> {
      return ds.query(`SELECT amount, status FROM hold WHERE account_id = $1`, [accountId]);
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

    /** The FAILED external_outbound transaction rows for an initiator (there must be exactly one per
     *  failed initiate; the query is the exactly-once tripwire under replay/concurrency). */
    async function failedTxIdsFor(owner: string): Promise<string[]> {
      const r = await ds.query(
        `SELECT id FROM "transaction" WHERE initiated_by = $1 AND status = 'FAILED' ORDER BY id`,
        [owner],
      );
      return r.map((x: any) => x.id);
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

    async function idemKeyRow(
      owner: string,
      key: string,
    ): Promise<{ status: string; transaction_id: string | null } | undefined> {
      const r = await ds.query(
        `SELECT status, transaction_id FROM idempotency_key WHERE owner_id = $1 AND key = $2`,
        [owner, key],
      );
      return r[0];
    }

    /** Placement-agnostic read of the failure reason the event carries (top-level or under
     *  `transaction`), so a proof gates on "the reason IS carried" without pinning the exact key. */
    function payloadFailureReason(payload: any): string | null {
      return payload?.failureReason ?? payload?.transaction?.failureReason ?? null;
    }

    /** The payee snapshot on the event, camelCase-first with a snake_case fallback (mirrors the
     *  event-enrichment suite's placement-agnostic accessors). */
    function payloadPayee(payload: any): any {
      return payload?.transaction?.payee ?? payload?.payee ?? null;
    }
    function pick(obj: any, ...names: string[]): any {
      if (obj === null || obj === undefined) return undefined;
      for (const n of names) if (obj[n] !== undefined) return obj[n];
      return undefined;
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

    async function initiateExternal(
      owner: string,
      sourceId: string,
      payeeId: string,
      amount: number,
      opts: { key?: string } = {},
    ): Promise<any> {
      const k = opts.key ?? `key-${randomUUID()}`;
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

    /** Internal resolve→initiate (stays PENDING; internal places no hold, no funds check at initiate). */
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
      if (de.TransferNotFoundError && err instanceof de.TransferNotFoundError)
        return 'TRANSFER_NOT_FOUND';
      return (err?.code ?? err?.driverError?.code ?? '') as string;
    }

    /**
     * The shared assertion battery for a BUSINESS-failed external initiate: the service RETURNS a
     * FAILED transaction (never a 4xx — the initiate-time inversion vs. confirm), the FAILED row
     * carries the expected shape, the idempotency key is completed + linked, EXACTLY ONE
     * `transaction.failed` event with the enriched envelope is emitted, and NO money moved / NO hold
     * placed. Returns the FAILED transaction id for follow-up (e.g. replay) assertions.
     */
    async function assertBusinessFailedInitiate(args: {
      owner: string;
      src: any;
      payee: any;
      amount: number;
      key: string;
      expectedReason: string;
      srcBalanceBefore: string;
      srcHeldBefore: string;
    }): Promise<string> {
      const { owner, src, payee, amount, key, expectedReason, srcBalanceBefore, srcHeldBefore } =
        args;
      const clearingBefore = await clearingBalance();

      const res = await capture(initiateExternal(owner, src.id, payee.id, amount, { key }));

      // (5) The service RETURNS the FAILED transaction (no throw) → controller answers 201-FAILED.
      expect(res.ok).toBe(true);
      expect(statusOf(res.value)).toBe('FAILED');
      const failedId = idOf(res.value);
      expect(typeof failedId).toBe('string');

      // (1) A single terminal FAILED external_outbound row with the full failed-header shape.
      const failedIds = await failedTxIdsFor(owner);
      expect(failedIds).toEqual([failedId]);
      const row = await txRow(failedId);
      expect(row?.status).toBe('FAILED');
      expect(row?.type).toBe('external_outbound');
      expect(row?.failure_reason).toBe(expectedReason);
      expect(row?.failed_at).not.toBeNull();
      expect(row?.posted_at).toBeNull();
      expect(row?.expires_at).toBeNull(); // never became a live PENDING → no TTL
      expect(row?.debit_account_id).toBe(src.id);
      expect(row?.credit_account_id).toBe(clearingId);
      expect(row?.payee_id).toBe(payee.id);
      expect(row?.initiated_by).toBe(owner);

      // (2) The idempotency key is COMPLETED and its transaction_id LINKS to the FAILED row.
      const idem = await idemKeyRow(owner, key);
      expect(idem?.status).toBe('completed');
      expect(idem?.transaction_id).toBe(failedId);

      // (4) NO money moved: no ledger legs, source balance/held UNCHANGED, clearing UNCHANGED, NO hold.
      expect(await legsForTx(failedId)).toHaveLength(0);
      const a = await acct(src.id);
      expect(a.balance).toBe(srcBalanceBefore);
      expect(a.held).toBe(srcHeldBefore); // no hold placed at an initiate-fail
      expect(await sumPlaced(src.id)).toBe(0n);
      expect(await holdsForAccount(src.id)).toHaveLength(0);
      expect((await clearingBalance()) - clearingBefore).toBe(0n);

      // (3)+(8) EXACTLY ONE outbox row, and it is the transaction.failed event with the enriched
      // envelope (sole emitter — the reducer's fresh-FAILED path, FK'd to the FAILED tx).
      const all = await outboxForTx(failedId);
      expect(all).toHaveLength(1);
      expect(all[0].event_type).toBe(FAILED_EVENT_TYPE);
      const payload = all[0].payload;
      expect(payload?.transaction?.id).toBe(failedId);
      expect(payload?.transaction?.status).toBe('FAILED');
      expect(payload?.transaction?.type).toBe('external_outbound');
      expect(payload?.transaction?.postedAt ?? null).toBeNull();
      expect(payloadFailureReason(payload)).toBe(expectedReason);
      // Empty legs — no money moved, so the double-entry sum-zero invariant holds trivially.
      expect(Array.isArray(payload?.legs)).toBe(true);
      expect(payload?.legs).toHaveLength(0);
      // Money fields are int64 STRINGS (never a JS number).
      expect(typeof payload?.transaction?.amount).toBe('string');
      expect(payload?.transaction?.amount).toBe(String(amount));
      expect(payload?.transaction?.currency).toBe(MXN);
      expect(pick(payload, 'schemaVersion', 'schema_version')).toBe(1);
      // The payee snapshot is present {id, displayName, rail} — per-payee reporting without a join.
      const snap = payloadPayee(payload);
      expect(snap).toBeTruthy();
      expect(pick(snap, 'id')).toBe(payee.id);
      expect(pick(snap, 'displayName', 'display_name')).toBe(payee.display_name);
      expect(pick(snap, 'rail')).toBe(outboundRail);

      // No live PENDING was created for the caller (the FAILED is terminal, not pending).
      expect(await pendingCountFor(owner)).toBe(0);

      return failedId;
    }

    // =========================================================================================
    // PROOFS 1–3 — the three BUSINESS failures reachable at external initiate each persist a FAILED
    // row + complete the key + emit exactly one enriched transaction.failed event, moving no money.
    // =========================================================================================

    it('INSUFFICIENT_FUNDS at external initiate → 201-FAILED external_outbound (reason INSUFFICIENT_FUNDS), key completed+linked, ONE transaction.failed event, NO money moved / NO hold placed', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 1000, held: 0 }); // available 1000
      const payee = await mkPayee(owner);

      await assertBusinessFailedInitiate({
        owner,
        src,
        payee,
        amount: 5000, // > available → INSUFFICIENT_FUNDS
        key: `key-${randomUUID()}`,
        expectedReason: 'INSUFFICIENT_FUNDS',
        srcBalanceBefore: '1000',
        srcHeldBefore: '0',
      });
    }, 45_000);

    it('ACCOUNT_FROZEN at external initiate (source frozen, funds ample) → 201-FAILED (reason ACCOUNT_FROZEN), key completed+linked, ONE transaction.failed event, NO money moved / NO hold placed', async () => {
      const owner = newOwner();
      // Funds are ample so ONLY the frozen gate can trip — isolates the failure_reason.
      const src = await mkCustomer(owner, { balance: 10000, held: 0, status: 'frozen' });
      const payee = await mkPayee(owner);

      await assertBusinessFailedInitiate({
        owner,
        src,
        payee,
        amount: 4000,
        key: `key-${randomUUID()}`,
        expectedReason: 'ACCOUNT_FROZEN',
        srcBalanceBefore: '10000',
        srcHeldBefore: '0',
      });
    }, 45_000);

    it('PAYEE_IN_COOLING_OFF at external initiate (payee still cooling off, source active + funded) → 201-FAILED (reason PAYEE_IN_COOLING_OFF), key completed+linked, ONE transaction.failed event, NO money moved / NO hold placed', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000, held: 0 });
      const payee = await mkCoolingOffPayee(owner); // cooling_off_until in the FUTURE (DB clock)

      await assertBusinessFailedInitiate({
        owner,
        src,
        payee,
        amount: 4000,
        key: `key-${randomUUID()}`,
        expectedReason: 'PAYEE_IN_COOLING_OFF',
        srcBalanceBefore: '10000',
        srcHeldBefore: '0',
      });
    }, 45_000);

    // =========================================================================================
    // PROOF 6 (replay) — a second initiate with the SAME key + matching fingerprint after a
    // business-failed initiate returns the SAME FAILED transaction: NO new FAILED row, NO new event.
    // =========================================================================================

    it('REPLAY: re-initiating with the SAME Idempotency-Key after a business-failed external initiate returns the SAME FAILED transaction — no second FAILED row, no second transaction.failed event (idempotent exactly-once)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 1000, held: 0 });
      const payee = await mkPayee(owner);
      const key = `key-${randomUUID()}`;
      const AMOUNT = 5000; // > available → INSUFFICIENT_FUNDS

      const first = await capture(initiateExternal(owner, src.id, payee.id, AMOUNT, { key }));
      expect(first.ok).toBe(true);
      expect(statusOf(first.value)).toBe('FAILED');
      const failedId = idOf(first.value);
      expect(await failedTxIdsFor(owner)).toEqual([failedId]);
      expect(await failedEventsForTx(failedId)).toHaveLength(1);

      // Replay the SAME key with the SAME business tuple (same source/payee/amount → same fingerprint).
      const second = await capture(initiateExternal(owner, src.id, payee.id, AMOUNT, { key }));
      expect(second.ok).toBe(true);
      expect(statusOf(second.value)).toBe('FAILED');
      expect(idOf(second.value)).toBe(failedId); // the SAME FAILED transaction, regenerated from the row

      // Exactly-once holds under replay: still ONE FAILED row for the caller, still ONE event, still
      // no money moved.
      expect(await failedTxIdsFor(owner)).toEqual([failedId]);
      expect(await outboxForTx(failedId)).toHaveLength(1);
      expect(await failedEventsForTx(failedId)).toHaveLength(1);
      expect(await legsForTx(failedId)).toHaveLength(0);
      expect((await acct(src.id)).balance).toBe('1000');
      expect((await acct(src.id)).held).toBe('0');
    }, 45_000);

    // =========================================================================================
    // PROOF 7 (prior-pending preserved) — a business-failed external initiate does NOT
    // supersede / expire / cancel the caller's existing live PENDING; only a FAILED row is added.
    // =========================================================================================

    it('PRIOR-PENDING PRESERVED: with a live PENDING already in place, a business-failed external initiate leaves that PENDING UNCHANGED (not superseded/expired/cancelled) and only ADDS a FAILED row', async () => {
      const owner = newOwner();
      // Source funds a small internal PENDING (which places NO hold, so available stays == balance),
      // but the external initiate for far more than the balance will INSUFFICIENT_FUNDS-fail.
      const src = await mkCustomer(owner, { balance: 1000, held: 0 });
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
      const payee = await mkPayee(owner);

      // Seed the caller's single live PENDING directly (a normal, not-overdue internal pending).
      const priorPending = await insertTransaction(ds, {
        type: 'internal',
        status: 'PENDING',
        initiatedBy: owner,
        debitAccountId: src.id,
        creditAccountId: dst.id,
        amount: '500',
        currency: MXN,
        expiresAt: new Date(Date.now() + 120_000),
      });
      expect(priorPending.status).toBe('PENDING');
      expect(await pendingCountFor(owner)).toBe(1);

      // A business-failing external initiate (5000 > available 1000).
      const res = await capture(
        initiateExternal(owner, src.id, payee.id, 5000, { key: `key-${randomUUID()}` }),
      );
      expect(res.ok).toBe(true);
      expect(statusOf(res.value)).toBe('FAILED');
      const failedId = idOf(res.value);

      // The prior PENDING is UNCHANGED — the failing initiate's supersede/expire attempt rolled back
      // with its operation tx; the FAILED is persisted separately.
      const prior = await txRow(priorPending.id);
      expect(prior?.status).toBe('PENDING'); // not CANCELLED / EXPIRED
      expect(prior?.failure_reason ?? null).toBeNull(); // not stamped 'superseded'
      expect(prior?.failed_at ?? null).toBeNull();
      expect(await pendingCountFor(owner)).toBe(1); // still exactly the one live pending

      // Only a FAILED row was added; it moved no money and emitted exactly one event.
      expect(await failedTxIdsFor(owner)).toEqual([failedId]);
      expect(await legsForTx(failedId)).toHaveLength(0);
      expect(await failedEventsForTx(failedId)).toHaveLength(1);
      // The prior pending never moved money either.
      expect(await legsForTx(priorPending.id)).toHaveLength(0);
    }, 45_000);

    // =========================================================================================
    // PROOF 9 — INTERNAL initiate is UNCHANGED: no funds/business check at initiate, so an
    // underfunded internal initiate stays PENDING and NEVER produces a FAILED at initiate.
    // =========================================================================================

    it('INTERNAL initiate is unchanged: an underfunded internal initiate stays PENDING (funds are checked at CONFIRM, not initiate) and produces NO FAILED row and NO transaction.failed event', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 1000, held: 0 }); // far less than the amount
      const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });

      const res = await capture(initiateInternal(owner, src.id, dst, 9000)); // 9000 > balance 1000
      expect(res.ok).toBe(true);
      const transferId = idOf(res.value);
      // PENDING — internal initiate performs NO funds check (that is a confirm-time gate).
      expect(statusOf(res.value)).toBe('PENDING');
      expect((await txRow(transferId))?.status).toBe('PENDING');

      // No FAILED at initiate, no money moved, no event yet.
      expect(await failedTxIdsFor(owner)).toEqual([]);
      expect(await legsForTx(transferId)).toHaveLength(0);
      expect(await outboxForTx(transferId)).toHaveLength(0);
      expect((await acct(src.id)).balance).toBe('1000');
    }, 45_000);

    // =========================================================================================
    // TAXONOMY at initiate — a STRUCTURAL failure (payee not found / not owned) propagates a 4xx,
    // persists NOTHING, and RELEASES the idempotency key (a same-key retry proceeds fresh).
    // =========================================================================================

    it('STRUCTURAL (payee not owned / not found) at external initiate → propagates a 404-class error, persists NOTHING (no FAILED row, no event), and the idempotency key is RELEASED (not completed)', async () => {
      const attacker = newOwner();
      const victim = newOwner();
      const src = await mkCustomer(attacker, { balance: 10000, held: 0 });
      const victimPayee = await mkPayee(victim); // enrolled by the victim, NOT the attacker
      const key = `key-${randomUUID()}`;

      const res = await capture(initiateExternal(attacker, src.id, victimPayee.id, 1000, { key }));

      // Propagates (does NOT return a FAILED) — a structural error is a plain 4xx.
      expect(res.ok).toBe(false);
      expect(['PAYEE_NOT_FOUND', 'TRANSFER_NOT_FOUND']).toContain(codeOf(res.error));

      // NOTHING persisted for the attacker: no transaction at all, no outbox, no hold, no money moved.
      expect(await anyTxCountFor(attacker)).toBe(0);
      expect(await failedTxIdsFor(attacker)).toEqual([]);
      expect((await acct(src.id)).held).toBe('0');
      expect(await holdsForAccount(src.id)).toHaveLength(0);

      // The idempotency key is RELEASED (not left completed/in_progress): no 'completed' row remains,
      // so a retry with the SAME key is a FRESH request. Prove it BEHAVIORALLY: re-run the same key
      // against the attacker's OWN, usable payee → it now proceeds to a live PENDING.
      const idem = await idemKeyRow(attacker, key);
      expect(idem?.status ?? null).not.toBe('completed');

      const ownPayee = await mkPayee(attacker);
      const retry = await capture(initiateExternal(attacker, src.id, ownPayee.id, 1000, { key }));
      expect(retry.ok).toBe(true);
      expect(statusOf(retry.value)).toBe('PENDING'); // fresh request under the released key
      expect(await pendingCountFor(attacker)).toBe(1);
    }, 45_000);

    // =========================================================================================
    // CONCURRENCY (exactly-once) — two concurrent SAME-KEY business-failing initiates settle to
    // EXACTLY ONE FAILED transaction + ONE transaction.failed event (no double-FAILED, no double
    // event, no money created). The idempotency unique index (owner_id, key) serializes the pair:
    // one processes the FAILED, the other replays the completed key (same id) or briefly sees the
    // in-progress claim; either way the invariant is exactly-one. Deterministic under the unique
    // index — this is not a timing race on the assertion, only on which call is the winner.
    // =========================================================================================

    it('CONCURRENCY: two concurrent initiates with the SAME key that both business-fail yield EXACTLY ONE FAILED transaction and ONE transaction.failed event (any fulfilled call returns that same id)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 1000, held: 0 });
      const payee = await mkPayee(owner);
      const key = `key-${randomUUID()}`;
      const AMOUNT = 5000; // > available → INSUFFICIENT_FUNDS

      const results = await Promise.allSettled([
        initiateExternal(owner, src.id, payee.id, AMOUNT, { key }),
        initiateExternal(owner, src.id, payee.id, AMOUNT, { key }),
      ]);

      // EXACTLY ONE FAILED transaction for the caller — never two (a double-FAILED would be a
      // manufactured record).
      const failedIds = await failedTxIdsFor(owner);
      expect(failedIds).toHaveLength(1);
      const failedId = failedIds[0];

      // EXACTLY ONE transaction.failed event for it — never two (a double event would be a
      // duplicate on the read side despite the event_id dedup).
      expect(await outboxForTx(failedId)).toHaveLength(1);
      expect(await failedEventsForTx(failedId)).toHaveLength(1);

      // Any call that fulfilled returns the SAME FAILED id (processed or replayed the completed key).
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
      );
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      for (const r of fulfilled) {
        expect(statusOf(r.value)).toBe('FAILED');
        expect(idOf(r.value)).toBe(failedId);
      }

      // No money moved / no hold, no live pending — the concurrency did not create or reserve funds.
      expect(await legsForTx(failedId)).toHaveLength(0);
      expect((await acct(src.id)).balance).toBe('1000');
      expect((await acct(src.id)).held).toBe('0');
      expect(await sumPlaced(src.id)).toBe(0n);
      expect(await pendingCountFor(owner)).toBe(0);
    }, 45_000);
  },
);
