# Analytics Server — Stream Consumer (spec 05, step A2)

The read-model **business logic**: an in-process loop that consumes the transaction
event stream (`events:transactions`) from Redis, projects each event, and fills the
`transactions` read model ([`read-model.md`](./read-model.md), step A1). It has **no
controller** — the loop runs itself off `OnApplicationBootstrap`.

Contract of record: [`specs/DATA-MODEL.md`](../../../specs/DATA-MODEL.md) Part 2
("Consumer idempotency & ordering") and [`specs/analytics-schema.yaml`](../../../specs/analytics-schema.yaml).

## Where it lives

- `src/redis/` — the `@Global` `RedisModule` + `REDIS_CLIENT` token, a single
  lifecycle-managed ioredis client (mirrors the balance service). `lazyConnect`, a
  swallowing `'error'` handler, `maxRetriesPerRequest: null`; `quit()` on shutdown.
- `src/modules/consumer/` — module root holds only `consumer.module.ts`; logic under
  `service/interfaces/` (`STREAM_CONSUMER_SERVICE` token + `IStreamConsumerService`)
  and `service/impl/` (`stream-consumer.service.ts` + the pure `project-event.ts`).
- Imported **transitionally by `AppModule`** (service-only, like the balance service's
  relay) so the loop runs in the real service. `REDIS_CLIENT` / `APP_CONFIG` come from
  the global modules; `TRANSACTIONS_REPOSITORY` from `PersistenceModule`.

## The consumer group

- Stream key `events:transactions`, group `analytics`, consumer `analytics-consumer`.
- The consumer name is **stable** (not per-boot): a crashed consumer's un-acked
  pending entries survive a restart under the same name and are reclaimable by it.
- `ensureGroup()` runs once on bootstrap: `XGROUP CREATE … $ MKSTREAM`, swallowing
  `BUSYGROUP` (group already exists) as a no-op. `$` = deliver only entries added
  after the group is created (no historical replay); `MKSTREAM` creates the stream
  if the producer has not XADDed yet. It is idempotent — safe to call repeatedly.

## Exactly-once effect: write-then-ack + idempotent upsert

Per entry: parse the three stream fields (`event_id`, `event_type`, `payload`) →
**project** → **`upsertByEventId`** → **then `XACK`**.

- **Write-then-ack is mandatory.** The upsert MUST succeed before the ack. A crash
  between the two leaves the entry pending; it is later reclaimed and re-upserted.
  Because the upsert is keyed on `_id = event_id`, re-applying the same event yields
  **exactly one** document. So at-least-once delivery + an idempotent upsert = an
  **exactly-once effect** (spec 05 DoD). We never ack before the write.
- `XACK` uses the **stream entry id** (e.g. `1699…-0`), which is distinct from the
  `event_id` field (the read-model `_id`).

## Two reads per pass: recovery first, then new

`consumeOnce({ claimMinIdleMs? })` (the test seam) and each live tick do, in order:

1. **Recovery — `XAUTOCLAIM`.** `events:transactions analytics analytics-consumer
   <minIdle> 0 COUNT 100`. Reclaims idle un-acked entries (a crashed consumer's PEL,
   now idle) to this consumer and processes them. This is the **"a restart
   re-processes only un-acked entries (no loss, no dupes)"** guarantee: only entries
   that were never acked are still pending; reclaiming + the idempotent upsert means
   no loss and no duplicates. `claimMinIdleMs` defaults to `60000` (live loop); tests
   pass `0` to reclaim immediately. Reclaiming resets an entry's idle clock, so a
   still-unprocessable entry is not hammered every pass.
2. **New — `XREADGROUP '>'`.** Reads never-delivered entries (up to `COUNT 100`).
   `consumeOnce` reads **non-blocking**; the **live loop** uses `BLOCK 5000` so an idle
   stream is not busy-polled (the block itself paces the loop).

`consumeOnce` returns the number of entries **successfully processed** (upserted +
acked); malformed entries (left unacked) are not counted.

## Malformed entries — the poison-pill trade-off

