import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryRunner, Repository } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';
import { ITransactionRepository } from './transaction.repository.interface';

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
}
