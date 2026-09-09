import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryRunner, Repository } from 'typeorm';
import { TransactionStatus } from '../../entities/enums';
import { Transaction } from '../../entities/transaction.entity';
import { ITransactionRepository } from '../interfaces/transaction.repository.interface';

/** TypeORM implementation of {@link ITransactionRepository}, bound to
 * `TRANSACTION_REPOSITORY` in {@link PersistenceModule}. */
@Injectable()
export class TransactionRepository implements ITransactionRepository {
  constructor(@InjectRepository(Transaction) private readonly repo: Repository<Transaction>) {}

  findById(id: string): Promise<Transaction | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(data: DeepPartial<Transaction>): Promise<Transaction> {
    return this.repo.save(this.repo.create(data));
  }

  insertInTx(queryRunner: QueryRunner, data: DeepPartial<Transaction>): Promise<Transaction> {
    // save() joins the queryRunner's transaction via its manager; DB-generated columns
    // (created_at) are returned merged onto the entity. The posting reducer presets `id`
    // to a freshly-generated UUID, so this can only ever INSERT — never an update.
    return queryRunner.manager.save(queryRunner.manager.create(Transaction, data));
  }

  findByIdInTx(queryRunner: QueryRunner, id: string): Promise<Transaction | null> {
    return queryRunner.manager.findOne(Transaction, { where: { id } });
  }

  findPendingByInitiator(initiatedBy: string): Promise<Transaction[]> {
    return this.repo.find({
      where: { initiatedBy, status: TransactionStatus.Pending },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
  }

  async transitionToPostedInTx(queryRunner: QueryRunner, id: string): Promise<boolean> {
    // Guarded UPDATE: the WHERE status = PENDING predicate is the atomic gate. `now()` is the
    // DB clock (single source of truth). affected === 1 means THIS call won the transition;
    // 0 means the row was already posted / not pending.
    const result = await queryRunner.manager
      .createQueryBuilder()
      .update(Transaction)
      .set({ status: TransactionStatus.Posted, postedAt: () => 'now()' })
      .where('id = :id AND status = :pending', { id, pending: TransactionStatus.Pending })
      .execute();
    return (result.affected ?? 0) > 0;
  }
}
