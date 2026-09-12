import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryRunner, Repository } from 'typeorm';
import { Account } from '../../entities/account.entity';
import { AccountKind, AccountStatus } from '../../entities/enums';
import { AccountQueryFilter, IAccountRepository } from '../interfaces/account.repository.interface';

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

  queryAccounts(filter: AccountQueryFilter): Promise<Account[]> {
    // A plain (no FOR UPDATE), DELIBERATELY-NOT-owner-scoped read for the role-gated admin surface.
    // The optional `ownerId` appends a bound predicate (never interpolated); newest-first with an id
    // tiebreak for deterministic ordering; LIMIT/OFFSET from the already-clamped filter.
    const qb = this.repo.createQueryBuilder('a');
    if (filter.ownerId !== undefined) {
      qb.andWhere('a.ownerId = :ownerId', { ownerId: filter.ownerId });
    }
    return qb
      .orderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .limit(filter.limit)
      .offset(filter.offset)
      .getMany();
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

  async lockOwnerForAccountCreation(queryRunner: QueryRunner, ownerId: string): Promise<void> {
    // Transaction-scoped advisory lock keyed by the owner id (hashed to the bigint the lock API
    // takes). Parameterized — ownerId is never interpolated. Released at transaction end.
    await queryRunner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ownerId]);
  }

  countCustomerAccountsByOwner(queryRunner: QueryRunner, ownerId: string): Promise<number> {
    return queryRunner.manager
      .createQueryBuilder(Account, 'account')
      .where('account.ownerId = :ownerId', { ownerId })
      .andWhere('account.kind = :kind', { kind: AccountKind.Customer })
      .getCount();
  }

  createInTx(queryRunner: QueryRunner, data: DeepPartial<Account>): Promise<Account> {
    return queryRunner.manager.save(queryRunner.manager.create(Account, data));
  }

  async updateBalanceInTx(queryRunner: QueryRunner, id: string, newBalance: string): Promise<void> {
    await queryRunner.manager
      .createQueryBuilder()
      .update(Account)
      .set({ balance: newBalance, updatedAt: () => 'now()' })
      .where('id = :id', { id })
      .execute();
  }

  async updateStatusInTx(
    queryRunner: QueryRunner,
    id: string,
    status: AccountStatus,
  ): Promise<void> {
    await queryRunner.manager
      .createQueryBuilder()
      .update(Account)
      .set({ status, updatedAt: () => 'now()' })
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

  async currentSpendWindowInTx(
    queryRunner: QueryRunner,
  ): Promise<{ today: string; monthStart: string }> {
    const rows: { today: string; month_start: string }[] = await queryRunner.query(
      `SELECT (now() AT TIME ZONE 'UTC')::date::text AS today,
              (date_trunc('month', now() AT TIME ZONE 'UTC'))::date::text AS month_start`,
    );
    return { today: rows[0].today, monthStart: rows[0].month_start };
  }

  async updateSpendCountersInTx(
    queryRunner: QueryRunner,
    accountId: string,
    spentToday: string,
    spentTodayDate: string,
    spentMonth: string,
    spentMonthDate: string,
  ): Promise<void> {
    await queryRunner.manager
      .createQueryBuilder()
      .update(Account)
      .set({
        spentToday,
        spentTodayDate,
        spentMonth,
        spentMonthDate,
        updatedAt: () => 'now()',
      })
      .where('id = :id', { id: accountId })
      .execute();
  }
}
