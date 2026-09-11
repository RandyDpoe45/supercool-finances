# Analytics Server — Reporting API (spec 05, step A3)

The `/admin` dashboard aggregates over the Mongo read model — the query side of the
CQRS read model. Two query-time aggregation VIEWs over the single stored
[`transactions`](./read-model.md) collection; **nothing is materialized**.

Contract of record: [`specs/DATA-MODEL.md`](../../../specs/DATA-MODEL.md) Part 2 (the
`accountSummaries` / `dailyAggregates` shapes and the *Aggregation strategy —
query-time, everywhere* decision) and [`specs/05-analytics-server.md`](../../../specs/05-analytics-server.md).

## Endpoints (role-gated `/admin`)

Both are pure **reads** on the admin plane. The analytics server has **no `/api`**
(customers never query it, ADR-12), and the global `GatewayIdentityGuard` requires a
gateway-injected `X-User-Id` **and** the `admin` role in `X-Roles` (else 401/403), so
these aggregates are **unreachable from the public plane**. Query strings are validated
by the shared `ZodValidationPipe` (`.strict()` — unknown keys -> 400).

### `GET /admin/reports/account-summaries`

Per-account activity + latest known balance (`accountSummaries` VIEW). Optional filters:

| Param | Type | Effect |
|---|---|---|
| `ownerId` | string | Restrict to legs owned by this customer `sub`. |
| `accountId` | uuid | Restrict to one account. |
| `currency` | string | Restrict to one currency. |
| `limit` | int >=0 | Page size — **clamped** (default 50, min 1, max 200). |
| `offset` | int >=0 | Page offset (floored to >=0). |

Response `200`: `{ accountSummaries: AccountSummaryDto[] }`. Each row:
`{ accountId, ownerId (string|null), accountKind, systemKey (string|null), currency,
lastBalanceAfter (string), txnCount (number), totalDebited (string),
totalCredited (string), lastActivityAt (ISO string) }`.

### `GET /admin/reports/daily-aggregates`

Per-day x currency x type volume/count (`dailyAggregates` VIEW). Optional filters:

| Param | Type | Effect |
|---|---|---|
| `currency` | string | Restrict to one currency. |
| `type` | `internal` \| `external_outbound` \| `external_inbound` | Restrict to one type. |
| `from` | date | Inclusive lower bound — start of the `from` UTC calendar day (`$gte`). |
| `to` | date | Inclusive upper bound — the **whole** `to` UTC calendar day is included. |
| `limit` / `offset` | int >=0 | Paging — same clamp as above. |

Response `200`: `{ dailyAggregates: DailyAggregateDto[] }`. Each row:
`{ date (YYYY-MM-DD, UTC), currency, type, count (number), totalAmount (string) }`.

**`from` / `to` are inclusive UTC calendar days** — the same granularity as the
`%Y-%m-%d` UTC output buckets and the admin app's A5 dashboard date-range filter. The
wire contract stays day strings; the schema's `z.coerce.date()` parses e.g. `"2026-03-02"`
to that day's UTC midnight, so the repository snaps `from` to the start of its UTC day
(`$gte`) and expands `to` to the **start of the next UTC day** (`$lt`), which fully
includes the `to` day. (A naive `$lte` on the coerced midnight would drop the entire `to`
day — an exclusive-end-date bug.) This aligns the server with the admin app's A5
date-range filter and its MSW stub — both already treat `to` as inclusive of the whole
day — so **no client change is needed**.

## Query-time pipelines (no materialized rollups)

Every figure is recomputed from the deduped source docs (`_id = event_id`) at request
time, so a redelivered event can **never** double-count — the aggregates are
**idempotent by construction**. There is no rollup collection to keep consistent and no
backfill; a new report is a new pipeline, not a migration.

