/**
 * Shared Postgres test helpers for the DB-backed (honest-SKIP) schema suites.
 *
 * These are the coordination seam for schema integration tests: a raw-SQL INSERT
 * builder, an always-rolled-back transaction wrapper (so suites are idempotent and
 * re-runnable), a SQLSTATE assertion, the SQLSTATE vocabulary, and a throwaway
 * currency seeder. They contain NO domain logic under test — only plumbing — so both
 * the Step-1 (`schema-constraints`) and Step-2 (`satellites-schema`) specs import
 * them instead of duplicating.
 *
 * Nothing here talks to the implementor's source; the DataSource is passed in by the
 * caller (resolved from the booted AppModule).
 */
import { randomUUID } from 'crypto';

/** Postgres error codes (SQLSTATE) the schema's constraints must raise. */
export const PG = {
  NOT_NULL: '23502',
  FK_VIOLATION: '23503',
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  INVALID_ENUM_TEXT: '22P02', // "invalid input value for enum ...": proves a NATIVE enum type
  LOCK_NOT_AVAILABLE: '55P03', // FOR UPDATE NOWAIT on an already-locked row
} as const;

/** Date-window markers accounts require (NOT NULL, no DB default — decision #5). */
export const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
export const MONTH_START = TODAY.slice(0, 8) + '01'; // YYYY-MM-01

/** Extract the SQLSTATE from a TypeORM/pg error (driverError carries the raw code). */
export function pgCode(e: any): string | undefined {
  return e?.driverError?.code ?? e?.code;
}

/**
 * Run `fn` inside a QueryRunner transaction that is ALWAYS rolled back. Keeps every
 * mutating assertion isolated so the suite leaves no rows behind and is safe to
 * re-run (including after an expected constraint failure aborts the transaction).
 */
export async function withRollback(ds: any, fn: (q: any) => Promise<void>): Promise<void> {
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

/** Parameterised INSERT ... RETURNING * (avoids quoting/injection); returns the row. */
export async function insertRow(q: any, table: string, row: Record<string, unknown>): Promise<any> {
  const cols = Object.keys(row);
  const colList = cols.map((c) => `"${c}"`).join(', ');
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) RETURNING *`;
  const res = await q.query(sql, Object.values(row));
  return res[0];
}

/** Assert a statement is rejected by Postgres with a specific SQLSTATE. */
export async function expectPgError(p: Promise<unknown>, sqlstate: string): Promise<void> {
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

/**
 * A throwaway currency inserted inside the rolled-back tx, so constraint tests are
 * decoupled from whether the MXN seed lives in a migration (that is tested on its own).
 */
export async function seedTestCurrency(q: any, code = 'TST'): Promise<string> {
  await insertRow(q, 'currency', { code, name: 'Test Currency', minor_unit_scale: 2 });
  return code;
}

/** A valid customer account (all NOT-NULL-without-default columns provided). */
export async function insertAccount(q: any, overrides: Record<string, unknown> = {}): Promise<any> {
  return insertRow(q, 'account', {
    kind: 'customer',
    currency: 'TST',
    spent_today_date: TODAY,
    spent_month_date: MONTH_START,
    ...overrides,
  });
}

/** A minimal valid transaction header (all NOT-NULL-without-default columns provided). */
export async function insertTransaction(
  q: any,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  return insertRow(q, 'transaction', {
    type: 'internal',
    status: 'PENDING',
    amount: 1000,
    currency: 'TST',
    initiated_by: `sub-${randomUUID()}`,
    ...overrides,
  });
}

/**
 * One ledger leg for an account. The `transaction_id` and `account_id` FK parents MUST
 * be supplied via overrides (there is no sensible default). Denominated in MXN by
 * default so read-path suites can reuse the migration-seeded currency rather than
 * committing a throwaway one; pass `created_at` to control statement ordering (the
 * column otherwise defaults to clock_timestamp() at insert).
 */
export async function insertLedgerEntry(
  q: any,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  return insertRow(q, 'ledger_entry', {
    delta: 100,
    balance_after: 100,
    currency: 'MXN',
    ...overrides,
  });
}

/**
 * One `idempotency_key` row with a settable `created_at` — the seam the soft-duplicate
 * WINDOW test needs to plant a prior sibling inside/outside the 60s window. Composite PK is
 * `(owner_id, key)`; `request_fingerprint` is the hash the 60s lookup keys on (pass the exact
 * value the service computes for a given tuple — e.g. one read back from a real `execute`),
 * `status` defaults `completed`, `transaction_id` is nullable, and `expires_at` defaults to
 * created_at + 24h. `created_at`/`expires_at` accept ISO strings so a test can backdate them.
 */
export async function insertIdempotencyKey(
  q: any,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const now = Date.now();
  return insertRow(q, 'idempotency_key', {
    owner_id: `sub-${randomUUID()}`,
    key: `key-${randomUUID()}`,
    request_fingerprint: `fp-${randomUUID()}`,
    status: 'completed',
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  });
}
