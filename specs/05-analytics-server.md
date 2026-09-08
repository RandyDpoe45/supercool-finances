# Spec 05 — Analytics Server (CQRS read side)

**Purpose.** Consume the transaction event stream, maintain the MongoDB read
model, and serve reporting to the admin dashboard. Owns Mongo; has **no `/api`**
(customers never query it).

**Depends on.** [`01`](./01-storage.md), [`03`](./03-backend-foundation.md).
Consumes the event contract produced by [`04`](./04-balance-service.md).

## Moving parts & configuration

- **Stream consumer** — a Redis Streams **consumer group** on
  `events:transactions`: `XREADGROUP` → process → **upsert by `event_id`** into
  Mongo → `XACK`. Stuck entries recovered with `XPENDING` + `XCLAIM`. Ordering
  (write then ack) makes redelivery safe.
- **Idempotency** — unique index on `event_id`; the upsert dedups the at-least-once
  stream so a redelivered event is applied exactly once.
- **Read model (Mongo `analytics`)** — collections shaped for the dashboard, e.g.
  `transactions` (flattened), `dailyAggregates`, `accountSummaries`. Exact shape is
  driven by the admin screens (spec 07).
- **Reporting API (`/admin`)** — aggregate queries for the dashboard (volumes,
  totals, per-customer, time series). Role-based (admin) via the gateway.
- **`/internal/health`** — for the compose healthcheck.
- Networks: `app-internal` + `data` only (spec 00 §2) — unreachable from the
  public plane.

## Contracts / interfaces

- **Consumes** `libs/events` event contract (from the outbox).
- **Serves** reporting DTOs to the admin app via `/admin`.
- **Reads** Redis stream + writes Mongo; touches no other service's store.

## Definition of Done

- [ ] Publishing an event on `events:transactions` results in exactly one Mongo
      document, even when the event is redelivered.
- [ ] A consumer restart re-processes only un-acked entries (no loss, no dupes).
- [ ] An `/admin` analytics query returns correct aggregates over seeded data.
- [ ] The service is unreachable from `edge-public` / `app-public` (network check).

## Open questions

- The concrete aggregates/screens the admin dashboard needs — resolve alongside
  spec 07, since it defines the read-model shape.
