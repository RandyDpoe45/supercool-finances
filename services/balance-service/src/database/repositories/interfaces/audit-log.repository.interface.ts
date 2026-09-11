import { DeepPartial, QueryRunner } from 'typeorm';
import { AuditLog } from '../../entities/audit-log.entity';

/** DI token for {@link IAuditLogRepository}. */
export const AUDIT_LOG_REPOSITORY = Symbol('AUDIT_LOG_REPOSITORY');

/** Filter for the admin audit query ({@link IAuditLogRepository.queryAuditLog}). `actorId` /
 * `action` / `targetType` / `targetId` are optional exact-match predicates (absent → no predicate,
 * i.e. any value); the already-clamped `limit`/`offset` (the service bounds them) are required. */
export interface AuditLogQueryFilter {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  limit: number;
  offset: number;
}

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
  /** Admin-scoped audit browse query (`GET /admin/audit`). A parameterized SELECT with each present
   * filter (`actorId` / `action` / `targetType` / `targetId`) bound as an exact-match predicate,
   * `ORDER BY created_at DESC, id DESC` (the bigint identity gives a numeric newest-first tiebreak),
   * `LIMIT`/`OFFSET` from the (already-clamped) filter. A plain read (no `FOR UPDATE`), DELIBERATELY
   * NOT owner-scoped — the audit log has no customer owner; it is a role-gated admin surface. */
  queryAuditLog(filter: AuditLogQueryFilter): Promise<AuditLog[]>;
}
