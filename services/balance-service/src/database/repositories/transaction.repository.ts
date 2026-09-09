import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
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
}
