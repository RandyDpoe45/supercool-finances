/**
 * Spec 04 — Balance Service DOMAIN layer, STEP 2: the `postTransaction` atomic reducer.
 * The money-safety keystone. Written FROM the spec (Ledger + Transfers→Concurrency modules)
 * and the Definition of Done (concurrency / no-double-spend / no-overdraft / no-money-
 * created-or-lost; reconciliation `sum(ledger delta) == account.balance` and internal
 * accounts net to 0), plus ADR-13 (the reducer: `balance_after = balance_before + delta`
 * under a `FOR UPDATE` row lock, one DB transaction) and ADR-14 (`available = balance −
 * held`). NOT written from the implementor's code — the reducer is resolved through the
 * single harness seam (`getPostingService`), the same coordination point every other test
 * imports through.
 *
 * Contract under test (spec-derived):
 *   postTransaction(command): Promise<Transaction>, one DB transaction, where
 *   command = { type, currency, amount, legs: [{accountId, delta}], initiatedBy, payeeId?,
 *   reversesTransactionId? }; `delta` is a signed bigint-minor-unit STRING; legs sum to zero.
 *   It locks the affected accounts FOR UPDATE in canonical order, funds-checks CUSTOMER
 *   debits against available = balance − held, folds balance += delta, appends the double-
 *   entry LedgerEntry rows (each carrying balance_after = the account's new balance), writes
 *   the Transaction header (status POSTED, posted_at set) and exactly ONE OutboxEvent
 *   (published_at NULL) — all atomically. A customer debit on a FROZEN account is rejected.
 *   SYSTEM/clearing accounts (kind='system') are EXEMPT from the funds and frozen checks
 *   (they may go negative). On ANY rejection the whole transaction rolls back — no partial
 *   writes.
 *
 * Why these are DB-backed and not mocked: the invariants this step exists to guarantee
 * (atomic rollback, FOR UPDATE serialization under contention, the balance/ledger fold, the
 * one-outbox-per-tx rule) are properties of a REAL transaction against a REAL Postgres.
 * Mocking the repositories/DataSource would mock away the very logic under test, so the
 * suite drives the real DI'd reducer (app.get) against the compose Postgres.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never
 * a false pass); beforeAll TCP-probes Postgres and fails loud if unreachable; boots the real
 * AppModule (migrationsRun:true → MXN + the two clearing accounts). Rows are COMMITTED (the
 * reducer uses its own connection/transaction, so a rolled-back QueryRunner wrapper cannot
 * hold them) and cleaned up per-test by a FK-safe cascade keyed on the test's account ids.
 * jest.config.ts forces maxWorkers:1 for the integration run, so within one test the global
 * row counts are stable — that is what makes the "nothing written" count-delta assertion a
 * sound atomic-rollback proof.
 *
 * NOT tested here — the `40P01` deadlock-retry path (deliberate; testing discipline "if a
 * meaningful test can't be written, say why"): the reducer locks accounts in canonical
 * ASCENDING id order, so two `postTransaction` calls touching the same accounts always
 * acquire the same locks in the same order — a lock-ordering deadlock between them is not
 * inducible through the public API, and the concurrency proof below (all posts A→B) confirms
 * they cleanly serialize rather than deadlock. The `isDeadlock`/retry-bound helper is
 * module-private (not exported), so it is not unit-tested either (that would require a
 * production change, which is out of scope for the test writer).
 *
 * To run:
 *   1. bring up the compose datastores (Postgres reachable to the test runner);
 *   2. BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=…] npm test
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { getAppModule, getPostingService, getDomainErrors, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import { insertRow, TODAY, MONTH_START } from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED post-transaction suite: set BALANCE_INTEGRATION=1 (and point ' +
      'DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME at a reachable Postgres) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const MXN = 'MXN';

const suite = ENABLED ? describe : describe.skip;

suite('postTransaction — the atomic reducer (integration, needs Postgres)', () => {
  let app: INestApplication;
  let ds: any;
  let posting: any;
  let domainErrors: ReturnType<typeof getDomainErrors>;

  // Every account a test creates (customer AND system) is tracked here; afterEach removes
  // them and everything that hangs off them (ledger/hold/outbox/transaction) in FK-safe
  // order, so the suite is idempotent and re-runnable even after an EXPECTED rejection may
  // (defectively) have left a partial write behind.
  let createdAccountIds: string[] = [];
  // Extra teardown that must run AFTER the account cascade (e.g. a throwaway currency row an
  // account FK-referenced).
  let extraCleanups: Array<() => Promise<unknown>> = [];

  beforeAll(async () => {
    const reachable = await tcpProbe(DB_HOST, DB_PORT);
    if (!reachable) {
      throw new Error(
        `[integration] BALANCE_INTEGRATION=1 but Postgres is not reachable at ` +
          `${DB_HOST}:${DB_PORT}. Bring up the compose datastores (and publish/point ` +
          `DB_HOST/DB_PORT at them) or unset BALANCE_INTEGRATION.`,
      );
    }

    const env = completeRawEnv({
      DB_HOST,
      DB_PORT: String(DB_PORT),
      DB_NAME: process.env.DB_NAME || 'balance',
      DB_USER: process.env.DB_USER || 'balance_app',
      DB_PASSWORD: process.env.DB_PASSWORD || 'changeme-balance-local',
      REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
      REDIS_PORT: process.env.REDIS_PORT || '6379',
      REDIS_PASSWORD: process.env.REDIS_PASSWORD || 'changeme-redis-local',
      INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-service-token',
    });
    for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

    const AppModule = getAppModule();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // runs migrations on boot: MXN + the two clearing accounts

    try {
      const { DataSource } = require('typeorm');
      ds = app.get(DataSource);
    } catch {
      const { getDataSourceToken } = require('@nestjs/typeorm');
      ds = app.get(getDataSourceToken());
    }
    if (!ds) throw new Error('[integration] could not resolve the TypeORM DataSource from the app');

    const PostingService = getPostingService();
    posting = app.get(PostingService, { strict: false });
    if (!posting || typeof posting.postTransaction !== 'function') {
      throw new Error(
        '[integration] resolved the posting service but it has no `postTransaction(command)` ' +
          'method. If the reducer entry point is named differently, update the seam ' +
          '(tests/support/harness.ts:getPostingService) / coordinate the contract.',
      );
    }
    domainErrors = getDomainErrors();
  }, 60_000);

  afterEach(async () => {
    const ids = createdAccountIds;
    createdAccountIds = [];
    const extras = extraCleanups;
    extraCleanups = [];
    try {
      await cleanupAccounts(ids);
    } catch {
      /* best-effort; random ids keep re-runs safe even if one cleanup fails */
    }
    for (const c of extras) {
      try {
        await c();
      } catch {
        /* best-effort */
      }
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // ---- seed + query helpers (committed rows) --------------------------------------------

  async function mkCustomer(overrides: Record<string, unknown> = {}): Promise<any> {
    const acc = await insertRow(ds, 'account', {
      kind: 'customer',
      owner_id: `sub-${randomUUID()}`,
      currency: MXN,
      status: 'active',
      spent_today_date: TODAY,
      spent_month_date: MONTH_START,
      ...overrides,
    });
    createdAccountIds.push(acc.id);
    return acc;
  }

  /** A throwaway system/clearing account with a random `system_key` so it never collides with
   *  the migration-seeded clearing accounts and can be deleted per-test like any other row.
   *  The exemption under test keys on kind='system', so this faithfully exercises it. */
  async function mkSystem(overrides: Record<string, unknown> = {}): Promise<any> {
    const acc = await insertRow(ds, 'account', {
      kind: 'system',
      owner_id: null,
      system_key: `clearing:test-${randomUUID()}`,
      currency: MXN,
      status: 'active',
      spent_today_date: TODAY,
      spent_month_date: MONTH_START,
      ...overrides,
    });
    createdAccountIds.push(acc.id);
    return acc;
  }

  async function seedThrowawayCurrency(code: string): Promise<void> {
    await ds.query(
      `INSERT INTO currency (code, name, minor_unit_scale, symbol)
       VALUES ($1, $2, 2, '¤') ON CONFLICT (code) DO NOTHING`,
      [code, `${code} test currency`],
    );
    extraCleanups.push(() => ds.query(`DELETE FROM currency WHERE code = $1`, [code]));
  }

  async function cleanupAccounts(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const txRows = await ds.query(
      `SELECT id FROM "transaction" WHERE debit_account_id = ANY($1) OR credit_account_id = ANY($1)
       UNION SELECT DISTINCT transaction_id AS id FROM ledger_entry WHERE account_id = ANY($1)
       UNION SELECT DISTINCT transaction_id AS id FROM hold WHERE account_id = ANY($1)`,
      [ids],
    );
    const txIds = txRows.map((r: any) => r.id);
    if (txIds.length) {
      await ds.query(`DELETE FROM outbox_event WHERE transaction_id = ANY($1)`, [txIds]);
      await ds.query(`DELETE FROM hold WHERE transaction_id = ANY($1)`, [txIds]);
      await ds.query(`DELETE FROM ledger_entry WHERE transaction_id = ANY($1)`, [txIds]);
      await ds.query(`DELETE FROM idempotency_key WHERE transaction_id = ANY($1)`, [txIds]);
      await ds.query(`DELETE FROM approval_request WHERE target_transaction_id = ANY($1)`, [txIds]);
      await ds.query(`DELETE FROM "transaction" WHERE id = ANY($1)`, [txIds]);
    }
    await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
  }

  async function acct(id: string): Promise<{ balance: string; held: string; status: string }> {
    const r = await ds.query(`SELECT balance, held, status FROM account WHERE id = $1`, [id]);
    return r[0];
  }

  async function legsForTx(
    txId: string,
  ): Promise<Array<{ account_id: string; delta: string; balance_after: string }>> {
    return ds.query(
      `SELECT account_id, delta, balance_after FROM ledger_entry WHERE transaction_id = $1`,
      [txId],
    );
  }

  async function txHeader(txId: string): Promise<any> {
    const r = await ds.query(`SELECT * FROM "transaction" WHERE id = $1`, [txId]);
    return r[0];
  }

  async function outboxForTx(txId: string): Promise<any[]> {
    return ds.query(`SELECT * FROM outbox_event WHERE transaction_id = $1`, [txId]);
  }

  async function globalCounts(): Promise<{
    ledger: number;
    tx: number;
    outbox: number;
    hold: number;
  }> {
    const r = await ds.query(
      `SELECT (SELECT count(*) FROM ledger_entry)::int AS ledger,
              (SELECT count(*) FROM "transaction")::int AS tx,
              (SELECT count(*) FROM outbox_event)::int AS outbox,
              (SELECT count(*) FROM hold)::int AS hold`,
    );
    return r[0];
  }

  // Command builders — the spec-derived command shape. If the implementor's command keys
  // differ, this is the one coordination point to reconcile (escalate, don't guess).
  function transfer(
    type: string,
    fromId: string,
    toId: string,
    amount: number,
    initiatedBy: string,
    currency = MXN,
  ): any {
    return {
      type,
      currency,
      amount: String(amount),
      legs: [
        { accountId: fromId, delta: String(-amount) },
        { accountId: toId, delta: String(amount) },
      ],
      initiatedBy,
    };
  }

  /** Classify a rejection. Exact when the domain error class is exported (resolved via the
   *  harness); otherwise falls back to a code/message match. The money-safety proofs GATE on
   *  observable state (rollback), never on this — the kind is a secondary signal. */
  function classify(err: any): string {
    const de = domainErrors;
    if (de.InsufficientFundsError && err instanceof de.InsufficientFundsError)
      return 'insufficient';
    if (de.AccountFrozenError && err instanceof de.AccountFrozenError) return 'frozen';
    if (de.CurrencyMismatchError && err instanceof de.CurrencyMismatchError) return 'currency';
    if (de.AccountNotFoundError && err instanceof de.AccountNotFoundError) return 'not_found';
    const hay = `${err?.constructor?.name ?? ''} ${err?.code ?? ''} ${err?.errorCode ?? ''} ${
      err?.message ?? ''
    }`.toLowerCase();
    if (/insufficient|overdraft|funds|available/.test(hay)) return 'insufficient';
    if (/frozen/.test(hay)) return 'frozen';
    if (/currency|mismatch/.test(hay)) return 'currency';
    if (/not.?found|no such|unknown account/.test(hay)) return 'not_found';
    return 'other';
  }

  async function callAndCapture(command: any): Promise<any> {
    try {
      await posting.postTransaction(command);
    } catch (e) {
      return e;
    }
    return undefined; // resolved — no error
  }

  const sumDeltas = (legs: Array<{ delta: string }>): bigint =>
    legs.reduce((s, l) => s + BigInt(l.delta), 0n);

  // ---- DoD: internal transfer works end-to-end (the happy path) -------------------------

  it('posts an internal transfer atomically: balances folded, double-entry legs, header POSTED, one outbox', async () => {
    const owner = `sub-${randomUUID()}`;
    const a = await mkCustomer({ owner_id: owner, balance: 5000, held: 0 });
    const b = await mkCustomer({ balance: 1500, held: 0 });
    const N = 2000;

    const result = await posting.postTransaction(transfer('internal', a.id, b.id, N, owner));
    expect(result).toBeTruthy();
    const txId = result.id;
    expect(typeof txId).toBe('string');

    // balance folded: A −N, B +N (materialized projection kept in sync in the same tx).
    expect((await acct(a.id)).balance).toBe('3000'); // 5000 - 2000
    expect((await acct(b.id)).balance).toBe('3500'); // 1500 + 2000

    // Exactly two ledger legs for the txn; deltas −N/+N; balance_after = each new balance.
    const legs = await legsForTx(txId);
    expect(legs.length).toBe(2);
    const legA = legs.find((l) => l.account_id === a.id)!;
    const legB = legs.find((l) => l.account_id === b.id)!;
    expect(legA.delta).toBe('-2000');
    expect(legB.delta).toBe('2000');
    expect(legA.balance_after).toBe('3000'); // running fold == A's new balance
    expect(legB.balance_after).toBe('3500'); // running fold == B's new balance
    expect(sumDeltas(legs)).toBe(0n); // double-entry: legs sum to zero

    // Transaction header POSTED with posted_at stamped.
    const header = await txHeader(txId);
    expect(header.status).toBe('POSTED');
    expect(header.posted_at).not.toBeNull();

    // Exactly ONE outbox row for the txn, still unpublished (relay has not run).
    const outbox = await outboxForTx(txId);
    expect(outbox.length).toBe(1);
    expect(outbox[0].published_at).toBeNull();
    expect(typeof outbox[0].event_type).toBe('string');
    expect(outbox[0].event_type.length).toBeGreaterThan(0);
  });

  // ---- DoD: no overdraft; the check is against AVAILABLE (balance − held), not balance ----

  it('rejects a customer debit that exceeds AVAILABLE (held reserves funds) and writes nothing', async () => {
    const owner = `sub-${randomUUID()}`;
    // balance 1000 but 800 is held → available = 200. A debit of 300 is under `balance` yet
    // over `available`: an implementation that funds-checks `balance` (not `available`) would
    // WRONGLY allow this. That is the defect this test exists to catch.
    const a = await mkCustomer({ owner_id: owner, balance: 1000, held: 800 });
    const b = await mkCustomer({ balance: 0, held: 0 });

    const before = await globalCounts();
    const err = await callAndCapture(transfer('internal', a.id, b.id, 300, owner));

    expect(err).toBeDefined(); // it MUST reject
    expect(classify(err)).toBe('insufficient');

    // Atomic rollback: no ledger/tx/outbox/hold row anywhere, balances untouched.
    expect(await globalCounts()).toEqual(before);
    expect((await acct(a.id)).balance).toBe('1000');
    expect((await acct(a.id)).held).toBe('800');
    expect((await acct(b.id)).balance).toBe('0');
  });

  it('allows a debit of EXACTLY available (boundary — proves the check is >=, not >)', async () => {
    const owner = `sub-${randomUUID()}`;
    const a = await mkCustomer({ owner_id: owner, balance: 1000, held: 300 }); // available = 700
    const b = await mkCustomer({ balance: 0, held: 0 });

    const result = await posting.postTransaction(transfer('internal', a.id, b.id, 700, owner));
    expect(result).toBeTruthy();
    expect((await acct(a.id)).balance).toBe('300'); // 1000 - 700; available now 0
    expect((await acct(b.id)).balance).toBe('700');
  });

  // ---- Frozen: a customer DEBIT on a frozen account is rejected (funds are sufficient) ---

  it('rejects a debit from a FROZEN customer account even with sufficient funds, writing nothing', async () => {
    const owner = `sub-${randomUUID()}`;
    // Frozen but well-funded and same-currency: the ONLY reason to reject is the freeze, so a
    // rejection here proves the frozen check fired; a post proves it is missing.
    const frozen = await mkCustomer({ owner_id: owner, status: 'frozen', balance: 5000, held: 0 });
    const b = await mkCustomer({ balance: 0, held: 0 });

    const before = await globalCounts();
    const err = await callAndCapture(transfer('internal', frozen.id, b.id, 100, owner));

    expect(err).toBeDefined();
    expect(classify(err)).toBe('frozen');

    expect(await globalCounts()).toEqual(before);
    expect((await acct(frozen.id)).balance).toBe('5000');
    expect((await acct(b.id)).balance).toBe('0');
  });

  it('ALLOWS crediting a frozen account (a freeze blocks debits, not incoming money)', async () => {
    // Spec: "Customer debits from a frozen account are rejected." Crediting (receiving) is not
    // a debit — an over-broad freeze that blocks ALL activity on the account is a defect.
    const owner = `sub-${randomUUID()}`;
    const a = await mkCustomer({ owner_id: owner, balance: 5000, held: 0 }); // active debtor
    const frozenPayee = await mkCustomer({ status: 'frozen', balance: 0, held: 0 });

    const result = await posting.postTransaction(
      transfer('internal', a.id, frozenPayee.id, 400, owner),
    );
    expect(result).toBeTruthy();
    expect((await acct(a.id)).balance).toBe('4600');
    expect((await acct(frozenPayee.id)).balance).toBe('400'); // frozen account still received
  });

  // ---- Currency mismatch: a leg account whose currency != command.currency is rejected ---

  it('rejects a post when a leg account currency differs from the command currency, writing nothing', async () => {
    await seedThrowawayCurrency('ZZZ');
    const owner = `sub-${randomUUID()}`;
    // A is denominated ZZZ; the command is MXN. Same-currency, sufficient funds otherwise —
    // only the currency mismatch can reject it.
    const a = await mkCustomer({ owner_id: owner, currency: 'ZZZ', balance: 5000, held: 0 });
    const b = await mkCustomer({ currency: MXN, balance: 0, held: 0 });

    const before = await globalCounts();
    const err = await callAndCapture(transfer('internal', a.id, b.id, 100, owner, MXN));

    expect(err).toBeDefined();
    expect(classify(err)).toBe('currency');

    expect(await globalCounts()).toEqual(before);
    expect((await acct(a.id)).balance).toBe('5000');
    expect((await acct(b.id)).balance).toBe('0');
  });

  // ---- Double-entry validation: legs that do not sum to zero would mint/destroy money -----

  it('rejects a post whose legs do NOT sum to zero (would create money), writing nothing', async () => {
    const owner = `sub-${randomUUID()}`;
    const a = await mkCustomer({ owner_id: owner, balance: 5000, held: 0 });
    const b = await mkCustomer({ balance: 0, held: 0 });

    // Debit 100 but credit 150 → net +50 minted. A correct reducer refuses an unbalanced set.
    const minting = {
      type: 'internal',
      currency: MXN,
      amount: '100',
      legs: [
        { accountId: a.id, delta: '-100' },
        { accountId: b.id, delta: '150' },
      ],
      initiatedBy: owner,
    };

    const before = await globalCounts();
    const err = await callAndCapture(minting);

    expect(err).toBeDefined(); // MUST reject — never mint money
    expect(await globalCounts()).toEqual(before);
    expect((await acct(a.id)).balance).toBe('5000');
    expect((await acct(b.id)).balance).toBe('0');
  });

  // ---- System/clearing exemption: a system account may go negative (no overdraft error) ---

  it('lets a SYSTEM/clearing account go negative on an inbound-style post (funds check exempt)', async () => {
    const owner = `sub-${randomUUID()}`;
    const clearing = await mkSystem({ balance: 0, held: 0 }); // starts at zero
    const customer = await mkCustomer({ owner_id: owner, balance: 0, held: 0 });
    const N = 3000;

    // Inbound: debit the clearing account (−N, drives it negative), credit the customer (+N).
    const result = await posting.postTransaction(
      transfer('external_inbound', clearing.id, customer.id, N, 'system-inbound'),
    );
    expect(result).toBeTruthy();

    // The exemption: no InsufficientFunds despite the clearing account having no balance.
    expect((await acct(clearing.id)).balance).toBe('-3000'); // negative, allowed
    expect((await acct(customer.id)).balance).toBe('3000');

    const legs = await legsForTx(result.id);
    expect(legs.length).toBe(2);
    expect(sumDeltas(legs)).toBe(0n);
    expect((await txHeader(result.id)).status).toBe('POSTED');
    expect((await outboxForTx(result.id)).length).toBe(1);
  });

  // ---- DoD KEYSTONE: concurrency — no double-spend / no overdraft / no money created-or-lost

  it('serializes N concurrent transfers so exactly K succeed, A never overdraws, and money is conserved', async () => {
    const owner = `sub-${randomUUID()}`;
    const M = 1000; // size of each transfer
    const K = 5; // A can afford exactly K transfers
    const N = 8; // fire MORE than A can afford, all at once
    const B_START = 4000;

    const a = await mkCustomer({ owner_id: owner, balance: K * M, held: 0 }); // 5000
    const b = await mkCustomer({ balance: B_START, held: 0 });

    // N simultaneous in-process calls, each moving M from A to B. Each opens its own DB
    // transaction; the FOR UPDATE lock on A must serialize them so only K can debit.
    const outcomes = await Promise.allSettled(
      Array.from({ length: N }, () =>
        posting.postTransaction(transfer('internal', a.id, b.id, M, owner)),
      ),
    );
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];

    // Exactly K succeed; the surplus rejects — and rejects for insufficient funds, NOT a
    // leaked deadlock/serialization error (spec: retry the rare 40P01 internally).
    expect(fulfilled.length).toBe(K);
    expect(rejected.length).toBe(N - K);
    for (const r of rejected) expect(classify(r.reason)).toBe('insufficient');

    // No overdraft + no lost update: A drained to exactly 0, B received exactly K·M.
    expect((await acct(a.id)).balance).toBe('0'); // never went negative, no lost debit
    expect((await acct(b.id)).balance).toBe(String(B_START + K * M)); // 9000

    // No money created or lost: exactly K debit legs on A, and every ledger delta across the
    // two accounts nets to zero.
    const aDebitLegs = await ds.query(
      `SELECT count(*)::int AS n FROM ledger_entry WHERE account_id = $1 AND delta < 0`,
      [a.id],
    );
    expect(aDebitLegs[0].n).toBe(K);
    const netAcrossPair = await ds.query(
      `SELECT COALESCE(SUM(delta), 0)::text AS s FROM ledger_entry WHERE account_id = ANY($1)`,
      [[a.id, b.id]],
    );
    expect(netAcrossPair[0].s).toBe('0');
  }, 30_000);

  // ---- DoD: reconciliation — sum(ledger delta) == balance; internal accounts net to 0 -----

  it('reconciles after a batch: sum(ledger delta) == balance per account, and internal transfers net to 0', async () => {
    const ownerA = `sub-${randomUUID()}`;
    const ownerB = `sub-${randomUUID()}`;
    // Start every account at 0 and move ALL money through postTransaction, so the ledger is
    // the complete history and `sum(delta) == balance` is a meaningful reconciliation check.
    const clearing = await mkSystem({ balance: 0, held: 0 });
    const a = await mkCustomer({ owner_id: ownerA, balance: 0, held: 0 });
    const b = await mkCustomer({ owner_id: ownerB, balance: 0, held: 0 });

    // Fund A and B from the inbound rail (system exemption drives clearing negative).
    await posting.postTransaction(transfer('external_inbound', clearing.id, a.id, 10000, 'sys'));
    await posting.postTransaction(transfer('external_inbound', clearing.id, b.id, 10000, 'sys'));
    // Internal transfers between the two customer accounts.
    await posting.postTransaction(transfer('internal', a.id, b.id, 3000, ownerA));
    await posting.postTransaction(transfer('internal', b.id, a.id, 5000, ownerB));
    await posting.postTransaction(transfer('internal', a.id, b.id, 1000, ownerA));

    // Per-account reconciliation: the materialized balance equals the fold of its ledger legs.
    for (const id of [a.id, b.id, clearing.id]) {
      const rec = await ds.query(
        `SELECT COALESCE(SUM(delta), 0)::text AS ledger_sum FROM ledger_entry WHERE account_id = $1`,
        [id],
      );
      expect(rec[0].ledger_sum).toBe((await acct(id)).balance);
    }

    // Expected end state (double-checks the arithmetic, not just self-consistency).
    expect((await acct(a.id)).balance).toBe('11000'); // 10000 -3000 +5000 -1000
    expect((await acct(b.id)).balance).toBe('9000'); // 10000 +3000 -5000 +1000
    expect((await acct(clearing.id)).balance).toBe('-20000');

    // Money conservation: all accounts (customer + clearing) net to zero.
    const total = await ds.query(
      `SELECT COALESCE(SUM(delta), 0)::text AS s FROM ledger_entry WHERE account_id = ANY($1)`,
      [[a.id, b.id, clearing.id]],
    );
    expect(total[0].s).toBe('0');

    // The two internal customer accounts net to 0 across the INTERNAL transfers alone (those
    // only redistribute money between A and B; the funding legs are external_inbound).
    const internalNet = await ds.query(
      `SELECT COALESCE(SUM(le.delta), 0)::text AS s
         FROM ledger_entry le JOIN "transaction" t ON t.id = le.transaction_id
        WHERE le.account_id = ANY($1) AND t.type = 'internal'`,
      [[a.id, b.id]],
    );
    expect(internalNet[0].s).toBe('0');
  }, 30_000);
});
