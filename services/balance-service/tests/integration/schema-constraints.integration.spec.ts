/**
 * Spec 04 — Balance Service persistence layer, STEP 1 schema.
 *
 * Written from the SCHEMA MANIFEST (specs/balance-schema.yaml) and the data-model
 * (specs/DATA-MODEL.md Part 1 "Enumerations" + per-entity invariants), NOT from the
 * implementor's migration. Each assertion is derived from the manifest, so if the
 * implementor deviates from the manifest's snake_case names, defaults, constraints,
 * enum types, or indexes, the test FAILS — that is the point (tests encode intended
 * behaviour, not the code as written).
 *
 * Scope (Step 1 only): the 5 tables `currency`, `account`, `external_payee`,
 * `transaction`, `ledger_entry` and the 5 native enum types `account_kind`,
 * `account_status`, `transaction_type`, `transaction_status`, `payee_status`.
 * Hold / user_limits / outbox_event / audit_log / approval_request / idempotency_key
 * are Step 2 and are NOT exercised here.
 *
 * This is a genuinely DB-dependent suite, so it follows the repo's honest-SKIP
 * discipline (see tests/README.md + the reference health-and-migration spec): it is
 * OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports it SKIPPED — never a
 * false pass), TCP-probes Postgres before booting and fails loudly if unreachable,
 * boots the real AppModule (which runs migrations on boot, migrationsRun:true), and
 * inspects the resulting schema via raw SQL. Every mutating assertion runs inside a
 * QueryRunner transaction that is ALWAYS rolled back, so the suite is idempotent and
 * safe to re-run; seed rows use random ids so parallel/repeat runs never collide.
 *
 * To run:
 *   1. bring up the compose datastores (Postgres reachable to the test runner);
 *   2. export the balance service's DB_* env (or rely on the defaults below);
 *   3. BALANCE_INTEGRATION=1 npm test
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { getAppModule, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import {
  PG,
  TODAY,
  MONTH_START,
  withRollback as withRollbackOn,
  insertRow,
  insertAccount,
  insertCustomer,
  insertTransaction,
  expectPgError,
  seedTestCurrency,
  localAccountNumber,
} from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED schema-constraints suite: set BALANCE_INTEGRATION=1 (and ' +
      'point DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME at a reachable Postgres) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');

// describe.skip when not opted in -> tests show as skipped, not passed.
const suite = ENABLED ? describe : describe.skip;

// ---- Enum types + labels, straight from DATA-MODEL.md "Enumerations" (Step-1 five)
const EXPECTED_ENUMS: Record<string, string[]> = {
  account_kind: ['customer', 'system'],
  account_status: ['active', 'frozen'],
  transaction_type: ['internal', 'external_outbound', 'external_inbound'],
  // PR #19 (single + time-boxed pending authorization) adds the two terminal lifecycle labels the
  // auto-supersede (CANCELLED) and lazy-expiry (EXPIRED) transitions produce — see spec 04
  // Transactions "Lifecycle" + "Pending authorization is single and time-boxed".
  transaction_status: ['PENDING', 'POSTED', 'FAILED', 'REVERSED', 'EXPIRED', 'CANCELLED'],
  payee_status: ['pending', 'active', 'disabled'],
};

suite('balance schema — Step 1 constraints (integration, needs Postgres)', () => {
  let app: INestApplication;
  let ds: any;

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
    await app.init(); // runs migrations on boot (migrationsRun: true)

    try {
      const { DataSource } = require('typeorm');
      ds = app.get(DataSource);
    } catch {
      const { getDataSourceToken } = require('@nestjs/typeorm');
      ds = app.get(getDataSourceToken());
    }
    if (!ds) throw new Error('[integration] could not resolve the TypeORM DataSource from the app');
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  // Shared helpers (tests/support/pg.ts) bound to this suite's resolved DataSource.
  const withRollback = (fn: (q: any) => Promise<void>) => withRollbackOn(ds, fn);

  // ---- Structure: tables, enum types, seed, indexes -------------------------------

  it('creates the five Step-1 tables', async () => {
    const rows: Array<{ table_name: string }> = await ds.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ['currency', 'account', 'external_payee', 'transaction', 'ledger_entry']) {
      expect(names).toContain(t);
    }
  });

  it('creates the five native enum types with exactly the manifest labels', async () => {
    const rows: Array<{ typname: string; labels: string[] }> = await ds.query(
      `SELECT t.typname AS typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typtype = 'e' AND n.nspname = 'public'
        GROUP BY t.typname`,
    );
    const byName = new Map(rows.map((r) => [r.typname, r.labels]));
    for (const [name, labels] of Object.entries(EXPECTED_ENUMS)) {
      expect(byName.has(name)).toBe(true);
      expect([...(byName.get(name) ?? [])].sort()).toEqual([...labels].sort());
    }
  });

  it('seeds the exact MXN currency row (Mexican Peso / $ / minor_unit_scale 2)', async () => {
    const rows: Array<{ name: string; minor_unit_scale: number; symbol: string }> = await ds.query(
      `SELECT name, minor_unit_scale, symbol FROM currency WHERE code = 'MXN'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('Mexican Peso');
    expect(Number(rows[0].minor_unit_scale)).toBe(2);
    expect(rows[0].symbol).toBe('$');
  });

  it('creates the named indexes, with the partial predicates the data-model specifies', async () => {
    const rows: Array<{ indexname: string; indexdef: string }> = await ds.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef.toLowerCase()]));

    // idx_ledger_account_created (account_id, created_at) — per-account ledger order.
    expect(byName.has('idx_ledger_account_created')).toBe(true);
    expect(byName.get('idx_ledger_account_created')).toContain('account_id');
    expect(byName.get('idx_ledger_account_created')).toContain('created_at');

    // idx_tx_account (debit_account_id, created_at) — GET /accounts/:id/transactions.
    expect(byName.has('idx_tx_account')).toBe(true);
    expect(byName.get('idx_tx_account')).toContain('debit_account_id');
    expect(byName.get('idx_tx_account')).toContain('created_at');

    // idx_account_owner (owner_id) WHERE kind = 'customer' — partial.
    expect(byName.has('idx_account_owner')).toBe(true);
    expect(byName.get('idx_account_owner')).toContain('owner_id');
    expect(byName.get('idx_account_owner')).toContain('where');
    expect(byName.get('idx_account_owner')).toContain('customer');

    // uq_account_system_key (system_key) WHERE kind = 'system' — partial UNIQUE.
    expect(byName.has('uq_account_system_key')).toBe(true);
    expect(byName.get('uq_account_system_key')).toContain('unique');
    expect(byName.get('uq_account_system_key')).toContain('system_key');
    expect(byName.get('uq_account_system_key')).toContain('where');
    expect(byName.get('uq_account_system_key')).toContain('system');

    // uq_payee (owner_id, rail, destination_ref) — UNIQUE triple.
    expect(byName.has('uq_payee')).toBe(true);
    expect(byName.get('uq_payee')).toContain('unique');
    expect(byName.get('uq_payee')).toContain('owner_id');
    expect(byName.get('uq_payee')).toContain('rail');
    expect(byName.get('uq_payee')).toContain('destination_ref');
  });

  // ---- Defaults -------------------------------------------------------------------

  it('applies account defaults: balance=0, held=0, status=active, spent_today/month=0', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      const acc = await insertAccount(q); // only NOT-NULL-without-default cols supplied
      expect(Number(acc.balance)).toBe(0);
      expect(Number(acc.held)).toBe(0);
      expect(acc.status).toBe('active');
      expect(Number(acc.spent_today)).toBe(0);
      expect(Number(acc.spent_month)).toBe(0);
    });
  });

  it('requires spent_today_date on account insert (NOT NULL, no DB default — decision #5)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      // Every other NOT-NULL-without-default column is supplied; omitting only
      // spent_today_date isolates the 23502 to that column. A regression that made it
      // nullable or gave it a default would let this INSERT succeed and later break the
      // fixed-window (spent_today) reset that relies on the marker always being set.
      await expectPgError(
        insertRow(q, 'account', {
          kind: 'customer',
          currency: 'TST',
          spent_month_date: MONTH_START,
        }),
        PG.NOT_NULL,
      );
    });
  });

  it('requires spent_month_date on account insert (NOT NULL, no DB default — decision #5)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      await expectPgError(
        insertRow(q, 'account', {
          kind: 'customer',
          currency: 'TST',
          spent_today_date: TODAY,
        }),
        PG.NOT_NULL,
      );
    });
  });

  it('defaults a new external_payee to status=pending (never usable before cooling-off)', async () => {
    await withRollback(async (q) => {
      const payee = await insertRow(q, 'external_payee', {
        owner_id: `sub-${randomUUID()}`,
        display_name: 'ACME Corp',
        rail: 'rail-outbound',
        destination_ref: '****1234',
        cooling_off_until: new Date().toISOString(),
      });
      expect(payee.status).toBe('pending');
    });
  });

  it('populates ledger_entry.created_at from the clock at insert (non-null and recent)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      const acc = await insertAccount(q);
      const tx = await insertRow(q, 'transaction', {
        type: 'internal',
        status: 'PENDING',
        amount: 1000,
        currency: 'TST',
        initiated_by: `sub-${randomUUID()}`,
      });
      const entry = await insertRow(q, 'ledger_entry', {
        transaction_id: tx.id,
        account_id: acc.id,
        delta: -1000,
        balance_after: -1000,
        currency: 'TST',
      });
      expect(entry.created_at).toBeTruthy();
      const ageMs = Date.now() - new Date(entry.created_at).getTime();
      expect(ageMs).toBeGreaterThanOrEqual(-5000); // tolerate tiny clock skew
      expect(ageMs).toBeLessThan(120_000); // fired at insert, not some fixed past value
    });
  });

  // ---- Foreign keys ---------------------------------------------------------------

  it('rejects an account whose currency is not in the currency table (FK)', async () => {
    await withRollback(async (q) => {
      await expectPgError(insertAccount(q, { currency: 'ZZZ' }), PG.FK_VIOLATION);
    });
  });

  it('rejects a ledger_entry referencing a non-existent transaction (FK)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      const acc = await insertAccount(q);
      await expectPgError(
        insertRow(q, 'ledger_entry', {
          transaction_id: randomUUID(), // no such transaction
          account_id: acc.id,
          delta: -1,
          balance_after: -1,
          currency: 'TST',
        }),
        PG.FK_VIOLATION,
      );
    });
  });

  it('rejects a ledger_entry referencing a non-existent account (FK)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      const tx = await insertRow(q, 'transaction', {
        type: 'internal',
        status: 'PENDING',
        amount: 1000,
        currency: 'TST',
        initiated_by: `sub-${randomUUID()}`,
      });
      await expectPgError(
        insertRow(q, 'ledger_entry', {
          transaction_id: tx.id,
          account_id: randomUUID(), // no such account
          delta: -1,
          balance_after: -1,
          currency: 'TST',
        }),
        PG.FK_VIOLATION,
      );
    });
  });

  // ---- Native enum enforcement ----------------------------------------------------

  it('rejects an account.kind that is not a valid enum label (native enum, not free text)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      await expectPgError(insertAccount(q, { kind: 'bogus' }), PG.INVALID_ENUM_TEXT);
    });
  });

  // ---- CHECK held >= 0, and NO blanket balance >= 0 -------------------------------

  it('rejects an account with held < 0 on INSERT (CHECK held >= 0)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      await expectPgError(insertAccount(q, { held: -1 }), PG.CHECK_VIOLATION);
    });
  });

  it('rejects held < 0 on UPDATE too (the CHECK guards mutations, not just inserts)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      const acc = await insertAccount(q);
      await expectPgError(
        q.query(`UPDATE "account" SET held = -1 WHERE id = $1`, [acc.id]),
        PG.CHECK_VIOLATION,
      );
    });
  });

  it('ALLOWS a negative balance (clearing/system account net-in-transit) — no blanket balance>=0 check', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      const acc = await insertAccount(q, {
        kind: 'system',
        owner_id: null,
        system_key: `clearing:test-${randomUUID()}`,
        balance: -5000,
      });
      expect(Number(acc.balance)).toBe(-5000);
    });
  });

  // ---- Partial UNIQUE uq_account_system_key ---------------------------------------

  it('rejects two system accounts sharing the same system_key (partial UNIQUE)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      const key = `clearing:test-${randomUUID()}`;
      await insertAccount(q, { kind: 'system', owner_id: null, system_key: key });
      await expectPgError(
        insertAccount(q, { kind: 'system', owner_id: null, system_key: key }),
        PG.UNIQUE_VIOLATION,
      );
    });
  });

  it('allows multiple customer accounts with system_key NULL (partial index excludes them)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      const a1 = await insertAccount(q, { owner_id: `sub-${randomUUID()}` });
      const a2 = await insertAccount(q, { owner_id: `sub-${randomUUID()}` });
      expect(a1.id).toBeTruthy();
      expect(a2.id).toBeTruthy();
      expect(a1.id).not.toBe(a2.id);
    });
  });

  // ---- UNIQUE uq_payee (owner_id, rail, destination_ref) --------------------------

  it('enforces uq_payee on the full (owner_id, rail, destination_ref) triple', async () => {
    await withRollback(async (q) => {
      const owner = `sub-${randomUUID()}`;
      const now = new Date().toISOString();
      await insertRow(q, 'external_payee', {
        owner_id: owner,
        display_name: 'ACME',
        rail: 'rail-x',
        destination_ref: 'ref-1',
        cooling_off_until: now,
      });
      // Same owner + rail but a DIFFERENT destination_ref must be allowed (proves the
      // unique key is the triple, not owner alone).
      const p2 = await insertRow(q, 'external_payee', {
        owner_id: owner,
        display_name: 'ACME-2',
        rail: 'rail-x',
        destination_ref: 'ref-2',
        cooling_off_until: now,
      });
      expect(p2.id).toBeTruthy();
      // The exact same triple must be rejected.
      await expectPgError(
        insertRow(q, 'external_payee', {
          owner_id: owner,
          display_name: 'ACME-dup',
          rail: 'rail-x',
          destination_ref: 'ref-1',
          cooling_off_until: now,
        }),
        PG.UNIQUE_VIOLATION,
      );
    });
  });

  // ---- Single + time-boxed pending: uq_one_pending_per_initiator (partial UNIQUE) ----------
  // PR #19 enforces "at most one PENDING transfer per user" at the DB, not just in the service:
  // a partial unique index on transaction(initiated_by) WHERE status = 'PENDING'. Each test is
  // power-bearing — drop the index and the second PENDING stops colliding (the "expected
  // rejection but it succeeded" branch fires), or make it non-partial and the POSTED sibling
  // wrongly collides.

  it('creates uq_one_pending_per_initiator as a PARTIAL unique index on initiated_by WHERE status = PENDING', async () => {
    const rows: Array<{ indexname: string; indexdef: string }> = await ds.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef.toLowerCase()]));
    expect(byName.has('uq_one_pending_per_initiator')).toBe(true);
    const def = byName.get('uq_one_pending_per_initiator')!;
    expect(def).toContain('unique');
    expect(def).toContain('initiated_by');
    expect(def).toContain('where'); // partial — only PENDING rows participate
    expect(def).toContain('pending');
  });

  it('rejects a SECOND PENDING transaction for the same initiator (uq_one_pending_per_initiator, 23505)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      const initiator = `sub-${randomUUID()}`;
      const first = await insertTransaction(q, {
        initiatedBy: initiator,
        currency: 'TST',
        expiresAt: new Date(Date.now() + 120_000),
      });
      expect(first.status).toBe('PENDING'); // helper defaults status to PENDING
      // A SECOND still-PENDING transfer for the SAME initiator must collide on the partial index.
      await expectPgError(
        insertTransaction(q, {
          initiatedBy: initiator,
          currency: 'TST',
          expiresAt: new Date(Date.now() + 120_000),
        }),
        PG.UNIQUE_VIOLATION,
      );
    });
  });

  it('ALLOWS a second NON-pending (POSTED) transaction for the same initiator (index is partial)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      const initiator = `sub-${randomUUID()}`;
      await insertTransaction(q, {
        initiatedBy: initiator,
        currency: 'TST',
        expiresAt: new Date(Date.now() + 120_000),
      }); // the one PENDING
      // A POSTED transfer for the SAME initiator is OUTSIDE the partial predicate → inserts fine.
      const posted = await insertTransaction(q, {
        initiatedBy: initiator,
        currency: 'TST',
        status: 'POSTED',
        postedAt: new Date(),
      });
      expect(posted.status).toBe('POSTED');
      expect(posted.id).toBeTruthy();
    });
  });

  // ---- Confirmation-of-payee migration: uq_account_account_number + fk_account_owner ----
  // Two invariants added by CreateCustomerAndAccountNumber: a PLAIN unique index on
  // account.account_number, and the account.owner_id -> customer.id FK. Each test below
  // is power-bearing — it FAILS if its constraint is dropped (the number stops colliding,
  // or the orphan owner stops being rejected) — and the multi-NULL case pins the plain-index
  // choice the system/clearing accounts (NULL number) depend on.

  it('rejects a second account reusing an existing account_number (uq_account_account_number UNIQUE)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      const number = localAccountNumber(); // one fixed 10-digit number, claimed twice
      // System-style rows (owner_id NULL) isolate the collision to the account_number index:
      // NULL owner_id skips fk_account_owner, and the unique index applies regardless of kind.
      const first = await insertAccount(q, {
        kind: 'system',
        owner_id: null,
        account_number: number,
      });
      expect(first.account_number).toBe(number);
      // The SAME number on a second account must collide on uq_account_account_number.
      await expectPgError(
        insertAccount(q, { kind: 'system', owner_id: null, account_number: number }),
        PG.UNIQUE_VIOLATION,
      );
    });
  });

  it('rejects a customer account whose owner_id is not a real customer (fk_account_owner FK)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      // insertRow (NOT insertAccount) so no customer parent is seeded — owner_id points at a
      // sub absent from `customer`. Every other FK is satisfied (currency TST seeded), so the
      // only unsatisfied reference is fk_account_owner: a 23503 here proves that FK is live.
      await expectPgError(
        insertRow(q, 'account', {
          kind: 'customer',
          currency: 'TST',
          spent_today_date: TODAY,
          spent_month_date: MONTH_START,
          owner_id: `sub-${randomUUID()}`, // no such customer
        }),
        PG.FK_VIOLATION,
      );
    });
  });

  it('allows multiple accounts with account_number NULL (multi-NULL tolerance for system/clearing accounts)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      // System/clearing accounts carry a NULL account_number; a PLAIN unique index tolerates
      // many NULLs, so BOTH inserts must succeed. A NOT-NULL default or a NULL-rejecting index
      // regression would break the seed of the clearing accounts and fail here.
      const a1 = await insertAccount(q, { kind: 'system', owner_id: null, account_number: null });
      const a2 = await insertAccount(q, { kind: 'system', owner_id: null, account_number: null });
      expect(a1.id).toBeTruthy();
      expect(a2.id).toBeTruthy();
      expect(a1.id).not.toBe(a2.id);
      expect(a1.account_number).toBeNull();
      expect(a2.account_number).toBeNull();
    });
  });

  // ---- Confirmation-of-payee migration: uq_customer_phone + uq_customer_email ----------
  // `customer.phone` and `customer.email` are UNIQUE (indexes uq_customer_phone /
  // uq_customer_email). The confirmation-of-payee flow keys on a caller reaching a UNIQUE
  // destination profile, so two customers must never share a phone or an email. Email uniqueness
  // is CASE-INSENSITIVE (uq_customer_email is a functional index on LOWER(email)), so two
  // addresses that differ only by letter-case are the SAME address. Each test is power-bearing:
  // drop the matching index and the duplicate insert stops being rejected, so the "expected
  // rejection but it succeeded" branch fires. The second row is written via a direct INSERT
  // (insertRow, no ON CONFLICT) so the phone/email UNIQUE violation surfaces instead of being
  // swallowed by insertCustomer's ON CONFLICT (id) clause.

  it('rejects two customers sharing the same phone (uq_customer_phone UNIQUE)', async () => {
    await withRollback(async (q) => {
      const phone = `521${localAccountNumber()}`; // one 13-digit phone, claimed twice
      // First customer takes the phone via an explicit override (not the derived default).
      await insertCustomer(q, `sub-${randomUUID()}`, { phone });
      // A DIFFERENT customer (different id, different email) reusing the SAME phone must collide
      // on uq_customer_phone. insertRow issues a raw INSERT so the UNIQUE(phone) violation is not
      // masked by ON CONFLICT (id).
      await expectPgError(
        insertRow(q, 'customer', {
          id: `sub-${randomUUID()}`, // DIFFERENT id
          name: 'Ana Lopez',
          phone, // SAME phone → 23505
          email: `dup-${randomUUID()}@example.test`, // DIFFERENT email
        }),
        PG.UNIQUE_VIOLATION,
      );
    });
  });

  it('rejects two customers sharing the same email (uq_customer_email UNIQUE)', async () => {
    await withRollback(async (q) => {
      const email = `dup-${randomUUID()}@example.test`; // one email, claimed twice
      // First customer takes the email via an explicit override (not the derived default).
      await insertCustomer(q, `sub-${randomUUID()}`, { email });
      // A DIFFERENT customer (different id, different phone) reusing the SAME email must collide
      // on uq_customer_email.
      await expectPgError(
        insertRow(q, 'customer', {
          id: `sub-${randomUUID()}`, // DIFFERENT id
          name: 'Ana Lopez',
          phone: `521${localAccountNumber()}`, // DIFFERENT phone
          email, // SAME email → 23505
        }),
        PG.UNIQUE_VIOLATION,
      );
    });
  });

  it('rejects two customers whose emails differ only by letter-case (uq_customer_email folds on LOWER(email))', async () => {
    await withRollback(async (q) => {
      // ONE address, claimed twice in different case. Under a PLAIN (email) unique index the two
      // byte-strings are distinct, so the second INSERT would SUCCEED and this test would fail at
      // expectPgError; only a functional UNIQUE index on LOWER(email) folds them into a single key
      // and raises 23505 — the developer-directed case-insensitive behaviour. The random token
      // keeps the address unique across parallel/repeat runs; the case difference lives in the
      // fixed "User"/"Example.com" letters (randomUUID is all-lowercase hex).
      const token = randomUUID();
      const emailMixed = `User-${token}@Example.com`; // stored first, MIXED case
      const emailLower = emailMixed.toLowerCase(); // SAME address, all lower-case
      // First customer takes the mixed-case address (explicit override, not the derived default).
      await insertCustomer(q, `sub-${randomUUID()}`, { email: emailMixed });
      // A DIFFERENT customer (different id, different phone) reusing the SAME address in a
      // different case must collide on uq_customer_email. Raw insertRow so the UNIQUE(LOWER(email))
      // violation surfaces instead of being masked by insertCustomer's ON CONFLICT (id).
      await expectPgError(
        insertRow(q, 'customer', {
          id: `sub-${randomUUID()}`, // DIFFERENT id
          name: 'Ana Lopez',
          phone: `521${localAccountNumber()}`, // DIFFERENT phone
          email: emailLower, // SAME address, lower-cased → 23505 under LOWER(email)
        }),
        PG.UNIQUE_VIOLATION,
      );
    });
  });

  it('allows two customers with genuinely different emails (guards against an over-broad index)', async () => {
    await withRollback(async (q) => {
      // Complements the case-collision test: pins the index to the WHOLE address, not some
      // over-broad expression (e.g. domain-only) that would fold distinct addresses together and
      // reject this pair. Both distinct emails must insert cleanly.
      const c1 = await insertCustomer(q, `sub-${randomUUID()}`, {
        email: `alice-${randomUUID()}@example.test`,
      });
      const c2 = await insertRow(q, 'customer', {
        id: `sub-${randomUUID()}`, // DIFFERENT id
        name: 'Bob Rivera',
        phone: `521${localAccountNumber()}`, // DIFFERENT phone
        email: `bob-${randomUUID()}@example.test`, // DIFFERENT address
      });
      expect(c1.id).toBeTruthy();
      expect(c2.id).toBeTruthy();
      expect(c1.id).not.toBe(c2.id);
      expect(c1.email).not.toBe(c2.email);
    });
  });
});
