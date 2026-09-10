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
  /** The `reverses_transaction_id` FK (self-reference) — set it to seed a compensating REVERSAL
   * header (e.g. a rail-failure reversal), or to assert the step-5c reversal links to its original.
   * Its FK parent (the original transaction) must already exist. */
  reversesTransactionId?: string | null;
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
  if (opts.reversesTransactionId !== undefined) {
    row.reverses_transaction_id = opts.reversesTransactionId;
  }
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

/**
 * The constant outbound rail literal, mirroring the production `OUTBOUND_RAIL` (spec of record).
 * Kept as a LITERAL here (not imported from src) so this plumbing file stays source-free; a suite
 * that needs the AUTHORITATIVE constant uses `harness.getOutboundRail()`. The `uq_payee` unique
 * index is `(owner_id, rail, destination_ref)`, so two default inserts for one owner never collide
 * as long as `destination_ref` differs (it defaults to a unique-per-call digit string).
 */
const PAYEE_OUTBOUND_RAIL = 'rail-outbound';

/** A locally-minted numeric external account number (a random 12-digit string, within the 6–20
 * digit registration bound), unique-per-call so repeated default seeds for one owner don't collide
 * on `uq_payee`. */
export function localDestinationRef(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += String(Math.floor(Math.random() * 10));
  return s;
}

/**
 * Options for {@link insertExternalPayee}. Named (camelCase) fields map to the `"external_payee"`
 * columns. `ownerId` is REQUIRED (there is NO owner FK on `external_payee` — the migration/entity
 * carry none — so no `customer` parent row is seeded). `coolingOffUntil` accepts a JS `Date`
 * (node-postgres serializes it to the `timestamptz` column): a **PAST** date → the payee is already
 * usable (`now() >= cooling_off_until`); a **FUTURE** date → still in cooling-off. `rail` defaults to
 * the constant outbound rail and `destinationRef` to a unique-per-call digit string; `status`
 * (default `pending`) / `created_at` (default `now()`) keep their DB defaults unless set.
 */
export interface InsertExternalPayeeOpts {
  id?: string;
  ownerId: string;
  displayName?: string;
  rail?: string;
  destinationRef?: string;
  coolingOffUntil?: Date;
  createdAt?: Date;
  status?: string;
}

/**
 * An `external_payee` row (all NOT-NULL-without-default columns defaulted). `cooling_off_until`
 * defaults to a moment in the PAST (already usable) — the common case for downstream outbound
 * tests; pass a FUTURE `coolingOffUntil` to seed a payee still inside its cooling-off window. Only
 * the keys the caller sets beyond the defaults are written, so an unset `status` / `created_at`
 * keeps its DB default. Returns the inserted row (RETURNING *).
 */
export async function insertExternalPayee(q: any, opts: InsertExternalPayeeOpts): Promise<any> {
  const row: Record<string, unknown> = {
    owner_id: opts.ownerId,
    display_name: opts.displayName ?? 'Acme Payments',
    rail: opts.rail ?? PAYEE_OUTBOUND_RAIL,
    destination_ref: opts.destinationRef ?? localDestinationRef(),
    cooling_off_until: opts.coolingOffUntil ?? new Date(Date.now() - 1000),
  };
  if (opts.id !== undefined) row.id = opts.id;
  if (opts.status !== undefined) row.status = opts.status;
  if (opts.createdAt !== undefined) row.created_at = opts.createdAt;
  return insertRow(q, 'external_payee', row);
}

/**
 * Options for {@link insertHold} — the reservation-ledger row a holds/outbound suite needs to
 * construct explicit hold states. Named (camelCase) fields map to the `"hold"` columns. `accountId`
 * / `transactionId` are REQUIRED (both FK to seeded parents — seed the account + transaction
 * first). `status` defaults `'PLACED'` (the only status that counts toward `account.held`) and
 * `rail` to the constant outbound rail; `amount` defaults to `1000`. `expires_at` is NOT NULL with
 * no DB default, so it defaults to a moment in the FUTURE (the hold's TTL mirrors its transfer's).
 * `externalRef` / `settledAt` / `releasedAt` stay NULL unless set. Returns the inserted row
 * (RETURNING *).
 */
export interface InsertHoldOpts {
  id?: string;
  accountId: string;
  transactionId: string;
  amount?: number | string;
  status?: string;
  rail?: string;
  externalRef?: string | null;
  expiresAt?: Date;
  createdAt?: Date;
  settledAt?: Date | null;
  releasedAt?: Date | null;
}

