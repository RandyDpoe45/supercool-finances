import { Inject, Injectable } from '@nestjs/common';
import { DeepPartial, QueryRunner } from 'typeorm';
import { AuditLog } from '../../../../database/entities/audit-log.entity';
import {
  AUDIT_LOG_REPOSITORY,
  IAuditLogRepository,
} from '../../../../database/repositories/interfaces/audit-log.repository.interface';
import { AuditEntry, IAuditService, ListAuditQuery } from '../interfaces/audit.service.interface';

/** Paging bounds for the admin audit list ({@link AuditService.listAudit}), mirroring the accounts
 * admin list: a missing `limit` defaults to {@link ADMIN_LIST_DEFAULT_LIMIT}; a larger request is
 * clamped to {@link ADMIN_LIST_MAX_LIMIT}, so the audit log is never scanned unbounded. */
const ADMIN_LIST_DEFAULT_LIMIT = 50;
const ADMIN_LIST_MAX_LIMIT = 200;

/**
 * The cross-cutting audit writer (spec 04 "Admin ops"). It owns NO business rules — it only
 * translates an {@link AuditEntry} into an append-only `audit_log` row via the
 * `AUDIT_LOG_REPOSITORY`, on either the caller's transaction ({@link recordInTx}) or its own
 * ({@link record}). Both paths INSERT only (the `id`/`created_at` are DB-generated), so the
 * append-only convention is preserved. The single READ path ({@link listAudit}) delegates the
 * parameterized browse query to the same repository.
 */
@Injectable()
export class AuditService implements IAuditService {
  constructor(@Inject(AUDIT_LOG_REPOSITORY) private readonly auditLog: IAuditLogRepository) {}

  async recordInTx(queryRunner: QueryRunner, entry: AuditEntry): Promise<void> {
    await this.auditLog.insertInTx(queryRunner, toRow(entry));
  }

  async record(entry: AuditEntry): Promise<void> {
    await this.auditLog.create(toRow(entry));
  }

  /**
   * Admin `GET /admin/audit` — browse the audit log. A pure READ (no tx, no new audit row) and
   * DELIBERATELY NOT owner-scoped: the audit log records privileged admin actions with no customer
   * owner, so the role-gated admin surface sees them all. CLAMPS the requested paging — an over-large
   * `limit` is capped to {@link ADMIN_LIST_MAX_LIMIT}, and an absent/negative `limit`/`offset` is
   * defaulted/floored — so an admin can never ask the DB for an unbounded scan, then delegates to the
   * parameterized repo query. Returns entities newest-first; the controller serializes them.
   */
  listAudit(query: ListAuditQuery): Promise<AuditLog[]> {
    const limit = Math.min(
      Math.max(query.limit ?? ADMIN_LIST_DEFAULT_LIMIT, 1),
      ADMIN_LIST_MAX_LIMIT,
    );
    const offset = Math.max(query.offset ?? 0, 0);
    return this.auditLog.queryAuditLog({
      actorId: query.actorId,
      action: query.action,
      targetType: query.targetType,
      targetId: query.targetId,
      limit,
      offset,
    });
  }
}

/** Normalize the entry into a row shape, defaulting the optional target/metadata to NULL. */
function toRow(entry: AuditEntry): DeepPartial<AuditLog> {
  return {
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ?? null,
  };
}
