import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { ApprovalRequest } from '../../entities/approval-request.entity';
import { IApprovalRequestRepository } from '../interfaces/approval-request.repository.interface';

/** TypeORM implementation of {@link IApprovalRequestRepository}, bound to
 * `APPROVAL_REQUEST_REPOSITORY` in {@link PersistenceModule}. */
@Injectable()
export class ApprovalRequestRepository implements IApprovalRequestRepository {
  constructor(
    @InjectRepository(ApprovalRequest) private readonly repo: Repository<ApprovalRequest>,
  ) {}

  findById(id: string): Promise<ApprovalRequest | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(data: DeepPartial<ApprovalRequest>): Promise<ApprovalRequest> {
    return this.repo.save(this.repo.create(data));
  }
}
