/**
 * Spec 04/05 — Balance Service: the ENRICHED POSTED transaction EVENT CONTRACT (the persisted
 * `outbox_event.payload` written in the SAME DB transaction as the ledger change, later relayed
 * to `events:transactions` and consumed by the analytics server). Written FROM the spec/contract
 * of record — `specs/analytics-schema.yaml` (CONSUMED EVENT CONTRACT), `specs/DATA-MODEL.md`
 * (Part 2 event contract) and ADR-11 (analytics owns Mongo and may NOT join back to Postgres, so
 * the event must be self-contained) — NOT from the implementor's code (authored in parallel).
 *
 * The intended emitted `payload` contract (camelCase wire; money = int64 as STRING, never a JS
 * number):
 *   schemaVersion: 1
 *   occurredAt:    ISO-8601
 *   transaction: { id, type, status, amount (string), currency, initiatedBy,
 *                  reversesTransactionId (string|null), payee ({id,displayName,rail}|null),
 *                  createdAt (ISO), postedAt (ISO|null) }
 *   legs: [ { accountId, ownerId (customer sub | null for system/clearing),
 *             accountKind ('customer'|'system'), systemKey (string|null),
 *             delta (string signed minor), balanceAfter (string minor), currency } ]   // SUM(delta)==0
 *
 * These prove the 7 money-safety/contract points the step calls for:
 *   (1) per-leg identity is ON the event (ownerId / accountKind / systemKey) — no Postgres join;
 *   (2) double-entry preserved on the event (SUM(delta)==0; balanceAfter == post-balance);
 *   (3) money is int64-as-STRING, exact past 2^53 (a Number would corrupt it — the keystone);
 *   (4) payee snapshot present for external_outbound, null for internal/inbound;
 *   (5) a maker-checker reversal emits a POSTED compensating event linked via reversesTransactionId
 *       (link-only — no separate 'reversed' event);
 *   (6) header fields (status POSTED, initiatedBy = acting sub, schemaVersion 1, ISO stamps);
 *   (7) exactly ONE outbox row per post.
 *
 * Why DB+Redis-backed and not mocked: the enrichment reads the per-leg identity, the running
 * balance fold, the payee snapshot and the reversal linkage OUT OF the real ledger/accounts under
 * the reducer's own transaction — mocking the outbox/ledger would fake the very projection under
 * test. So the suite drives the REAL DI'd PostingService / TransfersService / ApprovalService
 * (resolved BY TOKEN through a booted AppModule) against the compose datastores and inspects the
 * COMMITTED `outbox_event.payload` (jsonb → parsed object). Every assertion gates on the observable
 * payload contract, never on an internal helper name.
 *
 * WIRE-KEY CASING — ESCALATION. The task/DoD and DATA-MODEL Part 2 (the Mongo `transactions`
 * document) specify a camelCase wire; the DATA-MODEL "CONSUMED EVENT CONTRACT" *comment block*
 * still shows snake_case field names (event_id/owner_id/account_kind/…). The VALUE proofs below
 * read fields camelCase-first with a snake_case fallback, so a money-safety defect (missing
 * ownerId, a Number instead of a string, unbalanced legs, a missing payee/reversal link) fails on
 * ITS OWN concern regardless of the casing decision. A dedicated, clearly-labelled test
 * ('camelCase wire-naming contract') pins the task-directed camelCase keys so a snake_case emission
 * is flagged as exactly one naming failure (waivable/updatable if the decision lands on snake_case)
 * rather than reddening every proof. See the test-writer report.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a
 * false pass); beforeAll TCP-probes BOTH Postgres and Redis and fails loud if unreachable; boots
 * the real AppModule (migrationsRun:true → MXN + the two clearing accounts). jest.config serializes
 * the integration run (maxWorkers:1). Unique account/owner/admin ids per test; committed rows
 * (accounts, customers, transactions, ledger, outbox, holds, payees, approvals, audit) + minted OTP
 * keys cleaned up per-test.
 *
 * To run:
 *   BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=… REDIS_HOST=… REDIS_PORT=…] npm test
 */
