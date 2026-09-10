import { Inject, Injectable } from '@nestjs/common';
import { DeepPartial, QueryRunner } from 'typeorm';
import { AuditLog } from '../../../../database/entities/audit-log.entity';
import {
  AUDIT_LOG_REPOSITORY,
  IAuditLogRepository,
} from '../../../../database/repositories/interfaces/audit-log.repository.interface';
import { AuditEntry, IAuditService } from '../interfaces/audit.service.interface';

/**
 * The cross-cutting audit writer (spec 04 "Admin ops"). It owns NO business rules — it only
 * translates an {@link AuditEntry} into an append-only `audit_log` row via the
 * `AUDIT_LOG_REPOSITORY`, on either the caller's transaction ({@link recordInTx}) or its own
 * ({@link record}). Both paths INSERT only (the `id`/`created_at` are DB-generated), so the
 * append-only convention is preserved.
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
