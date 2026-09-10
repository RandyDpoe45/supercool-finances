import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryRunner, Repository } from 'typeorm';
import { Account } from '../../entities/account.entity';
import { IAccountRepository } from '../interfaces/account.repository.interface';

/** TypeORM implementation of {@link IAccountRepository}, bound to `ACCOUNT_REPOSITORY` in
 * {@link PersistenceModule}. No domain logic — persistence primitives only. */
@Injectable()
export class AccountRepository implements IAccountRepository {
  constructor(@InjectRepository(Account) private readonly repo: Repository<Account>) {}

  findById(id: string): Promise<Account | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(data: DeepPartial<Account>): Promise<Account> {
    return this.repo.save(this.repo.create(data));
  }

  findByOwner(ownerId: string): Promise<Account[]> {
    return this.repo.find({ where: { ownerId } });
  }

  findByIdAndOwner(id: string, ownerId: string): Promise<Account | null> {
    return this.repo.findOne({ where: { id, ownerId } });
  }

  findBySystemKey(systemKey: string): Promise<Account | null> {
    return this.repo.findOne({ where: { systemKey } });
  }

  findByAccountNumber(accountNumber: string): Promise<Account | null> {
    return this.repo.findOne({ where: { accountNumber } });
  }

  lockByIdForUpdate(queryRunner: QueryRunner, id: string): Promise<Account | null> {
    return queryRunner.manager
      .createQueryBuilder(Account, 'account')
      .setLock('pessimistic_write')
      .where('account.id = :id', { id })
      .getOne();
  }

  async updateBalanceInTx(queryRunner: QueryRunner, id: string, newBalance: string): Promise<void> {
    await queryRunner.manager
      .createQueryBuilder()
      .update(Account)
      .set({ balance: newBalance, updatedAt: () => 'now()' })
      .where('id = :id', { id })
      .execute();
  }

  async updateHeldInTx(queryRunner: QueryRunner, id: string, newHeld: string): Promise<void> {
    await queryRunner.manager
      .createQueryBuilder()
      .update(Account)
      .set({ held: newHeld, updatedAt: () => 'now()' })
      .where('id = :id', { id })
      .execute();
  }
}