- **`accountSummaries`** — `$unwind '$legs'` -> `$match` (the leg-level filters, when
  present: `legs.currency` / `legs.ownerId` / `legs.accountId`) -> `$sort occurredAt asc`
  -> `$group` on `legs.accountId` (`$last balanceAfter` = latest known balance, `$sum`
  the debit/credit magnitudes, `$max occurredAt`) -> `$sort lastActivityAt desc, _id asc`
  -> `$skip`/`$limit`. **FAILED events carry empty `legs`, so they drop out of `$unwind`
  naturally** and are never counted here — a summary reflects only money that moved.
- **`dailyAggregates`** — `$match { status: 'POSTED', ...optional filters, occurredAt
  range }` -> `$group` on `{ date (UTC %Y-%m-%d), currency, type }` (`$sum 1`,
  `$sum '$amount'`) -> `$sort date desc, currency asc, type asc` -> `$skip`/`$limit`.

### v1 status scope (a defensible v1)

- `dailyAggregates` is **POSTED-only**: the money-volume view counts *settled* money,
  excluding FAILED attempts (no money moved). **Reversals ARE counted here.** A reversal
  is emitted as a compensating `transaction.posted` (`status: POSTED`, `reversesTransactionId`
  set) — there is NO separate `transaction.reversed` event and NO `REVERSED` document
  (reversal is link-only, DATA-MODEL Part 2), so the `status: 'POSTED'` filter does not
  exclude it: a reversed transaction's original post AND its compensating post both
  contribute, making this a **gross** movement volume. A net-of-reversals view (a
  `reversesTransactionId: null` predicate, or netting the pair) is a spec-07 refinement.
- `accountSummaries` is **FAILED-excluded** by construction (empty legs).
- **Latest-balance tiebreak (v1 limitation):** `accountSummaries` orders by `occurredAt`
  asc so `$last balanceAfter` is the latest known balance. The read model carries no
  total-order field (`_id` is a random event uuid, not time-ordered), so if two events on
  one account share an identical `occurredAt`, which one wins `$last` is not deterministic.
  Harmless at prototype volumes; a stream-sequence field would resolve it if ever needed.
- **Per-status / per-failure-reason reporting** (e.g. failure-rate by `failureReason`,
  reversal volumes) is a **spec-07 extension**: `status` and `failureReason` are carried
  on every document, so it is a new pipeline, not a schema change. The exact dashboard
  fields are a spec-07 open question; these shapes are the DATA-MODEL "defensible v1".

## Money on the wire

Money is stored as BSON `Long` (int64). The `.aggregate()` path **bypasses** the
schema's `BigInt` hydration, so the repository converts each aggregated money value
`Long -> bigint` explicitly (`toBigInt`) — the domain result (`AccountSummary` /
`DailyAggregate`) carries money as **`bigint`**, exact past 2^53, never a JS float.
The serializer emits it as a **string** (int64 minor units, matching the event wire
convention) — `lastBalanceAfter`, `totalDebited`, `totalCredited`, `totalAmount`. Counts
(`txnCount`, `count`) are safe as `number`.

## Layering

`modules/reporting/` follows the interface/impl split and the layering rules:

- **Repository** (`database/repositories/{interfaces,impl}/reporting.repository.*`) —
  the aggregation pipelines, bound to the `REPORTING_REPOSITORY` token in
  `PersistenceModule`, sharing the one `Transaction` model with the A1/A2
  `TRANSACTIONS_REPOSITORY`. Returns domain rows (money `bigint`).
- **Service** (`modules/reporting/service/{interfaces,impl}`) — `REPORTING_SERVICE`
  token; **clamps paging** (default 50 / max 200 / offset >=0) so an over-large page can
  never scan unbounded, then delegates. Returns domain objects — shapes no wire response.
- **Controller** (`modules/reporting/admin/reporting-admin.controller.ts`) — validates
  the query (`ZodValidationPipe`), calls the service, and serializes the domain result to
  the wire DTO with **explicit whitelist** serializers (`serializeAccountSummary` /
  `serializeDailyAggregate`) that list every field by hand — never spread.
