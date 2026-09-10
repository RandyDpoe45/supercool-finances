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

// ---- Outbox + relay worker (spec 04 step 6) --------------------------------------------------

/**
 * Options for {@link insertOutboxRow} — one `outbox_event` row the relay-worker suite seeds to
 * drive `drainOnce()`. `transactionId` is REQUIRED: `outbox_event.transaction_id` is NOT NULL with
 * an FK to `transaction` (`fk_outbox_transaction`), so seed a `transaction` first (via
 * {@link insertTransaction}). `payload` is written to the `jsonb` column (JSON-stringified so
 * Postgres parses it back into jsonb and the read-back deep-equals the original). `createdAt`
 * accepts a JS `Date` so the ORDERING proof can seed rows with distinct creation instants
 * (the relay drains oldest-first, `ORDER BY created_at`). `publishedAt` stays NULL (unpublished —
 * the drainable state) unless set to a `Date` (already published — must NOT be re-drained). `id`
 * (the `event_id` the stream carries + the analytics dedup key) defaults to a DB-generated uuid.
 */
export interface InsertOutboxRowOpts {
  id?: string;
  transactionId: string;
  eventType?: string;
  payload?: Record<string, unknown>;
  createdAt?: Date;
  publishedAt?: Date | null;
}

/**
 * An `outbox_event` row. Returns the inserted row (RETURNING *) — `id` is the `event_id` the relay
 * publishes. Only the keys the caller sets beyond the defaults are written, so an unset
 * `created_at` keeps the `now()` DB default and an unset `published_at` stays NULL (unpublished).
 */
export async function insertOutboxRow(q: any, opts: InsertOutboxRowOpts): Promise<any> {
  const payload = opts.payload ?? { kind: 'test.event', at: new Date().toISOString() };
  const row: Record<string, unknown> = {
    transaction_id: opts.transactionId,
    event_type: opts.eventType ?? 'transaction.posted',
    // jsonb column: pass a JSON STRING so Postgres parses text → jsonb (the read-back is a parsed
    // object that deep-equals the original), instead of relying on driver object coercion.
    payload: JSON.stringify(payload),
  };
  if (opts.id !== undefined) row.id = opts.id;
  if (opts.createdAt !== undefined) row.created_at = opts.createdAt;
  if (opts.publishedAt !== undefined) row.published_at = opts.publishedAt;
  return insertRow(q, 'outbox_event', row);
}

/**
 * Read one `outbox_event` row by id (the `event_id`) for relay assertions — its `event_type`,
 * the parsed `payload` (jsonb → JS object), and crucially `published_at` (NULL until the relay
 * has drained it; a set value proves the mark step ran). Returns `null` when the id does not
 * exist. The single seam a relay test uses to assert "the row is (not) marked published".
 */
export async function getOutboxRow(
  q: any,
  id: string,
): Promise<{
  id: string;
  transaction_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
  published_at: Date | null;
} | null> {
  const rows = await q.query(
    `SELECT "id", "transaction_id", "event_type", "payload", "created_at", "published_at"
       FROM "outbox_event" WHERE "id" = $1`,
    [id],
  );
  return rows.length > 0 ? rows[0] : null;
}

/** Count the still-unpublished (`published_at IS NULL`) outbox rows among a set of ids — the
 * left-hand side of the relay's at-least-once invariant: after a successful drain every claimed
 * row is marked (count 0); after a FAILED publish tick the row survives UNMARKED (count > 0). */
