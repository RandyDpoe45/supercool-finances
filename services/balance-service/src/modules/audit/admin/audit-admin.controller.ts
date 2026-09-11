import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { AUDIT_SERVICE, IAuditService } from '../service/interfaces/audit.service.interface';
import { AuditLogDto } from './dto/audit-log.dto';
import { ListAuditQueryParams, listAuditQuerySchema } from './dto/audit-query.schema';
import { serializeAuditLog } from './serializers/audit-log.serializer';

/**
 * The audit feature's `/admin` surface controller (spec 04 "Admin ops" — `GET /admin/audit`, browse
 * the audit log). DECLARED by {@link AdminModule}; the {@link AuditModule} feature module provides +
 * exports the service behind the `AUDIT_SERVICE` token, injected here as `IAuditService`. This is the
 * READ companion to the write-only audit paths every mutating admin op already uses — the admin/
 * auditor view of who did what.
 *
 * Under the global `/admin` prefix, role-gated by the {@link GatewayIdentityGuard} (`X-User-Id` +
 * `admin` role, else 403). The query string is validated by the {@link ZodValidationPipe}
 * (`.strict()`, malformed / unknown keys → 400). This is a NON-owner-scoped READ (the audit log has
 * no owner — any admin action is visible) — it writes NO audit row and opens NO transaction. The
 * service returns entities; this controller serializes them to the admin DTO at the boundary,
 * newest-first.
 */
@Controller('admin/audit')
export class AuditAdminController {
  constructor(@Inject(AUDIT_SERVICE) private readonly audit: IAuditService) {}

  /** List audit-log entries with optional exact-match filters (actorId / action / targetType /
   * targetId) + paging (limit clamped to ≤200, default 50; offset ≥0), newest-first. 200,
   * `{ entries: AuditLogDto[] }`. */
  @Get()
  async listAudit(
    @Query(new ZodValidationPipe(listAuditQuerySchema)) query: ListAuditQueryParams,
  ): Promise<{ entries: AuditLogDto[] }> {
    const rows = await this.audit.listAudit({
      actorId: query.actorId,
      action: query.action,
      targetType: query.targetType,
      targetId: query.targetId,
      limit: query.limit,
      offset: query.offset,
    });
    return { entries: rows.map(serializeAuditLog) };
  }
}
