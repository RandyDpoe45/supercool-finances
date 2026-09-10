import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryRunner, Repository } from 'typeorm';
import { ApprovalRequest } from '../../entities/approval-request.entity';
import { ApprovalStatus } from '../../entities/enums';
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

  createInTx(
    queryRunner: QueryRunner,
    data: DeepPartial<ApprovalRequest>,
  ): Promise<ApprovalRequest> {
    // save() joins the queryRunner's transaction via its manager; DB-generated columns
    // (`id`, `created_at`) are returned merged onto the entity, so the caller can reference the
    // new approval id in the same-tx audit row.
    return queryRunner.manager.save(queryRunner.manager.create(ApprovalRequest, data));
  }

  findByIdInTx(queryRunner: QueryRunner, id: string): Promise<ApprovalRequest | null> {
    return queryRunner.manager.findOne(ApprovalRequest, { where: { id } });
  }

  findByTargetTransaction(targetTransactionId: string): Promise<ApprovalRequest[]> {
    return this.repo.find({ where: { targetTransactionId } });
  }

  async transitionToExecutedInTx(
    queryRunner: QueryRunner,
    id: string,
    checkerId: string,
  ): Promise<boolean> {
    // Guarded UPDATE: the `status = PENDING` predicate is the atomic maker-checker gate. `now()` is
    // the DB clock (single source of truth). affected === 1 means THIS checker won the execution; 0
    // means a concurrent checker already decided. `checker_id` is set here — the service verified
    // `checkerId <> makerId` first, so the DB CHECK never fires.
    const result = await queryRunner.manager
      .createQueryBuilder()
      .update(ApprovalRequest)
      .set({
        status: ApprovalStatus.Executed,
        checkerId,
        decidedAt: () => 'now()',
        executedAt: () => 'now()',
      })
      .where('id = :id AND status = :pending', { id, pending: ApprovalStatus.Pending })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async transitionToRejectedInTx(
    queryRunner: QueryRunner,
    id: string,
    checkerId: string,
  ): Promise<boolean> {
    // Guarded UPDATE: same PENDING gate as the executed transition; no money moves. affected === 1
    // means THIS checker rejected it; 0 means it was already decided. `checker_id` is set here — the
    // service verified `checkerId <> makerId` first, so the DB CHECK never fires.
    const result = await queryRunner.manager
      .createQueryBuilder()
      .update(ApprovalRequest)
      .set({ status: ApprovalStatus.Rejected, checkerId, decidedAt: () => 'now()' })
      .where('id = :id AND status = :pending', { id, pending: ApprovalStatus.Pending })
      .execute();
    return (result.affected ?? 0) > 0;
  }
}
