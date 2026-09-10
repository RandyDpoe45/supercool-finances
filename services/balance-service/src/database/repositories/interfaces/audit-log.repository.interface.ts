import { DeepPartial, QueryRunner } from 'typeorm';
import { AuditLog } from '../../entities/audit-log.entity';

/** DI token for {@link IAuditLogRepository}. */
export const AUDIT_LOG_REPOSITORY = Symbol('AUDIT_LOG_REPOSITORY');

/** Persistence port for {@link AuditLog} (append-only). `id` is a bigint identity surfaced
 * as a string. */
export interface IAuditLogRepository {
  findById(id: string): Promise<AuditLog | null>;
  /** Append one audit row in its OWN transaction (auto-commit) — for an admin action whose
   * money movement already committed in a different service's transaction (e.g. the simulated
   * inbound credit). `id` (bigint identity) + `created_at` are DB-generated, so this can only
   * ever INSERT. */
  create(data: DeepPartial<AuditLog>): Promise<AuditLog>;
  /** Append one audit row INSIDE the caller's transaction (`queryRunner.manager`) — the
   * transactional path, so a mutating admin action and its audit row commit or roll back
   * together. `id`/`created_at` are DB-generated, so this can only ever INSERT. */
  insertInTx(queryRunner: QueryRunner, data: DeepPartial<AuditLog>): Promise<void>;
}