import 'reflect-metadata';
import { createHmac, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import * as harness from '../support/harness';
import { getAppModule, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import * as pg from '../support/pg';
const {
  insertRow,
  insertCustomer,
  insertExternalPayee,
  insertTransaction,
  getReversalTxsFor,
  deleteApprovalsByTarget,
  deleteAuditRowsByActor,
  localAccountNumber,
  TODAY,
  MONTH_START,
} = pg;

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED event-enrichment suite: set BALANCE_INTEGRATION=1 (and point DB_* at ' +
      'Postgres AND REDIS_* at Redis — the external-outbound + reversal paths need both) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789';
const MXN = 'MXN';

const suite = ENABLED ? describe : describe.skip;

suite('enriched POSTED transaction event contract (integration, needs Postgres + Redis)', () => {
  let app: INestApplication;
  let ds: any;
  let posting: any;
  let transfers: any;
  let otp: any;
  let approvals: any;
  let redis: any;
  let outboundRail: string;
  let inboundClearingId: string;
  let outboundClearingId: string;

  let createdAccountIds: string[] = [];
  let trackedOwners: string[] = [];
  let trackedAdmins: string[] = [];
  let trackedRedisKeys: string[] = [];

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
    if (!ds) throw new Error('[integration] could not resolve the TypeORM DataSource from the app');

    posting = app.get(harness.getPostingServiceToken(), { strict: false });
    if (!posting || typeof posting.postTransaction !== 'function') {
      throw new Error(
        '[integration] resolved POSTING_SERVICE but it has no postTransaction(command).',
      );
    }

    transfers = app.get(harness.getTransfersServiceToken(), { strict: false });
    if (
      !transfers ||
      typeof transfers.initiateExternalTransfer !== 'function' ||
      typeof transfers.confirmTransfer !== 'function'
    ) {
      throw new Error(
        '[integration] resolved TRANSFERS_SERVICE but it lacks initiateExternalTransfer / confirmTransfer.',
      );
    }

    otp = app.get(harness.getOtpServiceToken(), { strict: false });
    if (!otp || typeof otp.generate !== 'function') {
      throw new Error('[integration] resolved OTP_SERVICE but it has no generate(userId).');
    }

    approvals = app.get(harness.getApprovalServiceToken(), { strict: false });
    if (
      !approvals ||
      typeof approvals.proposeReversal !== 'function' ||
      typeof approvals.approve !== 'function'
    ) {
      throw new Error(
        '[integration] resolved APPROVAL_SERVICE but it lacks proposeReversal / approve.',
      );
    }

    redis = app.get(harness.getRedisClientToken(), { strict: false });
    if (!redis || typeof redis.del !== 'function') {
      throw new Error('[integration] could not resolve a usable ioredis client via REDIS_CLIENT.');
    }

    outboundRail = harness.getOutboundRail();
    inboundClearingId = await systemAccountId('clearing:rail-inbound');
    outboundClearingId = await systemAccountId(`clearing:${outboundRail}`);
  }, 90_000);

  afterEach(async () => {
    const ids = createdAccountIds;
    const owners = trackedOwners;
    const admins = trackedAdmins;
    const redisKeys = Array.from(new Set(trackedRedisKeys));
    createdAccountIds = [];
    trackedOwners = [];
    trackedAdmins = [];
    trackedRedisKeys = [];
    if (redis && redisKeys.length) {
      try {
        await redis.del(...redisKeys);
      } catch {
        /* best-effort */
      }
    }
    try {
      await cleanup(ids, owners, admins);
    } catch {
      /* best-effort; random ids keep re-runs safe */
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // ---- resolution + seed + query helpers ---------------------------------------------------

  async function systemAccountId(systemKey: string): Promise<string> {
    const r = await ds.query(`SELECT id FROM account WHERE kind = 'system' AND system_key = $1`, [
      systemKey,
    ]);
    if (!r[0]?.id) throw new Error(`[integration] system account ${systemKey} is not seeded.`);
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

  async function mkCustomer(owner: string, overrides: Record<string, unknown> = {}): Promise<any> {
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

  /** A throwaway system/clearing account with a random, KNOWN `system_key` (cleaned up per-test),
   *  so the large-value proof does not permanently skew the shared seeded clearing account. */
  async function mkSystem(overrides: Record<string, unknown> = {}): Promise<any> {
    const acc = await insertRow(ds, 'account', {
      kind: 'system',
      owner_id: null,
      system_key: `clearing:test-${randomUUID()}`,
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

  async function mkPayee(owner: string, displayName: string): Promise<any> {
    return insertExternalPayee(ds, {
      ownerId: owner,
      displayName,
      rail: outboundRail,
      coolingOffUntil: new Date(Date.now() - 60_000), // already usable
    });
  }

  async function cleanup(ids: string[], owners: string[], admins: string[]): Promise<void> {
    await deleteAuditRowsByActor(ds, admins);
    if (ids.length || owners.length) {
      const txRows = await ds.query(
        `SELECT id FROM "transaction"
           WHERE debit_account_id = ANY($1) OR credit_account_id = ANY($1) OR initiated_by = ANY($2)
         UNION SELECT DISTINCT transaction_id AS id FROM ledger_entry WHERE account_id = ANY($1)
         UNION SELECT DISTINCT transaction_id AS id FROM hold WHERE account_id = ANY($1)`,
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
      await ds.query(`DELETE FROM external_payee WHERE owner_id = ANY($1)`, [owners]);
    }
    if (ids.length) await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
    if (owners.length) await ds.query(`DELETE FROM customer WHERE id = ANY($1)`, [owners]);
  }

  async function acctBalance(id: string): Promise<string> {
    const r = await ds.query(`SELECT balance FROM account WHERE id = $1`, [id]);
    return r[0].balance as string;
  }

  /** The parsed jsonb `outbox_event.payload`(s) for a transaction, oldest-first. */
  async function outboxPayloads(txId: string): Promise<any[]> {
    const rows = await ds.query(
      `SELECT payload FROM outbox_event WHERE transaction_id = $1 ORDER BY created_at ASC, id ASC`,
      [txId],
    );
    return rows.map((r: any) => r.payload);
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

  function idOf(x: any): string {
    return (x?.transaction?.id ??
      x?.id ??
      x?.transactionId ??
      x?.approvalId ??
      x?.approval?.id) as string;
  }

  // ---- payload accessors (camelCase-first, snake_case fallback — see the CASING escalation) ----

  function pick(obj: any, ...names: string[]): any {
    if (obj === null || obj === undefined) return undefined;
    for (const n of names) if (obj[n] !== undefined) return obj[n];
    return undefined;
  }
  function hasKey(obj: any, ...names: string[]): boolean {
    return obj != null && names.some((n) => Object.prototype.hasOwnProperty.call(obj, n));
  }
  function normTx(tx: any) {
    return {
      id: pick(tx, 'id'),
      type: pick(tx, 'type'),
      status: pick(tx, 'status'),
      amount: pick(tx, 'amount'),
      currency: pick(tx, 'currency'),
      initiatedBy: pick(tx, 'initiatedBy', 'initiated_by'),
      reversesTransactionId: pick(tx, 'reversesTransactionId', 'reverses_transaction_id'),
      payee: pick(tx, 'payee'),
      createdAt: pick(tx, 'createdAt', 'created_at'),
      postedAt: pick(tx, 'postedAt', 'posted_at'),
    };
  }
  function normLeg(leg: any) {
    return {
      accountId: pick(leg, 'accountId', 'account_id'),
      ownerId: pick(leg, 'ownerId', 'owner_id'),
      accountKind: pick(leg, 'accountKind', 'account_kind'),
      systemKey: pick(leg, 'systemKey', 'system_key'),
      delta: pick(leg, 'delta'),
      balanceAfter: pick(leg, 'balanceAfter', 'balance_after'),
      currency: pick(leg, 'currency'),
    };
  }
  const rawLegs = (payload: any): any[] => (pick(payload, 'legs') as any[]) ?? [];
  const rawLegFor = (payload: any, accountId: string): any =>
    rawLegs(payload).find((l) => pick(l, 'accountId', 'account_id') === accountId);
  const sumDeltas = (legs: any[]): bigint =>
    legs.reduce((s, l) => s + BigInt(String(pick(l, 'delta'))), 0n);

  function isIso(v: any): boolean {
    return (
      typeof v === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) &&
      !Number.isNaN(Date.parse(v))
    );
  }

  // =========================================================================================
  // (1) per-leg identity + (2) double-entry + (6) header + (7) one outbox — external_inbound
  // touches a CUSTOMER leg AND a SYSTEM/clearing leg, so the two leg KINDS are distinguished.
  // =========================================================================================

  it('external_inbound event carries per-leg identity (customer vs system) with NO Postgres join, preserves double-entry, and has POSTED header + ISO stamps + one outbox row', async () => {
    const actor = newAdmin(); // a system/admin actor drives the inbound
    const owner = newOwner();
    const customer = await mkCustomer(owner, { balance: 0, held: 0 });
    const N = 4000n;

    const result = await posting.postTransaction({
      type: 'external_inbound',
      currency: MXN,
      amount: '4000',
      legs: [
        { accountId: inboundClearingId, delta: '-4000' }, // debit clearing (system leg)
        { accountId: customer.id, delta: '4000' }, //         credit customer (customer leg)
      ],
      initiatedBy: actor,
    });
    const txId = idOf(result);

    // (7) exactly ONE outbox row for the post.
    const payloads = await outboxPayloads(txId);
    expect(payloads).toHaveLength(1);
    const payload = payloads[0];

    // (6) header fields.
    const tx = normTx(pick(payload, 'transaction'));
    expect(tx.status).toBe('POSTED');
    expect(tx.type).toBe('external_inbound');
    expect(tx.initiatedBy).toBe(actor); // the acting sub, echoed onto the event
    expect(tx.currency).toBe(MXN);
    expect(pick(payload, 'schemaVersion', 'schema_version')).toBe(1);
    expect(isIso(pick(payload, 'occurredAt', 'occurred_at'))).toBe(true);
    expect(isIso(tx.createdAt)).toBe(true);
    expect(isIso(tx.postedAt)).toBe(true); // non-null for a posted movement
    // inbound carries no payee, and this is not a reversal.
    expect(tx.payee ?? null).toBeNull();
    expect(
      hasKey(pick(payload, 'transaction'), 'reversesTransactionId', 'reverses_transaction_id'),
    ).toBe(true);
    expect(tx.reversesTransactionId).toBeNull();

    // (2) double-entry: exactly two legs summing to zero.
    const legs = rawLegs(payload);
    expect(legs).toHaveLength(2);
    expect(sumDeltas(legs)).toBe(0n);

    // (1) per-leg identity — the CUSTOMER leg.
    const custRaw = rawLegFor(payload, customer.id);
    expect(custRaw).toBeTruthy();
    const cust = normLeg(custRaw);
    expect(cust.ownerId).toBe(owner); // the customer's sub — a MISSING ownerId (undefined) fails here
    expect(cust.accountKind).toBe('customer');
    expect(cust.systemKey ?? null).toBeNull();
    expect(cust.currency).toBe(MXN);
    expect(BigInt(String(cust.delta))).toBe(N);

    // (1) per-leg identity — the SYSTEM/clearing leg.
    const sysRaw = rawLegFor(payload, inboundClearingId);
    expect(sysRaw).toBeTruthy();
    const sys = normLeg(sysRaw);
    expect(hasKey(sysRaw, 'ownerId', 'owner_id')).toBe(true); // present …
    expect(sys.ownerId).toBeNull(); //                          … and explicitly null for a system account
    expect(sys.accountKind).toBe('system');
    expect(sys.systemKey).toBe('clearing:rail-inbound'); // the clearing key, carried on the event
    expect(BigInt(String(sys.delta))).toBe(-N);

    // (2) balanceAfter on each leg == that account's balance AFTER the post (the running fold).
    expect(String(cust.balanceAfter)).toBe(await acctBalance(customer.id));
    expect(BigInt(String(cust.balanceAfter))).toBe(N); // customer started at 0 → ends at +N
    expect(String(sys.balanceAfter)).toBe(await acctBalance(inboundClearingId));
  }, 45_000);

  // =========================================================================================
  // (3) MONEY-SAFETY KEYSTONE — money is int64-as-STRING; a value past 2^53 round-trips exactly.
  // A Number-based projection would corrupt 9007199254740993 → 9007199254740992 (typeof + value).
  // =========================================================================================

  it('money fields are int64-as-STRING and a value beyond 2^53 round-trips through the event with NO precision loss', async () => {
    const actor = newAdmin();
    const owner = newOwner();
    const customer = await mkCustomer(owner, { balance: 0, held: 0 });
    const clearing = await mkSystem(); // throwaway (so we do not skew the shared seeded clearing by ~9e15)
    const BIG = '9007199254740993'; // 2^53 + 1 — NOT representable as an exact JS number
    const NEG_BIG = '-9007199254740993';

    const result = await posting.postTransaction({
      type: 'external_inbound',
      currency: MXN,
      amount: BIG,
      legs: [
        { accountId: clearing.id, delta: NEG_BIG },
        { accountId: customer.id, delta: BIG },
      ],
      initiatedBy: actor,
    });
    const payloads = await outboxPayloads(idOf(result));
    expect(payloads).toHaveLength(1);
    const payload = payloads[0];
    const tx = normTx(pick(payload, 'transaction'));

    // amount: a STRING, EXACTLY the large value (a Number would already read back as ...992).
    expect(typeof tx.amount).toBe('string');
    expect(tx.amount).toBe(BIG);
    expect(BigInt(tx.amount as string)).toBe(9007199254740993n);

    const cust = normLeg(rawLegFor(payload, customer.id));
    const sys = normLeg(rawLegFor(payload, clearing.id));

    // Every money field on the legs is a STRING …
    for (const v of [cust.delta, cust.balanceAfter, sys.delta, sys.balanceAfter]) {
      expect(typeof v).toBe('string');
    }
    // … and exact past 2^53 (the customer started at 0 → balanceAfter == +BIG).
    expect(cust.delta).toBe(BIG);
    expect(cust.balanceAfter).toBe(BIG);
    expect(sys.delta).toBe(NEG_BIG);
    expect(BigInt(cust.delta as string)).toBe(9007199254740993n);
    expect(BigInt(cust.balanceAfter as string)).toBe(9007199254740993n);
    expect(sumDeltas(rawLegs(payload))).toBe(0n);
  }, 45_000);

  // =========================================================================================
  // (4a) internal transfer → payee: null, and BOTH legs are CUSTOMER legs carrying each owner sub.
  // =========================================================================================

  it('internal transfer emits payee:null and both legs as CUSTOMER legs carrying each owner sub (no system leg)', async () => {
    const ownerA = newOwner();
    const ownerB = newOwner();
    const a = await mkCustomer(ownerA, { balance: 5000, held: 0 });
    const b = await mkCustomer(ownerB, { balance: 0, held: 0 });

    const result = await posting.postTransaction({
      type: 'internal',
      currency: MXN,
      amount: '2000',
      legs: [
        { accountId: a.id, delta: '-2000' },
        { accountId: b.id, delta: '2000' },
      ],
      initiatedBy: ownerA,
    });
    const payloads = await outboxPayloads(idOf(result));
    expect(payloads).toHaveLength(1);
    const payload = payloads[0];
    const tx = normTx(pick(payload, 'transaction'));

    expect(tx.type).toBe('internal');
    expect(tx.status).toBe('POSTED');
    expect(tx.initiatedBy).toBe(ownerA);
    expect(tx.payee ?? null).toBeNull(); // an internal transfer has NO external payee
    expect(tx.reversesTransactionId).toBeNull();

    const legA = normLeg(rawLegFor(payload, a.id));
    const legB = normLeg(rawLegFor(payload, b.id));
    expect(legA.ownerId).toBe(ownerA);
    expect(legB.ownerId).toBe(ownerB);
    expect(legA.accountKind).toBe('customer');
    expect(legB.accountKind).toBe('customer');
    expect(legA.systemKey ?? null).toBeNull();
    expect(legB.systemKey ?? null).toBeNull();
    expect(sumDeltas(rawLegs(payload))).toBe(0n);
    // balanceAfter == each account's post-balance (A: 5000−2000=3000, B: 0+2000=2000).
    expect(String(legA.balanceAfter)).toBe(await acctBalance(a.id));
    expect(String(legB.balanceAfter)).toBe(await acctBalance(b.id));
    expect(BigInt(String(legA.balanceAfter))).toBe(3000n);
    expect(BigInt(String(legB.balanceAfter))).toBe(2000n);
  }, 45_000);

  // =========================================================================================
  // (4b) external_outbound (full initiate → OTP → confirm flow) → payee SNAPSHOT {id,displayName,rail}.
  // Driven through the real transfers flow because THAT is what carries the payee association the
  // enrichment reads (asserting the observable payload, not an internal snapshot-helper name).
  // =========================================================================================

  it('external_outbound event carries the payee snapshot {id, displayName, rail} matching the enrolled payee', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 10000, held: 0 });
    const payee = await mkPayee(owner, 'Acme Payments');
    const KEY = `key-${randomUUID()}`;

    const initiated = await transfers.initiateExternalTransfer({
      ownerId: owner,
      sub: owner,
      sourceAccountId: src.id,
      payeeId: payee.id,
      amount: '4000',
      currency: MXN,
      idempotencyKey: KEY,
      key: KEY,
    });
    const transferId = idOf(initiated);
    expect(typeof transferId).toBe('string');

    const code = await generateOtp(owner);
    await transfers.confirmTransfer({
      ownerId: owner,
      sub: owner,
      transferId,
      id: transferId,
      transactionId: transferId,
      code,
    });

    const payloads = await outboxPayloads(transferId);
    expect(payloads).toHaveLength(1); // (7) exactly one event for the settled outbound movement
    const payload = payloads[0];
    const tx = normTx(pick(payload, 'transaction'));

    expect(tx.type).toBe('external_outbound');
    expect(tx.status).toBe('POSTED');
    const snap = tx.payee;
    expect(snap).toBeTruthy();
    expect(pick(snap, 'id')).toBe(payee.id);
    expect(pick(snap, 'displayName', 'display_name')).toBe('Acme Payments');
    expect(pick(snap, 'rail')).toBe(outboundRail);

    // The double-entry still holds on the event, and the clearing leg names the outbound clearing key.
    const legs = rawLegs(payload);
    expect(legs).toHaveLength(2);
    expect(sumDeltas(legs)).toBe(0n);
    const sysLeg = normLeg(rawLegFor(payload, outboundClearingId));
    expect(sysLeg.accountKind).toBe('system');
    expect(sysLeg.systemKey).toBe(`clearing:${outboundRail}`);
    const custLeg = normLeg(rawLegFor(payload, src.id));
    expect(custLeg.accountKind).toBe('customer');
    expect(custLeg.ownerId).toBe(owner);
  }, 60_000);

  // WHY the "unresolvable payee at settle → payee:null degradation" path is NOT integration-tested
  // (testing discipline: "if a meaningful test can't be written, say why"). `loadPayeeSnapshot`'s
  // null-fallback is DEFENSIVE-ONLY here: the DB FK `fk_tx_payee` (transaction.payee_id →
  // external_payee.id) makes a valid external_outbound transaction's payee ALWAYS resolvable — the
  // payee row cannot be orphaned/deleted while a transaction references it (attempting the delete
  // raises 23503). So the "payee id set but unresolvable at confirm" state is UNREACHABLE in
  // production; the fallback is reached only when `payeeId` itself is null (internal / inbound /
  // reversal), which the payee:null assertions above (internal) and in the inbound/reversal proofs
  // already cover. A DB-backed degradation test is therefore un-constructible, not merely omitted.

  // =========================================================================================
  // (5) REVERSAL linkage — a maker-checker reversal emits a POSTED compensating event linked via
  // reversesTransactionId (link-only: no separate 'reversed' event, balanced legs).
  // =========================================================================================

  it('a maker-checker reversal emits a POSTED compensating event linked via reversesTransactionId, with balanced legs and exactly one outbox row (link-only)', async () => {
    // Seed the POST-transfer state of a POSTED internal A→B (the reversible target).
    const sender = newOwner();
    const beneficiary = newOwner();
    const a = await mkCustomer(sender, { balance: 6000, held: 0 }); // already debited
    const b = await mkCustomer(beneficiary, { balance: 4000, held: 0 }); // already credited
    const original = await insertTransaction(ds, {
      type: 'internal',
      status: 'POSTED',
      initiatedBy: sender,
      debitAccountId: a.id,
      creditAccountId: b.id,
      amount: '4000',
      currency: MXN,
      postedAt: new Date(),
    });

    const maker = newAdmin();
    const checker = newAdmin();
    const proposal = await approvals.proposeReversal(maker, original.id);
    await approvals.approve(checker, idOf(proposal));

    // Exactly one compensating tx links to the original …
    const comp = await getReversalTxsFor(ds, original.id);
    expect(comp).toHaveLength(1);
    const compId = comp[0].id;

    // … and it emits exactly one enriched event, POSTED, linked, sum-zero.
    const payloads = await outboxPayloads(compId);
    expect(payloads).toHaveLength(1); // (7) one event for the compensating post (no double-emit)
    const payload = payloads[0];
    const tx = normTx(pick(payload, 'transaction'));

    expect(tx.id).toBe(compId);
    expect(tx.status).toBe('POSTED'); // the compensating post is itself a POSTED movement
    expect(tx.reversesTransactionId).toBe(original.id); // link-only to the original

    const legs = rawLegs(payload);
    expect(legs).toHaveLength(2);
    expect(sumDeltas(legs)).toBe(0n); // mirrored legs — no money created or lost on the event

    // Link-only: the ORIGINAL (retained) transaction did NOT get a second/separate event.
    // (It was seeded directly with no outbox; the reversal produced ONE event — the compensating one.)
    expect(await outboxPayloads(original.id)).toHaveLength(0);
  }, 60_000);

  // =========================================================================================
  // WIRE-KEY NAMING CONTRACT (task-directed camelCase). Isolated so a snake_case emission fails
  // HERE (one attributable naming failure) rather than reddening the value proofs above. See the
  // CASING escalation in the header / the test-writer report.
  // =========================================================================================

  it('the emitted payload uses the camelCase wire-contract keys (schemaVersion/occurredAt/transaction.*/legs[].*)', async () => {
    const actor = newAdmin();
    const owner = newOwner();
    const customer = await mkCustomer(owner, { balance: 0, held: 0 });

    const result = await posting.postTransaction({
      type: 'external_inbound',
      currency: MXN,
      amount: '4000',
      legs: [
        { accountId: inboundClearingId, delta: '-4000' },
        { accountId: customer.id, delta: '4000' },
      ],
      initiatedBy: actor,
    });
    const payload = (await outboxPayloads(idOf(result)))[0];
    expect(payload).toBeTruthy();

    for (const k of ['schemaVersion', 'occurredAt', 'transaction', 'legs']) {
      expect(Object.prototype.hasOwnProperty.call(payload, k)).toBe(true);
    }
    const tx = payload.transaction;
    for (const k of [
      'id',
      'type',
      'status',
      'amount',
      'currency',
      'initiatedBy',
      'reversesTransactionId',
      'payee',
      'createdAt',
      'postedAt',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(tx, k)).toBe(true);
    }
    for (const leg of payload.legs as any[]) {
      for (const k of [
        'accountId',
        'ownerId',
        'accountKind',
        'systemKey',
        'delta',
        'balanceAfter',
        'currency',
      ]) {
        expect(Object.prototype.hasOwnProperty.call(leg, k)).toBe(true);
      }
    }
  }, 45_000);
});
