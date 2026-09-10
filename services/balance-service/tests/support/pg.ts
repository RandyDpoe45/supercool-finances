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
import { createHash, randomUUID } from 'crypto';

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

/** A valid customer account (all NOT-NULL-without-default columns provided). When a non-null
 * `owner_id` is supplied, its `customer` FK parent is seeded first (idempotently) so the
 * `fk_account_owner` constraint added by the confirmation-of-payee migration is satisfied —
 * suites that seed owned accounts do not need to know about the customer table. */
export async function insertAccount(q: any, overrides: Record<string, unknown> = {}): Promise<any> {
  const ownerId = overrides.owner_id;
  if (typeof ownerId === 'string' && ownerId.length > 0) {
    await insertCustomer(q, ownerId);
  }
  return insertRow(q, 'account', {
    kind: 'customer',
    currency: 'TST',
    spent_today_date: TODAY,
    spent_month_date: MONTH_START,
    ...overrides,
  });
}

/**
 * A deterministic, per-customer UNIQUE phone derived from the customer id, in the same
 * 13-digit shape as the old constant (`521` + 10 digits). `customer.phone` is UNIQUE
 * (`uq_customer_phone`), so a constant default would collide (23505) the instant a suite seeds
 * a second customer — which the transfers suites do on every test (source + destination). The
 * id-hash keeps DISTINCT ids → DISTINCT phones and the SAME id → the SAME phone, so a repeated
 * `ON CONFLICT (id) DO NOTHING` seed stays stable. Callers may still pin an explicit `phone`.
 */
function derivePhone(id: string): string {
  const hex = createHash('sha256').update(id).digest('hex');
  const tail = (BigInt('0x' + hex.slice(0, 15)) % 10_000_000_000n).toString().padStart(10, '0');
  return `521${tail}`;
}

/**
 * A `customer` row (the balance-service's own money-domain profile — PK `id` IS the Keycloak
 * `sub`, the same value stored in `account.owner_id`, which FKs to it via `fk_account_owner`).
 * All three profile columns (`name`, `phone`, `email`) are NOT NULL; `phone` and `email` are
 * UNIQUE, so their defaults are derived per-id (phone via `derivePhone`, email `${id}@example.test`)
 * — distinct ids never collide. Seed this BEFORE any customer account referencing the owner, or
 * the account insert fails the FK. Idempotent via `ON CONFLICT (id) DO NOTHING` so several
 * accounts can share one owner within a test. `name` is settable so a suite can prove the
 * payee-name mask against a KNOWN holder name; `phone`/`email` are settable to force a collision.
 */
export async function insertCustomer(
  q: any,
  id: string,
  overrides: { name?: string; phone?: string; email?: string } = {},
): Promise<{ id: string; name: string; phone: string; email: string }> {
  const name = overrides.name ?? 'Juan Perez';
  const phone = overrides.phone ?? derivePhone(id);
  const email = overrides.email ?? `${id}@example.test`;
  await q.query(
    `INSERT INTO "customer" (id, name, phone, email)
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [id, name, phone, email],
  );
  return { id, name, phone, email };
}

/**
 * A locally-minted 10-digit numeric account number, unique per test run (a random 10-digit
 * string). Used to set `account.account_number` when the harness cannot resolve the production
 * `generateAccountNumber` helper. The DB's `uq_account_account_number` index still enforces
 * global uniqueness; random 10-digit values keep collisions astronomically unlikely per run.
 */
export function localAccountNumber(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += String(Math.floor(Math.random() * 10));
  return s;
}

/**
 * Options for {@link insertTransaction} — the transfer/transaction header a lifecycle suite needs
 * to construct explicit states. Named (camelCase) fields map to the `"transaction"` columns;
 * `expiresAt` / `createdAt` / `postedAt` accept a JS `Date` (node-postgres serializes it to the
 * `timestamptz` column), so a test can seed a PENDING transfer with `expiresAt` in the PAST to
 * exercise LAZY expiry. `status` defaults to `'PENDING'`; `initiatedBy` defaults to a fresh unique
 * `sub-<uuid>` — so two default inserts never share an initiator and thus never violate the new
 * `uq_one_pending_per_initiator` partial unique index (at most one PENDING per initiator).
 */
export interface InsertTransactionOpts {
  id?: string;
  type?: string;
  status?: string;
  amount?: number | string;
  currency?: string;
  debitAccountId?: string | null;
  creditAccountId?: string | null;
  initiatedBy?: string;
  expiresAt?: Date | null;
  createdAt?: Date;
  postedAt?: Date | null;
}

/**
 * A transaction header row (all NOT-NULL-without-default columns defaulted). Only the keys the
 * caller sets are written, so an unset `expires_at` / `created_at` / `posted_at` keeps its column
 * default / NULL. Returns the inserted row (RETURNING *). NEVER seeds two PENDING rows for one
 * `initiated_by` by default — the unique index forbids it.
 */
export async function insertTransaction(q: any, opts: InsertTransactionOpts = {}): Promise<any> {
  const row: Record<string, unknown> = {
    type: opts.type ?? 'internal',
    status: opts.status ?? 'PENDING',
    amount: opts.amount ?? 1000,
    currency: opts.currency ?? 'TST',
    initiated_by: opts.initiatedBy ?? `sub-${randomUUID()}`,
  };
  if (opts.id !== undefined) row.id = opts.id;
  if (opts.debitAccountId !== undefined) row.debit_account_id = opts.debitAccountId;
  if (opts.creditAccountId !== undefined) row.credit_account_id = opts.creditAccountId;
  if (opts.expiresAt !== undefined) row.expires_at = opts.expiresAt;
  if (opts.createdAt !== undefined) row.created_at = opts.createdAt;
  if (opts.postedAt !== undefined) row.posted_at = opts.postedAt;
  return insertRow(q, 'transaction', row);
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
