import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryRunner, Repository } from 'typeorm';
import { AuditLog } from '../../entities/audit-log.entity';
import {
  AuditLogQueryFilter,
  IAuditLogRepository,
} from '../interfaces/audit-log.repository.interface';

/** TypeORM implementation of {@link IAuditLogRepository}, bound to `AUDIT_LOG_REPOSITORY`
 * in {@link PersistenceModule}. */
@Injectable()
export class AuditLogRepository implements IAuditLogRepository {
  constructor(@InjectRepository(AuditLog) private readonly repo: Repository<AuditLog>) {}

  findById(id: string): Promise<AuditLog | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(data: DeepPartial<AuditLog>): Promise<AuditLog> {
    return this.repo.save(this.repo.create(data));
  }

  async insertInTx(queryRunner: QueryRunner, data: DeepPartial<AuditLog>): Promise<void> {
    // save() joins the caller's transaction via its manager; `id` (bigint identity) and
    // `created_at` are DB-generated (not supplied), so this can only ever INSERT — the
    // append-only invariant is preserved.
    await queryRunner.manager.save(queryRunner.manager.create(AuditLog, data));
  }

  queryAuditLog(filter: AuditLogQueryFilter): Promise<AuditLog[]> {
    // A plain (no FOR UPDATE), DELIBERATELY-NOT-owner-scoped read for the role-gated admin surface
    // (the audit log has no customer owner). Each present filter appends a bound exact-match
    // predicate (never interpolated); newest-first with an id tiebreak (the bigint identity gives a
    // numeric ordering in Postgres); LIMIT/OFFSET from the already-clamped filter.
    const qb = this.repo.createQueryBuilder('a');
    if (filter.actorId !== undefined) {
      qb.andWhere('a.actorId = :actorId', { actorId: filter.actorId });
    }
    if (filter.action !== undefined) {
      qb.andWhere('a.action = :action', { action: filter.action });
    }
    if (filter.targetType !== undefined) {
      qb.andWhere('a.targetType = :targetType', { targetType: filter.targetType });
    }
    if (filter.targetId !== undefined) {
      qb.andWhere('a.targetId = :targetId', { targetId: filter.targetId });
    }
    return qb
      .orderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .limit(filter.limit)
      .offset(filter.offset)
      .getMany();
  }
}
