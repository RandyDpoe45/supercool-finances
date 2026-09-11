# Analytics Server — Read Model (spec 05, storage layer / step A1)

The persistence layer of the CQRS read side: the single stored Mongo collection,
its idempotent-upsert repository, and the money representation. The stream
**consumer** that fills it (Redis client + projection) is **step A2**; the
**reporting aggregates** are **step A3**. This document covers only what A1 builds.

Contract of record: [`specs/DATA-MODEL.md`](../../../specs/DATA-MODEL.md) Part 2 and
[`specs/analytics-schema.yaml`](../../../specs/analytics-schema.yaml).

## One stored collection, everything else query-time

The read model is **one stored collection**, `transactions` — a flattened,
append-only projection of the transaction event stream (`events:transactions`),
**one document per event** (a posting and its later reversal are two documents, a
faithful money history). It is **self-contained / denormalized**: no relations, no
joins, and it never touches Postgres.

**All** dashboard figures — account summaries, daily aggregates, any future
dashboard — are **query-time aggregation pipelines** over `transactions`. There are
**no materialized rollups**: nothing to keep consistent, and — because the source
docs are deduped by `_id = event_id` — figures are **idempotent by construction**
(a redelivered event can never double-count). `accountSummaries` (`$group` on
`legs.accountId`) and `dailyAggregates` (`$group` on day × currency × type) are
reference pipeline outputs, **not** stored collections; their exact shapes firm up
with the admin screens (A3 / spec 07).

## `transactions` document (collection: `transactions`)

`versionKey: false`. `_id` is the `event_id` (a uuid string set explicitly on
upsert, **not** an auto-generated ObjectId).

| Field | Type | Notes |
|---|---|---|
| `_id` | `string` (uuid) | The `event_id` (= `outbox_event.id` from the balance service). The idempotent-upsert **dedup key**. |
| `transactionId` | `string` (uuid) | Source transaction id. Multiple events (posted, then reversed) can share it. |
| `eventType` | `string` | `transaction.posted` \| `transaction.reversed` \| `transaction.failed`. |
| `type` | `string` | `internal` \| `external_outbound` \| `external_inbound`. |
| `status` | `string` | `POSTED` \| `REVERSED` \| `FAILED` at the moment of this event. |
| `amount` | **`bigint` → BSON `Long`** | Positive magnitude, minor units. See *Money* below. |
| `currency` | `string` | ISO currency code. |
| `initiatedBy` | `string` | Keycloak `sub` (customer) or admin `sub` that initiated it. |
| `reversesTransactionId` | `string \| null` | For a reversal, the transaction it compensates; `null` otherwise. Default `null`. |
| `payee` | `{ id; displayName; rail } \| null` | External beneficiary (external_outbound); `null` otherwise. Sub-doc, no own `_id`. Default `null`. |
| `legs[]` | `array<object>` | Double-entry legs; `SUM(delta) == 0`. Sub-doc, no own `_id`. Each: `accountId` (string), `ownerId` (string\|null), `accountKind` (string), `systemKey` (string\|null), `delta` (**`bigint`→`Long`**), `balanceAfter` (**`bigint`→`Long`**), `currency` (string). |
| `owners[]` | `array<string>` | Distinct customer `ownerId`s across the legs — per-customer filter/index helper. Default `[]`. |
| `occurredAt` | `Date` | Event time (from the event's `occurred_at`, UTC). |

### Indexes

Declared on the schema (registered on boot via `MongooseModule.forFeature`):

- **unique `{ _id }`** — automatic (the primary key); the **event-dedup / exactly-once gate**.
- `{ transactionId: 1 }`
- `{ occurredAt: -1 }` — time series / recent-first history.
- `{ owners: 1, occurredAt: -1 }` — per-customer history.
- `{ type: 1, occurredAt: -1 }` — per-type time series.
- `{ 'legs.accountId': 1 }` — multikey, per-account `$group`.

## Money as Mongo `Long` (exact int64)

Money is stored as BSON **`Long`** (int64) minor units, via the Mongoose **`BigInt`**
SchemaType (`amount`, `legs[].delta`, `legs[].balanceAfter`). Mongoose 8 maps a JS
`bigint` → BSON `Long` on write and casts it back to a `bigint` on hydration —
**exact past 2^53** and directly aggregatable (`$sum`). This is why the read side
stores `Long`, not the wire string:

- **Wire vs. stored.** The transaction **event** carries money as a **string**
  (int64 minor units) — the wire contract is unchanged. The consumer (A2) **parses
  that string into a `bigint`**, which this layer persists as a `Long`.
- **Why `Long` and not string:** the query-time views output **numeric**
  `totalAmount` / `lastBalanceAfter`, which need `$sum` over an exact integer type.
  A string can't be summed; a `double` would lose precision past 2^53. `Long` is
  both exact and aggregatable.
- **Never float.** The value is carried verbatim from the ledger, never re-derived,
  never floated.

The repository keeps money as `bigint` end to end: reads hydrate the document (not
`.lean()`), so the `BigInt` SchemaType returns `bigint`, and are then whitelist-mapped
to the read model — a Mongoose document is never leaked.

## Repository — idempotent upsert (interface behind a token)

`database/repositories/interfaces/transactions.repository.interface.ts` defines the
`TRANSACTIONS_REPOSITORY` Symbol token, the ODM-independent `TransactionReadModel`
(money as `bigint`), and `ITransactionsRepository`; the Mongoose implementation is
`database/repositories/impl/transactions.repository.ts`, bound in
`database/persistence.module.ts`. Consumers inject the **interface via the token**,
never the concrete class.

- **`upsertByEventId(doc)`** — the idempotent upsert keyed on `_id` (`{ _id }`,
  `upsert: true`, `$set` the rest). Because `_id = event_id`, re-applying the **same
  event** targets the same document and yields **exactly one** — the exactly-once
  gate the spec 05 DoD requires, safe under at-least-once stream redelivery. This is
  the consumer's **only** write, run before `XACK` (write-then-ack).
- **`findById(eventId)`** — reads one document back, mapped to `TransactionReadModel`
  (money as `bigint`), or `null`. Useful to A2/A3 and tests.

### Consumer flow (A2, for context)

`XREADGROUP` → **`upsertByEventId`** → `XACK`. Stuck entries are recovered with
`XPENDING` + `XCLAIM`. Standalone Mongo is sufficient: a single idempotent write,
no rollups to keep consistent, no multi-document transaction needed.

## Redis config (client lands in A2)

Redis is the transport the consumer reads (`events:transactions`). As of this step
the connection config is **declared and required** — `REDIS_HOST` / `REDIS_PORT`
(default 6379) / `REDIS_PASSWORD` in `config/env.schema.ts`, composed into a
`RedisConfig` (`host`, `port`, `password`, and a URL-encoded
`redis://:<pw>@<host>:<port>` `url`) in `config/configuration.ts`. This supersedes
the foundation's "Mongo-only / Redis absent" note. The compose service maps the
root discrete creds into these names.

The Redis **client**, the consumer group, and the `data`-network + `depends_on:
redis` compose wiring arrive with the **A2 consumer** — A1 only makes the config
present so the service still boots with the now-required vars.
