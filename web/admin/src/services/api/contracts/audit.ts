/**
 * App-local copy of the balance-service admin `GET /admin/audit` wire contract. Per ADR-16
 * (self-contained components, no cross-folder imports) the admin-app keeps its own copy rather than
 * importing from the service or the sibling SPAs; it is kept in sync via specs/07-frontends.md, the
 * contract of record. Mirrors balance-service's admin `AuditLogDto` serializer output — a deliberate
 * admin-only whitelist over the `audit_log` entity (the admin surface is trusted + role-gated).
 *
 * `id` is a bigint identity surfaced as a STRING (int64 precision) — it is ALSO the newest-first sort
 * key, so NEVER parse it into a `Number`. `action` is one of the producer's fixed set (see
 * {@link AUDIT_ACTIONS}); it is left an open string on the wire because the admin surface may see
 * values beyond a bespoke union. `targetType` / `targetId` describe what the action touched (account /
 * transaction / approval / limits) or are `null` for a target-less entry (the columns are nullable).
 *
 * `metadata` is a free-form before/after blob (approval ids, amounts, limit deltas). It is
 * DELIBERATELY surfaced — it IS the audit content — and MUST be rendered strictly READ-ONLY; any
 * money inside it stays a minor-unit STRING (never parsed to a float). `createdAt` is an ISO-8601 UTC
 * instant, converted to Mexico City time only at the display edge.
 */
export interface AuditLogDto {
  id: string;
  actorId: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** Envelope returned by `GET /admin/audit`, newest-first. */
export interface AuditLogResponse {
  entries: AuditLogDto[];
}

/**
 * The producer's fixed set of `action` strings. The single source of truth for both the audit
 * fixtures and the page's action-filter select, so a new producer action is added in exactly one
 * place. Kept in sync with the balance-service audit producer via specs/07-frontends.md.
 */
export const AUDIT_ACTIONS = [
  'account.freeze',
  'account.unfreeze',
  'limits.change',
  'external.inbound.simulated',
  'reversal.proposed',
  'reversal.executed',
  'reversal.rejected',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
