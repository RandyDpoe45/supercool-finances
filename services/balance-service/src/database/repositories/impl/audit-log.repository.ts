import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { AuditLog } from '../../entities/audit-log.entity';
import { IAuditLogRepository } from '../interfaces/audit-log.repository.interface';

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
}