export async function countUnpublishedOutbox(q: any, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await q.query(
    `SELECT COUNT(*)::int AS count FROM "outbox_event"
       WHERE "id" = ANY($1) AND "published_at" IS NULL`,
    [ids],
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

// ---- Admin ops + audit foundation (spec 04 step 8a) ------------------------------------------

/** Read one account's `status` (`'active'` | `'frozen'`) — the seam the freeze/unfreeze proofs use
 * to assert the flip committed (and, on a missing-account freeze, that NOTHING changed). Returns
 * `null` when the id does not exist. */
export async function getAccountStatus(q: any, id: string): Promise<string | null> {
  const rows = await q.query(`SELECT "status" FROM "account" WHERE "id" = $1`, [id]);
  return rows.length > 0 ? (rows[0].status as string) : null;
}

/** A filter for {@link getAuditRows} / {@link countAuditRows} — any subset narrows the match. */
export interface AuditRowFilter {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
}

/**
 * All `audit_log` rows matching the given filter, oldest-first (`id ASC`, the DB-generated
 * append-only order). `metadata` is the parsed jsonb (JS object) — the seam the "before/after"
 * proofs read to assert the recorded change. Every mutating admin action writes EXACTLY one row;
 * a read writes none. Empty filter → every row (used only for a full-table sanity count in a test
 * that has scoped the DB to its own actor). Money values inside `metadata` are whatever the service
 * stored (canonical minor-unit strings); `actor_id` / `action` / `target_type` / `target_id` are the
 * columns the whitelist proof gates on.
 */
export async function getAuditRows(
  q: any,
  filter: AuditRowFilter = {},
): Promise<
  Array<{
    id: string;
    actor_id: string;
    action: string;
    target_type: string | null;
    target_id: string | null;
    metadata: Record<string, unknown> | null;
    created_at: Date;
  }>
> {
  const where: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, v: unknown): void => {
    vals.push(v);
    where.push(`"${col}" = $${vals.length}`);
  };
  if (filter.actorId !== undefined) push('actor_id', filter.actorId);
  if (filter.action !== undefined) push('action', filter.action);
  if (filter.targetType !== undefined) push('target_type', filter.targetType);
  if (filter.targetId !== undefined) push('target_id', filter.targetId);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return q.query(
    `SELECT "id", "actor_id", "action", "target_type", "target_id", "metadata", "created_at"
       FROM "audit_log" ${clause} ORDER BY "id" ASC`,
    vals,
  );
}

/** The count of `audit_log` rows matching the filter, as a number — the left-hand side of
 * "exactly one row per mutating admin action" and "a read writes NONE". */
export async function countAuditRows(q: any, filter: AuditRowFilter = {}): Promise<number> {
  return (await getAuditRows(q, filter)).length;
}

/** Delete every `audit_log` row written by any of the given actor ids — best-effort per-test
 * cleanup (audit_log has NO FK to account/transaction — `(target_type, target_id)` is a
 * polymorphic pointer — so it is not swept by the account/tx cascade). */
export async function deleteAuditRowsByActor(q: any, actorIds: string[]): Promise<void> {
  if (!actorIds.length) return;
  await q.query(`DELETE FROM "audit_log" WHERE "actor_id" = ANY($1)`, [actorIds]);
}

/**
 * The single `user_limits` row for an exact `(scope, owner_id)` key (a `global` row has
 * `owner_id` NULL — pass `ownerId: null`), or `null`. The seam the PUT /limits upsert semantics
 * proof reads to assert an UPDATE reused the SAME row (not a duplicate insert) and to read back the
 * caps. Caps are `bigint`-as-string (or `null` = uncapped). Because `uq_user_limits_scope
 * (scope, owner_id)` is NULLS-NOT-DISTINCT there is at most one such row.
 */
export async function getUserLimitsExact(
  q: any,
  key: { scope: 'global' | 'customer'; ownerId?: string | null; currency?: string },
): Promise<{
  id: string;
  scope: string;
  owner_id: string | null;
  currency: string;
  per_transaction_max: string | null;
  daily_max: string | null;
  monthly_max: string | null;
} | null> {
  const ownerId = key.ownerId ?? null;
  const ownerClause = ownerId === null ? `"owner_id" IS NULL` : `"owner_id" = $2`;
  const vals: unknown[] = [key.scope];
  if (ownerId !== null) vals.push(ownerId);
  const rows = await q.query(
    `SELECT "id", "scope", "owner_id", "currency",
            "per_transaction_max", "daily_max", "monthly_max"
       FROM "user_limits" WHERE "scope" = $1 AND ${ownerClause}`,
    vals,
  );
  return rows.length > 0 ? rows[0] : null;
}

/** Count the `user_limits` rows for an exact `(scope, owner_id)` key — the tripwire proving a
 * second upsert UPDATED the existing row rather than inserting a duplicate (count stays 1). */
export async function countUserLimitsExact(
  q: any,
  key: { scope: 'global' | 'customer'; ownerId?: string | null },
): Promise<number> {
  const ownerId = key.ownerId ?? null;
  const ownerClause = ownerId === null ? `"owner_id" IS NULL` : `"owner_id" = $2`;
  const vals: unknown[] = [key.scope];
  if (ownerId !== null) vals.push(ownerId);
  const rows = await q.query(
    `SELECT COUNT(*)::int AS count FROM "user_limits" WHERE "scope" = $1 AND ${ownerClause}`,
    vals,
  );
  return rows[0].count as number;
}

// ---- Maker-checker + reversals (spec 04 step 8b) ---------------------------------------------

/**
 * Options for {@link insertApprovalRow} — one `approval_request` row seeded DIRECTLY (bypassing the
 * service's best-effort propose-time duplicate guard) so a suite can construct the TOCTOU the guard
 * admits: TWO live PENDING approvals for the SAME target, proposed by DIFFERENT makers. `payload` is
 * NOT NULL jsonb (defaults to `{}`); `actionType` defaults to the `'reversal'` enum label and
 * `status` to `'PENDING'`. `checkerId` MUST differ from `makerId` when set (the DB CHECK
 * `chk_approval_four_eyes` fires otherwise). `targetTransactionId` FKs `transaction` — seed the
 * target first.
 */
export interface InsertApprovalRowOpts {
  id?: string;
  actionType?: string;
  status?: string;
  makerId: string;
  checkerId?: string | null;
  targetTransactionId: string;
  payload?: Record<string, unknown>;
  createdAt?: Date;
}

/**
 * An `approval_request` row (NOT-NULL-without-default columns defaulted). Returns the inserted row
 * (RETURNING *). `payload` is written as a JSON STRING so Postgres parses text → jsonb. Only the keys
 * set beyond the defaults are written, so an unset `checker_id` / `created_at` keeps its DB default /
 * NULL.
 */
export async function insertApprovalRow(q: any, opts: InsertApprovalRowOpts): Promise<any> {
  const row: Record<string, unknown> = {
    action_type: opts.actionType ?? 'reversal',
    status: opts.status ?? 'PENDING',
    maker_id: opts.makerId,
    target_transaction_id: opts.targetTransactionId,
    payload: JSON.stringify(opts.payload ?? {}),
  };
  if (opts.id !== undefined) row.id = opts.id;
  if (opts.checkerId !== undefined) row.checker_id = opts.checkerId;
  if (opts.createdAt !== undefined) row.created_at = opts.createdAt;
  return insertRow(q, 'approval_request', row);
}

/**
 * Read one `approval_request` row by id — the seam the maker-checker proofs use to assert the
 * four-eyes lifecycle committed: `status` (PENDING → EXECUTED / REJECTED), `checker_id` (NULL until a
 * checker decides; the DB backstops `checker_id <> maker_id`), `maker_id`, `target_transaction_id`
 * (the transaction being reversed), and the `decided_at` / `executed_at` timestamps. Returns `null`
 * when the id does not exist. `action_type` / `status` are the native-enum text labels.
 */
export async function getApprovalRow(
  q: any,
  id: string,
): Promise<{
  id: string;
  action_type: string;
  status: string;
  maker_id: string;
  checker_id: string | null;
  target_transaction_id: string | null;
  created_at: Date;
  decided_at: Date | null;
  executed_at: Date | null;
} | null> {
  const rows = await q.query(
    `SELECT "id", "action_type", "status", "maker_id", "checker_id", "target_transaction_id",
            "created_at", "decided_at", "executed_at"
       FROM "approval_request" WHERE "id" = $1`,
    [id],
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * All `approval_request` rows targeting a given transaction, oldest-first — the tripwire the
 * "second reverse-proposal is rejected" proof reads (a target that already has a PENDING/EXECUTED
 * approval must never accrue a second live one) and the concurrency keystone reads (exactly ONE
 * approval, and it ends EXECUTED, no matter how many checkers race).
 */
export async function getApprovalsByTarget(
  q: any,
  targetTransactionId: string,
): Promise<Array<{ id: string; status: string; maker_id: string; checker_id: string | null }>> {
  return q.query(
    `SELECT "id", "status", "maker_id", "checker_id" FROM "approval_request"
       WHERE "target_transaction_id" = $1 ORDER BY "created_at" ASC, "id" ASC`,
    [targetTransactionId],
  );
}

/**
 * The compensating transactions that reverse a given original (`reverses_transaction_id` = orig) —
 * oldest-first. The keystone money-safety seam: a correct reversal yields EXACTLY ONE such row
 * (POSTED, linked to the original), whatever concurrency or replay it faced; two would be a
 * double-reversal (money created). `type` / `status` are the native-enum text labels.
 */
export async function getReversalTxsFor(
  q: any,
  originalTransactionId: string,
): Promise<Array<{ id: string; status: string; type: string; reverses_transaction_id: string }>> {
  return q.query(
    `SELECT "id", "status", "type", "reverses_transaction_id" FROM "transaction"
       WHERE "reverses_transaction_id" = $1 ORDER BY "created_at" ASC, "id" ASC`,
    [originalTransactionId],
  );
}

/** Read one transaction's `status` (`PENDING` | `POSTED` | `REVERSED` | …) — the seam the reversal
 * proofs use to assert the guarded `POSTED → REVERSED` flip committed (or, on a rejected/blocked
 * path, that NOTHING changed). Returns `null` when the id does not exist. (The harness
 * `getTransactionStatus()` resolves the enum type; this reads a row's value from the DB — different
 * modules, no collision.) */
export async function getTransactionStatus(q: any, id: string): Promise<string | null> {
  const rows = await q.query(`SELECT "status" FROM "transaction" WHERE "id" = $1`, [id]);
  return rows.length > 0 ? (rows[0].status as string) : null;
}

/** Delete every `approval_request` row targeting any of the given transaction ids — best-effort
 * per-test cleanup that MUST run BEFORE the transactions it points at are deleted (the
 * `fk_approval_target_transaction` FK). */
export async function deleteApprovalsByTarget(
  q: any,
  targetTransactionIds: string[],
): Promise<void> {
  if (!targetTransactionIds.length) return;
  await q.query(`DELETE FROM "approval_request" WHERE "target_transaction_id" = ANY($1)`, [
    targetTransactionIds,
  ]);
}
