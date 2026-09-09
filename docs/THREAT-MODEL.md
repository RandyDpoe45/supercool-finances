# Threat Model (STRIDE-lite)

Because the prompt is explicitly about keeping customer money safe, this doc makes
the threats and their mitigations auditable. Scoped to the design in
[ARCHITECTURE.md](./ARCHITECTURE.md); references decisions in
[DECISIONS.md](./DECISIONS.md).

## Trust boundaries

1. **Public internet → public nginx → public Kong** — untrusted clients (client
   and OTP web apps). nginx serves the SPA and proxies `/api` to Kong, which
   enforces policy.
2. **Internal network → internal nginx → internal Kong** — admin dashboard only;
   not public.
3. **Gateway → services** — services trust the gateway-injected identity and
   nothing else.
4. **Services → data stores** — each store has one owner (database-per-service):
   Postgres (authoritative) + Redis (ephemeral) behind the balance service; Mongo
   (derived, non-authoritative) behind the analytics server.

## Threats → mitigations

| STRIDE | Threat | Mitigation |
|---|---|---|
| **Spoofing** | Caller forges `X-User-Id` to act as another user by reaching a service directly. | Services not directly reachable (network policy); gateway↔service link authenticated (mTLS/signed header); services trust only the gateway-stripped/injected identity. (ADR-2, ADR-3) |
| **Spoofing** | Stolen/replayed access token. | Short-lived access tokens (≈5 min) + refresh bound the exposure window; the gateway validates the signature **and** claims (`exp`/`iss`/`aud`) via JWKS; sensitive actions add transaction OTP + maker-checker (ADR-6). Live revocation is out of scope — see residual risk. |
| **Tampering** | Client sends someone else's account/resource id (IDOR/BOLA). | Object-level authZ: `WHERE id = :id AND owner_id = :sub`; `404` on non-owned; nested-resource checks; centralized guard. (ADR-3) |
| **Tampering** | Balance altered directly / history rewritten. | Append-only double-entry ledger; balances derived; reversals via compensating entries, never mutation. (ADR-4) |
| **Repudiation** | User or admin denies making a transaction/change. | Immutable audit log; maker-checker on admin money ops; transaction OTP ties an action to a step-up. (ADR-8) |
| **Information disclosure** | Resource enumeration via id probing. | `404` (not `403`) for non-owned resources. (ADR-3) |
| **Information disclosure** | Secrets in code/logs. | Env/Docker secrets (Vault in prod); no secrets in logs; correlation ids, not PII, in traces. |
| **Denial of service** | Credential stuffing / transfer flooding / bot abuse. | Rate limiting at both gateways (tighter on auth + money); attempt lockout on OTP; captcha stub on client; daily/monthly amount limits in the domain. |
| **Denial of service** | Admin plane exposed to public attackers. | Physically separate internal gateway on a non-public network. (ADR-1) |
| **Elevation of privilege** | Customer token reaching admin endpoints. | Route allowlist + role/scope checks per gateway; admin gateway rejects non-admin tokens. (ADR-1, ADR-2) |
| **Elevation of privilege** | Service-to-service endpoints (`/internal`) reached from outside. | No gateway routes `/internal` (prefix-scoped, default-deny allowlists); services additionally require service identity on `/internal`, never a user JWT. (ADR-12) |
| **Elevation of privilege** | Single rogue/compromised admin moves money. | Maker-checker (four-eyes) + audit. (ADR-8) |

## Money-integrity threats (domain-specific)

| Threat | Mitigation |
|---|---|
| Double-spend under concurrent transfers | `SELECT ... FOR UPDATE` on the account row (which holds the materialized `balance` + counters), canonical lock order; concurrency test asserts the invariant. (ADR-13) |
| Spending funds already committed to a pending transfer | Funds reserved via a hold; the new-transfer check is against `available = balance − held`, not `balance`. (ADR-14) |
| Duplicate money movement on retry | `Idempotency-Key` on every money-moving endpoint; retry returns the original result. |
| Money created/lost via float rounding | Integer minor units (or fixed `DECIMAL`) + explicit currency. (ADR-4) |
| Event stream disagrees with the ledger | Transactional outbox (same-tx write) + at-least-once relay + idempotent consumer. (ADR-5) |
| Relay double-publishes an event (multiple balance-service instances) | Claim outbox rows with `SELECT ... FOR UPDATE SKIP LOCKED`; idempotent consumer dedups by `event_id`. (ADR-11) |
| OTP code replayed for a different transfer | **User-scoped, single-active, single-use OTP**: at most one live code per user, atomically consumed on confirm (`GETDEL`), so a code authorizes exactly one transfer and cannot be reused for another; generating a new code is blocked while one is active. (ADR-6) |
| OTP code redeemed twice (race) | Atomic single-use consume (`GETDEL`/Lua) + TTL. (ADR-7) |
| New payee used to exfiltrate funds immediately | Cooling-off period before a newly-enrolled external account can receive money. |
| Silent drift between ledger and materialized balance | Single posting operation writes both in one tx; reconciliation asserts `sum(ledger delta) == account.balance`; internal accounts net to zero. (ADR-13) |

## Residual risk / out of scope for the test

- Real external banking rails are mocked (ADR-9) — real-world settlement/failure
  modes are represented only by the clearing-account model and simulated
  webhooks.
- OTP delivery is mocked via the OTP app rather than a hardened out-of-band
  channel (ADR-6).
- Production hardening (WAF, secret manager, mTLS everywhere, HA) is noted as the
  production path, not fully implemented.
- **No live token revocation.** The gateway validates tokens via JWKS only (no
  introspection), so a stolen or post-logout token stays valid until it expires.
  Mitigated by short access-token lifetimes; production would add introspection or
  a revocation check.