If one entry is unparseable (bad JSON, a missing/wrong-typed field, an unparseable
money/date — `projectEvent` throws `MalformedEventError`), the consumer **logs an
error with the entry's stream id and `event_id` and does NOT ack it**, then continues
the rest of the batch. It is **left pending** for reclaim/inspection.

- **Why not drop it:** dropping a transaction event silently would violate money
  safety (a transaction vanishes from the read model). Leaving it pending keeps it
  visible (`XPENDING`) and recoverable.
- **The trade-off:** a genuinely un-projectable ("poison") entry is re-reclaimed
  every `claimMinIdleMs` and re-logged forever until a human intervenes (fixes the
  data or `XACK`/`XDEL`s it). We accept a noisy, bounded re-log over silent data loss.
  Reclaim resets the idle clock, so the re-log cadence is `claimMinIdleMs`, not tight.

A **transient infra** failure is different from a poison pill: if the **upsert**
throws (e.g. Mongo down), that is NOT caught per-entry — it propagates, the pass ends,
the entry stays pending (unacked), and the loop backs off and retries. Only *data*
defects are treated as poison pills; *infra* defects just retry.

## Lifecycle & the loop

Mirrors the balance service's relay loop: a self-rescheduling `setTimeout` chain (not
`setInterval`, so ticks never overlap), with `stopped` / `timer` / `activeTick`.

- `onApplicationBootstrap` — **when disabled** (`ANALYTICS_CONSUMER_ENABLED=false`) it
  logs and returns, touching Redis NOT AT ALL (so the lazy client never dials, and
  booting AppModule without Redis — the default unit/e2e/Mongo-only test path — neither
  hangs nor throws); **when enabled** it `await ensureGroup()` then starts the loop. All
  Redis interaction is gated behind the flag, exactly like the balance service's relay.
  `ensureGroup()` remains a public, idempotent seam the integration suite calls directly.
- Each tick swallows Redis/infra errors (logs them) so a blip never crashes the loop
  or process. On success it reschedules immediately (the block paced an idle stream, a
  backlog drains fast); on error it backs off `BLOCK_MS` to avoid a hot error loop.
- `onModuleDestroy` → set `stopped`, clear the timer, and await the in-flight tick
  (its blocking read can be waiting up to `BLOCK_MS`). Uses `OnModuleDestroy` (fires on
  `app.close()` without `enableShutdownHooks()`), the same reasoning as the relay.

## Config

- `ANALYTICS_CONSUMER_ENABLED` (env, boolean, default `true`) — the only env knob; the
  same explicit `'true'`/`'false'` parse the relay uses (avoids `Boolean('false')` ===
  true). Exposed as `AppConfig.consumer.enabled`.
- Group/consumer names, `READ_COUNT` (100), `BLOCK_MS` (5000), `CLAIM_MIN_IDLE_MS`
  (60000) are **code constants** in the impl, not env — they are not per-deployment.

## Projection (`project-event.ts`)

A **pure** function `projectEvent(eventId, eventType, payloadJson)` →
`TransactionReadModel`, unit-testable without Redis/Mongo. It carries the consumer's
**own copy** of the wire contract (ADR-16 — never imports balance-service), a local
`TransactionEventPayload` (camelCase, per DATA-MODEL Part 2 — the snake_case block in
`analytics-schema.yaml` was stale and has been corrected). It:

- maps `_id = eventId`, `eventType`, and the `transaction.*` header fields;
- parses money **strings → `bigint`** (`amount`, each leg's `delta` / `balanceAfter`)
  with `BigInt()`, which throws loudly on a non-integer string;
- derives `owners` = the distinct non-null `legs[].ownerId`;
- captures **`failureReason`** = `transaction.failureReason` (`null` on a posted event)
  — added to the read model here, since A2 is where failed events first land (see the
  `failureReason` row in [`read-model.md`](./read-model.md));
- validates the shape and **throws `MalformedEventError`** on any defect, so the caller
  leaves the entry unacked (never silently mis-projected).