/**
 * A `hold` row (all NOT-NULL-without-default columns defaulted). Only the keys set beyond the
 * defaults are written, so an unset `external_ref` / `created_at` / `settled_at` / `released_at`
 * keeps its DB default / NULL. Use it to seed a `PLACED` reservation for reconciliation assertions
 * (`SUM(PLACED) == account.held`) or a terminal (SETTLED / RELEASED / EXPIRED) hold. Returns the
 * inserted row (RETURNING *).
 */
export async function insertHold(q: any, opts: InsertHoldOpts): Promise<any> {
  const row: Record<string, unknown> = {
    account_id: opts.accountId,
    transaction_id: opts.transactionId,
    amount: opts.amount ?? 1000,
    status: opts.status ?? 'PLACED',
    rail: opts.rail ?? PAYEE_OUTBOUND_RAIL,
    expires_at: opts.expiresAt ?? new Date(Date.now() + 2 * 60 * 1000),
  };
  if (opts.id !== undefined) row.id = opts.id;
  if (opts.externalRef !== undefined) row.external_ref = opts.externalRef;
  if (opts.createdAt !== undefined) row.created_at = opts.createdAt;
  if (opts.settledAt !== undefined) row.settled_at = opts.settledAt;
  if (opts.releasedAt !== undefined) row.released_at = opts.releasedAt;
  return insertRow(q, 'hold', row);
}

/**
 * The sum of an account's PLACED holds, as node-postgres surfaces it (a decimal string for the
 * `bigint` SUM, `'0'` when there are none — `COALESCE`d). This is the left-hand side of the holds
 * reconciliation invariant `SUM(PLACED holds per account) == account.held`, which every commit of
 * a place / settle / release / expiry must preserve.
 */
export async function sumPlacedHolds(q: any, accountId: string): Promise<string> {
  const rows = await q.query(
    `SELECT COALESCE(SUM("amount"), 0)::text AS sum FROM "hold"
       WHERE "account_id" = $1 AND "status" = 'PLACED'`,
    [accountId],
  );
  return rows[0].sum as string;
}

/**
 * Read one account's materialized money caches (`balance` / `held`, both `bigint`-as-string) plus
 * its `status`, for reconciliation assertions around a hold place / settle / release. Returns
 * `null` when the id does not exist.
 */
