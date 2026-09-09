import { DeepPartial } from 'typeorm';
import { AuditLog } from '../entities/audit-log.entity';

/** DI token for {@link IAuditLogRepository}. */
export const AUDIT_LOG_REPOSITORY = Symbol('AUDIT_LOG_REPOSITORY');

/** Persistence port for {@link AuditLog} (append-only). `id` is a bigint identity surfaced
 * as a string. */
export interface IAuditLogRepository {
  findById(id: string): Promise<AuditLog | null>;
  create(data: DeepPartial<AuditLog>): Promise<AuditLog>;
}
