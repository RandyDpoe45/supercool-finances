/**
 * App-local copy of the balance-service payees `/api` wire contract (mirrors the payees serializer,
 * DTO, and enrollment schema). Per ADR-16 (self-contained components, no cross-folder imports) this
 * SPA keeps its OWN copy rather than importing from the service; the specs (`specs/07-frontends.md`,
 * `specs/04-balance-service.md`, `specs/balance-schema.yaml`) are the contract of record.
 *
 * The serializer whitelists each field by hand and NEVER spreads the entity: the internal columns
 * the service deliberately withholds (`ownerId`, `rail`, `status`, `activatedAt`) are simply ABSENT
 * here and must never be rendered or stored. `coolingOffUntil` / `createdAt` are ISO-8601 UTC
 * strings; `usable` is a presentation-derived HINT (`now() >= coolingOffUntil`) — the AUTHORITATIVE
 * gate is re-checked against the DB clock at outbound time, so `usable` guides the UI but the server
 * remains the source of truth (a stale `usable: true` still fails with `PAYEE_IN_COOLING_OFF`).
 */
export interface PayeeDto {
  id: string;
  displayName: string;
  destinationRef: string;
  coolingOffUntil: string;
  usable: boolean;
  createdAt: string;
}

/** Envelope returned by `GET /api/payees`. */
export interface PayeesResponse {
  payees: PayeeDto[];
}

/**
 * Body of `POST /api/payees` — the minimal enrollment input. The service schema is `.strict()`, so
 * ONLY these two fields may be sent: `displayName` (trimmed, 1–120 chars) and `destinationRef` (a
 * 6–20 digit numeric string). The outbound rail is a server-side constant and is NEVER accepted from
 * the caller; `status` / `coolingOffUntil` / `ownerId` are server-owned and must never be smuggled.
 */
export interface RegisterPayeeRequest {
  displayName: string;
  destinationRef: string;
}