export async function getAccount(
  q: any,
  id: string,
): Promise<{ id: string; balance: string; held: string; status: string } | null> {
  const rows = await q.query(
    `SELECT "id", "balance", "held", "status" FROM "account" WHERE "id" = $1`,
    [id],
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * All ledger legs of one transaction, oldest-first (`created_at ASC, id ASC`), as node-postgres
 * surfaces them (`delta` / `balance_after` are `bigint`-as-string). The proof seam for the money
 * paths: a **reconcile-only** rail SUCCESS writes NO legs for the settlement (so the original tx
 * keeps exactly the two legs its OTP-confirm settle wrote — none added), while a rail FAILURE
 * reversal / an inbound credit posts EXACTLY TWO legs summing to zero on the new transaction.
 */
export async function findLedgerByTx(q: any, txId: string): Promise<any[]> {
  return q.query(
    `SELECT "id", "transaction_id", "account_id", "delta", "balance_after", "currency", "created_at"
       FROM "ledger_entry" WHERE "transaction_id" = $1 ORDER BY "created_at" ASC, "id" ASC`,
    [txId],
  );
}

/**
 * The count of outbox rows a transaction emitted, as a number. Every money movement funnels
 * through the reducer, which writes EXACTLY ONE outbox row per posted transaction — so a
 * reconcile-only rail SUCCESS adds none to the original tx, while a reversal / inbound credit
 * yields `1` for its own (new) transaction id.
 */
export async function outboxCountForTx(q: any, txId: string): Promise<number> {
  const rows = await q.query(
    `SELECT COUNT(*)::int AS count FROM "outbox_event" WHERE "transaction_id" = $1`,
    [txId],
  );
  return rows[0].count as number;
}

// ---- Limits (spec 04 step 7) -----------------------------------------------------------------

/**
 * Options for {@link insertUserLimits} — a `user_limits` cap row. `scope` defaults to `'customer'`;
 * a `'global'` row MUST carry `ownerId: null` (that is the seeded baseline shape). `currency` FKs to
 * `currency` (default 'MXN', the migration-seeded code). Each cap is nullable — a NULL field is
 * uncapped for that dimension — and is a canonical minor-unit STRING (never a JS number, so int64
 * precision is preserved). The `uq_user_limits_scope (scope, owner_id)` unique is NULLS NOT DISTINCT,
 * so there is at most one global row and at most one customer row per owner.
 */
export interface InsertUserLimitsOpts {
  id?: string;
  scope?: 'global' | 'customer';
  ownerId?: string | null;
  currency?: string;
  perTransactionMax?: string | null;
  dailyMax?: string | null;
  monthlyMax?: string | null;
}

/**
 * A `user_limits` row (all NOT-NULL-without-default columns defaulted). Only the caps the caller
 * sets are written, so an unset `per_transaction_max` / `daily_max` / `monthly_max` stays NULL
 * (uncapped for that dimension). Seed a `customer`-scope row (with a tighter cap than the seeded
 * global baseline) to prove customer-override-wins resolution, or seed nothing and let the seeded
 * global row govern. Returns the inserted row (RETURNING *).
 */
export async function insertUserLimits(q: any, opts: InsertUserLimitsOpts = {}): Promise<any> {
  const row: Record<string, unknown> = {
    scope: opts.scope ?? 'customer',
    owner_id: opts.ownerId ?? null,
    currency: opts.currency ?? 'MXN',
  };
  if (opts.id !== undefined) row.id = opts.id;
  if (opts.perTransactionMax !== undefined) row.per_transaction_max = opts.perTransactionMax;
  if (opts.dailyMax !== undefined) row.daily_max = opts.dailyMax;
  if (opts.monthlyMax !== undefined) row.monthly_max = opts.monthlyMax;
  return insertRow(q, 'user_limits', row);
}

/** An account's fixed-window spend counters + window dates, plus `balance`/`held`. `spent_today` /
 * `spent_month` are `bigint`-as-string; the two `_date` fields are forced to ISO `YYYY-MM-DD`
 * strings (via `to_char`) so a test compares them directly against {@link TODAY}/{@link MONTH_START}
 * without a timezone-dependent Date coercion. Returns `null` when the id does not exist. */
export interface AccountCounters {
  balance: string;
  held: string;
  spent_today: string;
  spent_today_date: string;
  spent_month: string;
  spent_month_date: string;
}

export async function getAccountCounters(q: any, id: string): Promise<AccountCounters | null> {
  const rows = await q.query(
    `SELECT "balance", "held",
            "spent_today"::text AS spent_today,
            to_char("spent_today_date", 'YYYY-MM-DD') AS spent_today_date,
            "spent_month"::text AS spent_month,
            to_char("spent_month_date", 'YYYY-MM-DD') AS spent_month_date
       FROM "account" WHERE "id" = $1`,
    [id],
  );
  return rows.length > 0 ? (rows[0] as AccountCounters) : null;
}

/**
 * Directly overwrite an account's spend counters + window dates — the seam the LAZY-WINDOW-RESET
 * proof needs to plant `spent_today` near the cap with a `spent_today_date` in a PRIOR day (or a
 * `spent_month_date` in a PRIOR month), so the NEXT spend must zero-then-add off the DB clock. Only
 * the fields passed are written. Money values are canonical minor-unit STRINGS; dates are ISO
 * `YYYY-MM-DD` strings.
 */
export interface SetAccountSpendOpts {
  spentToday?: string;
  spentTodayDate?: string;
  spentMonth?: string;
  spentMonthDate?: string;
}

export async function setAccountSpendCounters(
  q: any,
  id: string,
  opts: SetAccountSpendOpts,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, v: unknown): void => {
    vals.push(v);
    sets.push(`"${col}" = $${vals.length}`);
  };
  if (opts.spentToday !== undefined) push('spent_today', opts.spentToday);
  if (opts.spentTodayDate !== undefined) push('spent_today_date', opts.spentTodayDate);
  if (opts.spentMonth !== undefined) push('spent_month', opts.spentMonth);
  if (opts.spentMonthDate !== undefined) push('spent_month_date', opts.spentMonthDate);
  if (sets.length === 0) return;
  vals.push(id);
  await q.query(`UPDATE "account" SET ${sets.join(', ')} WHERE "id" = $${vals.length}`, vals);
}
