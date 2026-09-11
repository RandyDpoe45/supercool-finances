/**
 * Admin-plane view of an {@link AuditLog} row on the `GET /admin/audit` read. The audit log is the
 * append-only record of privileged admin actions, and the admin/auditor is a trusted, role-gated
 * actor — so this view DELIBERATELY surfaces the free-form `metadata` before/after blob, which IS
 * the audit content (who changed what, from/to). Every field is still listed EXPLICITLY (the
 * serializer never spreads the entity): exposing a field is a deliberate act, not an accident of
 * object shape.
 *
 * `id` is the `bigint GENERATED ALWAYS AS IDENTITY` primary key surfaced by TypeORM as a JS string
 * (also the newest-first tiebreak). `targetType` / `targetId` form the polymorphic (intentionally
 * not-FK) pointer to the affected resource and may be null. `createdAt` is an ISO-8601 UTC string.
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
