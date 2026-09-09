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

// ---- Postgres error codes (SQLSTATE) the manifest's constraints must raise --------
const PG = {
  NOT_NULL: '23502',
  FK_VIOLATION: '23503',
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  INVALID_ENUM_TEXT: '22P02', // "invalid input value for enum ...": proves a NATIVE enum type
} as const;

// ---- Enum types + labels, straight from DATA-MODEL.md "Enumerations" (Step-1 five)
const EXPECTED_ENUMS: Record<string, string[]> = {
  account_kind: ['customer', 'system'],
  account_status: ['active', 'frozen'],
  transaction_type: ['internal', 'external_outbound', 'external_inbound'],
  transaction_status: ['PENDING', 'POSTED', 'FAILED', 'REVERSED'],
  payee_status: ['pending', 'active', 'disabled'],
};

// Window markers the manifest marks NOT NULL but promises no default for; supply
// them explicitly so "defaults" assertions test ONLY the defaults the manifest
// actually promises (balance/held/status/spent_*), never an unpromised date default.
const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const MONTH_START = TODAY.slice(0, 8) + '01'; // YYYY-MM-01

function pgCode(e: any): string | undefined {
  return e?.driverError?.code ?? e?.code;
}

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

  // Run `fn` inside a transaction that is ALWAYS rolled back (idempotent re-runs).
  async function withRollback(fn: (q: any) => Promise<void>): Promise<void> {
    const q = ds.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      await fn(q);
    } finally {
      try {
        await q.rollbackTransaction();
      } catch {
        /* a transaction aborted by an expected constraint failure still rolls back */
      }
      await q.release();
    }
  }

  // Parameterised INSERT ... RETURNING * (avoids quoting/injection); returns the row.
  async function insertRow(q: any, table: string, row: Record<string, unknown>): Promise<any> {
    const cols = Object.keys(row);
    const colList = cols.map((c) => `"${c}"`).join(', ');
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) RETURNING *`;
    const res = await q.query(sql, Object.values(row));
    return res[0];
  }

  // Assert a statement is rejected by Postgres with a specific SQLSTATE.
  async function expectPgError(p: Promise<unknown>, sqlstate: string): Promise<void> {
    try {
      await p;
    } catch (e) {
      const code = pgCode(e);
      expect(code).toBe(sqlstate);
      return;
    }
    throw new Error(
      `expected the statement to be rejected with SQLSTATE ${sqlstate}, but it succeeded`,
    );
  }

  // A throwaway currency inserted inside the rolled-back tx, so constraint tests are
  // decoupled from whether the MXN seed lives in a migration (that is tested on its own).
  async function seedTestCurrency(q: any, code = 'TST'): Promise<string> {
    await insertRow(q, 'currency', { code, name: 'Test Currency', minor_unit_scale: 2 });
    return code;
  }

  // A valid customer account (all NOT-NULL-without-default columns provided).
  async function insertAccount(q: any, overrides: Record<string, unknown> = {}): Promise<any> {
    return insertRow(q, 'account', {
      kind: 'customer',
      currency: 'TST',
      spent_today_date: TODAY,
      spent_month_date: MONTH_START,
      ...overrides,
    });
  }

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
});
