/**
 * Spec 04 — Balance Service, STEP 7: LIMITS ENFORCEMENT, money-safety proofs driven against the
 * REAL DI'd services (TransfersService, RailsService, PostingService — resolved BY TOKEN through a
 * booted AppModule) with real Postgres + real Redis. Written FROM the spec's "Limits" module bullet
 * + the new DoD checkbox + the developer-locked contract, NOT from the implementor's code:
 *
 *   - Limits are enforced ONLY on customer-initiated outbound (internal transfer out here) at
 *     CONFIRM/post time, under the debited account's `FOR UPDATE` lock: a breach → `LIMIT_EXCEEDED`
 *     (422), BEFORE any balance mutation, checked per-transaction → daily → monthly.
 *   - The per-account counters `spent_today`/`spent_month` increment ATOMICALLY with the post; the
 *     boundary is `<=` (a spend landing exactly ON the cap succeeds).
 *   - Windows reset LAZILY off the DB clock (UTC calendar): a `spent_*_date` behind the boundary
 *     zeroes its counter before the add.
 *   - Resolution is customer-override-wins: a `customer`-scope `user_limits` row beats the seeded
 *     `global` baseline; with no customer row the global baseline governs.
 *   - Inbound credits and rail-failure reversals do NOT touch the counters (outbound-only; a reversal
 *     does not give the slot back).
 *   - CONCURRENCY keystone (reducer level): N simultaneous limit-bearing debits on ONE account never
 *     let `spent_today` exceed the cap and never double-count — the lock serializes check+increment.
 *
 * Why DB+Redis-backed and not mocked: these invariants (the check+increment serialized by the row
 * lock, the DB-clock window reset, "no balance moved on a breach", reconcile after counter writes)
 * are properties of REAL transactions — mocking them would mock away the logic under test. Every
 * assertion gates on OBSERVABLE STATE (balances, spend counters + their date columns, ledger legs,
 * tx status), never on the error kind alone.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a false
 * pass). beforeAll TCP-probes BOTH Postgres and Redis and fails loud if unreachable; boots the real
 * AppModule (migrationsRun:true → MXN + clearing accounts + the seeded global limits baseline).
 * jest.config.ts serializes the integration run (maxWorkers:1). Unique account/owner ids per test;
 * committed rows (incl. user_limits) + minted OTP/confirmation keys cleaned up per-test.
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
  getPostingServiceToken,
  getRailsServiceToken,
  getGenerateAccountNumber,
  getOutboundRail,
  getDomainErrors,
  tcpProbe,
} from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import * as pg from '../support/pg';
const {
  insertRow,
  insertCustomer,
  insertTransaction,
  insertHold,
  insertLedgerEntry,
  insertUserLimits,
  getAccountCounters,
  setAccountSpendCounters,
  localAccountNumber,
  TODAY,
  MONTH_START,
} = pg;

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED limits suite: set BALANCE_INTEGRATION=1 (and point DB_* at Postgres AND ' +
      'REDIS_* at Redis — the confirm/settle path needs both) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789';
const MXN = 'MXN';

const genAccountNumber = getGenerateAccountNumber() ?? localAccountNumber;

// The rails settlement-callback status literal (developer-locked lowercase; see rails-webhooks spec).
const STATUS_FAILURE = 'failure';
const SETTLE_METHODS = [
  'settleOutbound',
  'handleSettlementCallback',
  'settlementCallback',
  'settle',
];
const INBOUND_METHODS = ['handleInbound', 'processInbound', 'creditInbound', 'inbound'];

const suite = ENABLED ? describe : describe.skip;

suite('limits enforcement — DoD money-safety proofs (integration, needs Postgres + Redis)', () => {
  let app: INestApplication;
  let ds: any;
  let transfers: any;
  let posting: any;
  let rails: any;
  let settleMethod: string;
  let inboundMethod: string;
  let otp: any;
  let redis: any;
  let outboundClearingId: string;
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
    if (!ds) throw new Error('[integration] could not resolve the TypeORM DataSource from the app');

    transfers = app.get(getTransfersServiceToken(), { strict: false });
    if (!transfers || typeof transfers.initiateTransfer !== 'function') {
      throw new Error(
        '[integration] resolved the transfers service but it lacks initiateTransfer.',
      );
    }
    posting = app.get(getPostingServiceToken(), { strict: false });
    if (!posting || typeof posting.postTransaction !== 'function') {
      throw new Error('[integration] resolved the posting service but it lacks postTransaction.');
    }
    rails = app.get(getRailsServiceToken(), { strict: false });
    settleMethod = pickMethod(rails, SETTLE_METHODS) as string;
    inboundMethod = pickMethod(rails, INBOUND_METHODS) as string;
    if (!settleMethod || !inboundMethod) {
      throw new Error(
        `[integration] RailsService is missing a settlement/inbound handler (tried ${SETTLE_METHODS.join(
          '/',
        )} and ${INBOUND_METHODS.join('/')}).`,
      );
    }
    otp = app.get(getOtpServiceToken(), { strict: false });
    if (!otp || typeof otp.generate !== 'function') {
      throw new Error('[integration] resolved the OTP service but it has no generate(userId).');
    }
    redis = app.get(getRedisClientToken(), { strict: false });
    if (!redis || typeof redis.del !== 'function') {
      throw new Error('[integration] could not resolve a usable ioredis client via REDIS_CLIENT.');
    }

    outboundClearingId = await systemAccountId(`clearing:${getOutboundRail()}`);

    for (const fn of ['insertUserLimits', 'getAccountCounters', 'setAccountSpendCounters']) {
      if (typeof (pg as any)[fn] !== 'function') {
        throw new Error(`[integration] pg.${fn} is missing — reconcile tests/support/pg.ts.`);
      }
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

  // ---- resolution + seed + query helpers ------------------------------------------------

  function pickMethod(obj: any, names: string[]): string | undefined {
    for (const n of names) if (typeof obj?.[n] === 'function') return n;
    return undefined;
  }

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

  async function mkCustomer(owner: string, overrides: Record<string, unknown> = {}): Promise<any> {
    const { account_number: numberOverride, ...accountOverrides } = overrides as any;
    await insertCustomer(ds, owner);
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

  /** A customer-scope `user_limits` override for `owner` (MXN). Caps are minor-unit strings. */
  async function setCustomerLimits(
    owner: string,
    caps: { perTransactionMax?: string; dailyMax?: string; monthlyMax?: string },
  ): Promise<void> {
    await insertUserLimits(ds, {
      scope: 'customer',
      ownerId: owner,
      currency: MXN,
      perTransactionMax: caps.perTransactionMax ?? null,
      dailyMax: caps.dailyMax ?? null,
      monthlyMax: caps.monthlyMax ?? null,
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
      await ds.query(`DELETE FROM user_limits WHERE owner_id = ANY($1)`, [owners]);
    }
    if (ids.length) await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
    if (owners.length) await ds.query(`DELETE FROM customer WHERE id = ANY($1)`, [owners]);
  }

  async function acct(id: string): Promise<{ balance: string; held: string; status: string }> {
    const r = await ds.query(`SELECT balance, held, status FROM account WHERE id = $1`, [id]);
    return r[0];
  }

  async function counters(id: string): Promise<pg.AccountCounters> {
    const c = await getAccountCounters(ds, id);
    if (!c) throw new Error(`[integration] account ${id} not found for counters read`);
    return c;
  }

  /** The DB clock's authoritative UTC calendar window — what a correct lazy reset stamps. */
  async function dbWindow(): Promise<{ today: string; monthStart: string }> {
    const r = await ds.query(
      `SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS today,
              to_char(date_trunc('month', now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS month_start`,
    );
    return { today: r[0].today, monthStart: r[0].month_start };
  }

  async function legsForTx(txId: string): Promise<Array<{ account_id: string; delta: string }>> {
    return ds.query(`SELECT account_id, delta FROM ledger_entry WHERE transaction_id = $1`, [txId]);
  }

  async function txStatus(txId: string): Promise<string | undefined> {
    const r = await ds.query(`SELECT status FROM "transaction" WHERE id = $1`, [txId]);
    return r[0]?.status;
  }

  async function sumLedger(accountId: string): Promise<bigint> {
    const r = await ds.query(
      `SELECT COALESCE(SUM(delta), 0)::text AS s FROM ledger_entry WHERE account_id = $1`,
      [accountId],
    );
    return BigInt(r[0].s);
  }

  async function sumPlaced(accountId: string): Promise<bigint> {
    const r = await ds.query(
      `SELECT COALESCE(SUM(amount), 0)::text AS s FROM hold WHERE account_id = $1 AND status = 'PLACED'`,
      [accountId],
    );
    return BigInt(r[0].s);
  }

  // ---- service adapters -----------------------------------------------------------------

  function idOf(r: any): string {
    return (r?.transaction?.id ?? r?.id ?? r?.transactionId ?? r?.transferId) as string;
  }
  function statusOf(r: any): string | undefined {
    return r?.transaction?.status ?? r?.status;
  }

  async function resolveDest(owner: string, accountNumber: string): Promise<string> {
    const r = await transfers.resolveDestination({ ownerId: owner, sub: owner, accountNumber });
    if (r?.confirmationToken) trackedRedisKeys.push(`xfer:confirm:${owner}:${r.confirmationToken}`);
    return r.confirmationToken;
  }

  /** resolve → initiate an internal transfer; returns the created (PENDING) transfer. */
  async function initiate(owner: string, sourceId: string, dst: any, amount: number): Promise<any> {
    const token = await resolveDest(owner, dst.account_number);
    const k = `key-${randomUUID()}`;
    return transfers.initiateTransfer({
      ownerId: owner,
      sub: owner,
      sourceAccountId: sourceId,
      destinationAccountNumber: dst.account_number,
      amount: String(amount),
      currency: MXN,
      idempotencyKey: k,
      key: k,
      confirmationToken: token,
    });
  }

  async function confirm(owner: string, transferId: string, code: string): Promise<any> {
    return transfers.confirmTransfer({
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
    trackedRedisKeys.push(`otp:${owner}`);
    trackedRedisKeys.push(
      `otp:${owner}:${createHmac('sha256', OTP_HASH_SECRET).update(`${owner}:${code}`).digest('hex')}`,
    );
    return code;
  }

  /** resolve → initiate → generate OTP → confirm. Returns { ok, transferId, value?, error? }. */
  async function transfer(
    owner: string,
    sourceId: string,
    dst: any,
    amount: number,
  ): Promise<{ ok: boolean; transferId: string; value?: any; error?: any }> {
    const initiated = await initiate(owner, sourceId, dst, amount);
    const transferId = idOf(initiated);
    const code = await generateOtp(owner);
    try {
      const value = await confirm(owner, transferId, code);
      return { ok: true, transferId, value };
    } catch (error) {
      return { ok: false, transferId, error };
    }
  }

  async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
    try {
      return { ok: true, value: await p };
    } catch (error) {
      return { ok: false, error };
    }
  }

  function codeOf(err: any): string {
    const d = domainErrors;
    if (d.LimitExceededError && err instanceof d.LimitExceededError) return 'LIMIT_EXCEEDED';
    if (d.InsufficientFundsError && err instanceof d.InsufficientFundsError)
      return 'INSUFFICIENT_FUNDS';
    return (err?.code ?? err?.errorCode ?? '') as string;
  }

  const ref = () => `rail-ref-${randomUUID()}`;

  // =========================================================================================
  // PROOF 1 — per-transaction cap
  // =========================================================================================

  it('rejects a customer transfer ABOVE per_transaction_max with LIMIT_EXCEEDED; balance + counters unchanged', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 100000, held: 0 });
    const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
    await setCustomerLimits(owner, {
      perTransactionMax: '5000',
      dailyMax: '1000000',
      monthlyMax: '10000000',
    });

    const res = await transfer(owner, src.id, dst, 5001); // 5001 > 5000

    expect(res.ok).toBe(false);
    expect(codeOf(res.error)).toBe('LIMIT_EXCEEDED');
    // No money moved, no legs, transfer stays PENDING; the spend counters never advanced.
    expect(await txStatus(res.transferId)).toBe('PENDING');
    expect(await legsForTx(res.transferId)).toHaveLength(0);
    expect((await acct(src.id)).balance).toBe('100000');
    expect((await acct(dst.id)).balance).toBe('0');
    const c = await counters(src.id);
    expect(c.spent_today).toBe('0');
    expect(c.spent_month).toBe('0');
  }, 30_000);

  // =========================================================================================
  // PROOF 2 — daily cap boundary (exactly on → ok; +1 → 422) + PROOF 8 reconciliation
  // =========================================================================================

  it('daily cap: a spend landing exactly ON the cap succeeds (spent_today == cap); one more minor unit → LIMIT_EXCEEDED; reconciles', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 50000, held: 0 });
    const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
    await setCustomerLimits(owner, {
      perTransactionMax: '10000',
      dailyMax: '10000',
      monthlyMax: '10000000',
    });

    // Two posts accumulate to EXACTLY the daily cap (6000 + 4000 == 10000).
    const first = await transfer(owner, src.id, dst, 6000);
    expect(first.ok).toBe(true);
    expect(statusOf(first.value)).toBe('POSTED');
    expect((await counters(src.id)).spent_today).toBe('6000');

    const second = await transfer(owner, src.id, dst, 4000);
    expect(second.ok).toBe(true);
    expect((await counters(src.id)).spent_today).toBe('10000'); // landed exactly ON the cap

    // One more minor unit over the cap is rejected; nothing posts, counter frozen at the cap.
    const over = await transfer(owner, src.id, dst, 1);
    expect(over.ok).toBe(false);
    expect(codeOf(over.error)).toBe('LIMIT_EXCEEDED');
    expect(await txStatus(over.transferId)).toBe('PENDING');
    expect(await legsForTx(over.transferId)).toHaveLength(0);
    expect((await counters(src.id)).spent_today).toBe('10000'); // NOT 10001

    // PROOF 8 — reconciliation is unperturbed by the counter writes: sum(ledger delta) == balance,
    // and there are no stray holds on either account.
    expect((await acct(src.id)).balance).toBe('40000'); // 50000 − 6000 − 4000
    expect(await sumLedger(src.id)).toBe(-10000n);
    expect(await sumLedger(src.id)).toBe(BigInt((await acct(src.id)).balance) - 50000n);
    expect(await sumLedger(dst.id)).toBe(BigInt((await acct(dst.id)).balance));
    expect((await acct(src.id)).held).toBe('0');
    expect(await sumPlaced(src.id)).toBe(0n);
  }, 60_000);

  // =========================================================================================
  // PROOF 3 — monthly cap boundary
  // =========================================================================================

  it('monthly cap: a spend landing exactly ON the monthly cap succeeds (spent_month == cap); one more → LIMIT_EXCEEDED', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 50000, held: 0 });
    const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
    // Daily generous so the DAILY cap never fires first; monthly is the tight one under test.
    await setCustomerLimits(owner, {
      perTransactionMax: '10000',
      dailyMax: '10000000',
      monthlyMax: '10000',
    });

    expect((await transfer(owner, src.id, dst, 6000)).ok).toBe(true);
    expect((await counters(src.id)).spent_month).toBe('6000');
    expect((await transfer(owner, src.id, dst, 4000)).ok).toBe(true);
    expect((await counters(src.id)).spent_month).toBe('10000'); // exactly on the monthly cap

    const over = await transfer(owner, src.id, dst, 1);
    expect(over.ok).toBe(false);
    expect(codeOf(over.error)).toBe('LIMIT_EXCEEDED');
    expect((await counters(src.id)).spent_month).toBe('10000'); // frozen at the cap
    expect(await legsForTx(over.transferId)).toHaveLength(0);
  }, 60_000);

  // =========================================================================================
  // PROOF 4 — lazy window reset off the DB clock (stale date → zero-then-add)
  // =========================================================================================

  it('DAY rollover: a spent_today near the cap with a PRIOR-day date resets to zero-then-add on the next spend (succeeds, date advances)', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 50000, held: 0 });
    const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
    await setCustomerLimits(owner, {
      perTransactionMax: '10000',
      dailyMax: '10000',
      monthlyMax: '10000000',
    });
    // Plant a large stale spent_today from a clearly-prior day (no scheduler ran). Without a reset,
    // 9000 + 5000 = 14000 > 10000 would (wrongly) reject — so a POSTED result proves the reset.
    await setAccountSpendCounters(ds, src.id, { spentToday: '9000', spentTodayDate: '2000-01-01' });

    const res = await transfer(owner, src.id, dst, 5000);
    expect(res.ok).toBe(true);
    expect(statusOf(res.value)).toBe('POSTED');

    const win = await dbWindow();
    const c = await counters(src.id);
    expect(c.spent_today).toBe('5000'); // reset to 0, then + 5000 (NOT 9000 + 5000)
    expect(c.spent_today_date).toBe(win.today); // stamped with the current DB-clock UTC day
  }, 30_000);

  it('MONTH rollover: a spent_month near the cap with a PRIOR-month date resets to zero-then-add on the next spend', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 200000, held: 0 });
    const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
    await setCustomerLimits(owner, {
      perTransactionMax: '100000',
      dailyMax: '10000000',
      monthlyMax: '100000',
    });
    // Stale spent_month from a prior month; spent_today current so DAILY never gates this proof.
    await setAccountSpendCounters(ds, src.id, {
      spentMonth: '90000',
      spentMonthDate: '2000-01-01',
      spentToday: '0',
      spentTodayDate: TODAY,
    });

    const res = await transfer(owner, src.id, dst, 50000);
    expect(res.ok).toBe(true);

    const win = await dbWindow();
    const c = await counters(src.id);
    expect(c.spent_month).toBe('50000'); // reset to 0, then + 50000 (NOT 90000 + 50000)
    expect(c.spent_month_date).toBe(win.monthStart); // stamped with the current month-start
  }, 30_000);

  // =========================================================================================
  // PROOF 5 — resolution: customer override wins; global governs when there is no customer row
  // =========================================================================================

  it('customer override WINS: a spend allowed by the global baseline but denied by a tighter customer row → LIMIT_EXCEEDED', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 100000, held: 0 });
    const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
    // Global per-transaction baseline is 5,000,000; a customer override of 1000 is far tighter.
    await setCustomerLimits(owner, {
      perTransactionMax: '1000',
      dailyMax: '1000000',
      monthlyMax: '10000000',
    });

    // 2000 is comfortably under the GLOBAL per-tx cap (5,000,000) but over the CUSTOMER cap (1000).
    const res = await transfer(owner, src.id, dst, 2000);
    expect(res.ok).toBe(false);
    expect(codeOf(res.error)).toBe('LIMIT_EXCEEDED');
    expect((await counters(src.id)).spent_today).toBe('0');
    expect(await legsForTx(res.transferId)).toHaveLength(0);
  }, 30_000);

  it('with NO customer row the SEEDED GLOBAL baseline governs: above per-tx (5,000,000) → LIMIT_EXCEEDED; below → posts', async () => {
    // Above the global per-transaction cap → rejected.
    const ownerHigh = newOwner();
    const srcHigh = await mkCustomer(ownerHigh, { balance: 6000000, held: 0 });
    const dstHigh = await mkCustomer(newOwner(), { balance: 0, held: 0 });
    const over = await transfer(ownerHigh, srcHigh.id, dstHigh, 5000001); // > 5,000,000
    expect(over.ok).toBe(false);
    expect(codeOf(over.error)).toBe('LIMIT_EXCEEDED');
    expect((await counters(srcHigh.id)).spent_today).toBe('0');

    // Well under every global cap → posts, and the counter advances by the amount.
    const ownerOk = newOwner();
    const srcOk = await mkCustomer(ownerOk, { balance: 500000, held: 0 });
    const dstOk = await mkCustomer(newOwner(), { balance: 0, held: 0 });
    const ok = await transfer(ownerOk, srcOk.id, dstOk, 100000); // < 5,000,000 per-tx / 10,000,000 daily
    expect(ok.ok).toBe(true);
    expect(statusOf(ok.value)).toBe('POSTED');
    expect((await counters(srcOk.id)).spent_today).toBe('100000');
    expect((await acct(srcOk.id)).balance).toBe('400000');
  }, 45_000);

  it('customer override is WHOLESALE, not a field-merge: a NULL per-transaction cap does NOT inherit the global per-tx baseline (a spend above the global per-tx still posts)', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 7000000, held: 0 });
    const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
    // Customer override leaves per-transaction NULL (uncapped) but sets generous day/month caps.
    // The seeded GLOBAL per-tx baseline is 5,000,000 — a FIELD-MERGE would borrow it; WHOLESALE
    // resolution (the customer row wins entirely) leaves per-tx uncapped.
    await setCustomerLimits(owner, { dailyMax: '10000000', monthlyMax: '100000000' });

    // 6,000,000 is ABOVE the global per-tx cap (5,000,000) but within the customer's day/month caps.
    const res = await transfer(owner, src.id, dst, 6000000);
    expect(res.ok).toBe(true);
    expect(statusOf(res.value)).toBe('POSTED');
    // Posting proves the customer's NULL per-tx was NOT merged with the global baseline.
    expect((await counters(src.id)).spent_today).toBe('6000000');
    expect((await acct(src.id)).balance).toBe('1000000');
  }, 45_000);

  // =========================================================================================
  // PROOF 6 — outbound-only: inbound credits and rail-failure reversals do NOT touch the counters
  // =========================================================================================

  it('an INBOUND credit does NOT touch the spend counters (they stay exactly as they were)', async () => {
    const owner = newOwner();
    const cust = await mkCustomer(owner, { balance: 0, held: 0 });
    // Pre-set non-zero counters so "unchanged" is a real assertion (not the vacuous 0 == 0).
    await setAccountSpendCounters(ds, cust.id, {
      spentToday: '5000',
      spentTodayDate: TODAY,
      spentMonth: '5000',
      spentMonthDate: MONTH_START,
    });

    const res = await capture(
      rails[inboundMethod]({
        accountNumber: cust.account_number,
        amount: '2500',
        currency: MXN,
        externalRef: ref(),
      }),
    );
    expect(res.ok).toBe(true);

    // The credit landed (balance += amount) but the OUTBOUND spend counters are untouched.
    expect(BigInt((await acct(cust.id)).balance)).toBe(2500n);
    const c = await counters(cust.id);
    expect(c.spent_today).toBe('5000');
    expect(c.spent_month).toBe('5000');
  }, 30_000);

  it('a rail-FAILURE reversal refunds the balance but does NOT give the spend slot back (counters unchanged)', async () => {
    const owner = newOwner();
    const AMOUNT = 4000;
    // Seed the state a 5b OTP-confirm leaves: customer already debited AMOUNT, hold SETTLED, a POSTED
    // external_outbound (customer → clearing), and the two original legs — plus a spend counter that
    // was incremented by AMOUNT at confirm (the slot the fixed window is now holding).
    const debited = 10000 - AMOUNT;
    const src = await mkCustomer(owner, { balance: debited, held: 0 });
    await setAccountSpendCounters(ds, src.id, {
      spentToday: String(AMOUNT),
      spentTodayDate: TODAY,
      spentMonth: String(AMOUNT),
      spentMonthDate: MONTH_START,
    });
    const tx = await insertTransaction(ds, {
      type: 'external_outbound',
      status: 'POSTED',
      initiatedBy: owner,
      debitAccountId: src.id,
      creditAccountId: outboundClearingId,
      amount: String(AMOUNT),
      currency: MXN,
      postedAt: new Date(),
    });
    await insertHold(ds, {
      accountId: src.id,
      transactionId: tx.id,
      amount: AMOUNT,
      status: 'SETTLED',
      rail: getOutboundRail(),
      settledAt: new Date(),
    });
    const clearingBalRows = await ds.query(`SELECT balance FROM account WHERE id = $1`, [
      outboundClearingId,
    ]);
    await insertLedgerEntry(ds, {
      transaction_id: tx.id,
      account_id: src.id,
      delta: -AMOUNT,
      balance_after: debited,
      currency: MXN,
    });
    await insertLedgerEntry(ds, {
      transaction_id: tx.id,
      account_id: outboundClearingId,
      delta: AMOUNT,
      balance_after: clearingBalRows[0].balance,
      currency: MXN,
    });

    const res = await capture(
      rails[settleMethod]({ transactionId: tx.id, status: STATUS_FAILURE, externalRef: ref() }),
    );
    expect(res.ok).toBe(true);

    // The payer is refunded (balance += AMOUNT) and the original is REVERSED ...
    expect(BigInt((await acct(src.id)).balance)).toBe(BigInt(debited) + BigInt(AMOUNT));
    expect(await txStatus(tx.id)).toBe('REVERSED');
    // ... but the spend counters are UNCHANGED — the fixed window keeps the slot until it resets.
    const c = await counters(src.id);
    expect(c.spent_today).toBe(String(AMOUNT));
    expect(c.spent_month).toBe(String(AMOUNT));
  }, 30_000);

  // =========================================================================================
  // PROOF 7 — CONCURRENCY KEYSTONE (reducer level): the FOR UPDATE lock serializes check+increment
  // =========================================================================================

  /** A limit-bearing internal command debiting `src` (customer, limit-enforced) and crediting `dst`. */
  function limitBearing(src: any, dst: any, owner: string, amount: number): any {
    return {
      type: 'internal',
      currency: MXN,
      amount: String(amount),
      legs: [
        { accountId: src.id, delta: String(-amount) },
        { accountId: dst.id, delta: String(amount) },
      ],
      initiatedBy: owner,
      limitAccountId: src.id,
    };
  }

  it('two SIMULTANEOUS limit-bearing debits that BOTH fit the daily cap → both post, spent_today == the sum (no lost update)', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 1000000, held: 0 });
    const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
    // Daily cap 10000, per-tx 10000. Two 3000 debits: each fits per-tx, and 3000+3000=6000 <= 10000.
    await setCustomerLimits(owner, {
      perTransactionMax: '10000',
      dailyMax: '10000',
      monthlyMax: '10000000',
    });

    const outcomes = await Promise.allSettled([
      posting.postTransaction(limitBearing(src, dst, owner, 3000)),
      posting.postTransaction(limitBearing(src, dst, owner, 3000)),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);

    // No lost update: the two increments are serialized by the lock → spent_today == 6000 (never 3000).
    expect((await counters(src.id)).spent_today).toBe('6000');
    expect((await acct(src.id)).balance).toBe(String(1000000 - 6000));
    expect(await sumLedger(src.id)).toBe(-6000n);
  }, 45_000);

  it('two SIMULTANEOUS limit-bearing debits where only ONE fits the daily cap → exactly one posts, the other LIMIT_EXCEEDED, spent_today == the winner (never exceeds the cap, never double-counts)', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 1000000, held: 0 });
    const dst = await mkCustomer(newOwner(), { balance: 0, held: 0 });
    // Daily cap 5000, per-tx 5000. Two 3000 debits: each fits per-tx AND fits daily alone (3000<=5000),
    // but together 6000 > 5000 — so exactly ONE may post. This is the double-spend tripwire.
    await setCustomerLimits(owner, {
      perTransactionMax: '5000',
      dailyMax: '5000',
      monthlyMax: '10000000',
    });

    const outcomes = await Promise.allSettled([
      posting.postTransaction(limitBearing(src, dst, owner, 3000)),
      posting.postTransaction(limitBearing(src, dst, owner, 3000)),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1); // exactly one winner
    expect(rejected).toHaveLength(1);
    expect(codeOf(rejected[0].reason)).toBe('LIMIT_EXCEEDED'); // the loser hit the daily cap

    // spent_today is EXACTLY the winner's amount — never 6000 (double-count), never over the cap.
    expect((await counters(src.id)).spent_today).toBe('3000');
    expect((await acct(src.id)).balance).toBe(String(1000000 - 3000)); // debited once
    expect(await sumLedger(src.id)).toBe(-3000n);
  }, 45_000);
});
