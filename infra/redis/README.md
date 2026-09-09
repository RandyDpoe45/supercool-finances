# Redis — storage provisioning (spec 01)

Single `redis:7` instance on the `data` network only, never host-published. Owned
by the balance service (ADR-11), it serves two roles: **OTP codes** and the
**Redis Streams** transport for the outbox relay.

## AUTH

`requirepass` is enabled. The password is **not** written to any committed file:
it is injected into the container command by compose as
`--requirepass ${REDIS_PASSWORD}`, substituted from the git-ignored `.env`.

The healthcheck is a bare `redis-cli ping`. With `requirepass` set, an
unauthenticated `ping` returns `NOAUTH` and the container would flap *unhealthy*,
so the container environment sets `REDISCLI_AUTH=${REDIS_PASSWORD}` — `redis-cli`
reads that automatically and authenticates without putting the secret on the
command line.

## Persistence (AOF) — load-bearing

`redis.conf` (committed, non-secret) sets `appendonly yes`, `appendfsync
everysec`, and `dir /data`; the AOF is stored on the `redis-data` volume. Per spec
01's *Resolved* decision, persistence is **load-bearing, not optional**: the
outbox → Redis Stream relay marks an outbox row *published* right after `XADD`, so
a wiped stream would drop in-flight events the relay never re-publishes, breaking
the "never lost" guarantee (`../../docs/ARCHITECTURE.md` §7). OTP durability is a
harmless side effect — codes stay TTL-bound.

## Key-space convention (owned by the balance service later)

Nothing to configure at the container level; documented here as the contract:

| Key                    | Purpose                                            |
|------------------------|----------------------------------------------------|
| `otp:<sub>`            | Transaction step-up code — **one active per user** (user-scoped), TTL-managed, single-use |
| `events:transactions`  | Redis Stream carrying outbox events to analytics   |

## Connection contract

No pre-assembled connection URL is published in the env. The **balance** service
composes its own client config in step 3 from `REDIS_PASSWORD` (the `default` user)
via the in-network service name `redis:6379`. Keeping the password out of a
committed URL string is deliberate — see spec 01 § Contracts.

## Verifying AUTH is enforced

```sh
# DENIED: unauthenticated command -> NOAUTH
docker compose exec -e REDISCLI_AUTH= redis redis-cli set probe 1

# OK: authenticated (REDISCLI_AUTH from the container env)
docker compose exec redis redis-cli ping   # -> PONG
```
