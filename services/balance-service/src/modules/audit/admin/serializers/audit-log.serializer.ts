import { AuditLog } from '../../../../database/entities/audit-log.entity';
import { AuditLogDto } from '../dto/audit-log.dto';

/**
 * The anti-leak transport boundary for the `GET /admin/audit` view. It lists every output field
 * EXPLICITLY and MUST NOT spread the entity — adding a field to the wire is a deliberate act, not an
 * accident of object shape. Unlike the account/transaction serializers this ADMIN-ONLY view passes
 * the free-form `metadata` blob through as-is: on the audit log the before/after metadata IS the
 * content the auditor needs, so it is surfaced on purpose (never on a customer-facing serializer).
 * `id` is the bigint identity as a string; `createdAt` is rendered ISO-8601 UTC.
 */
export function serializeAuditLog(row: AuditLog): AuditLogDto {
  return {
    id: row.id,
    actorId: row.actorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}
