import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryRunner, Repository } from 'typeorm';
import { UserLimits } from '../../entities/user-limits.entity';
import {
  IUserLimitsRepository,
  ResolvedLimits,
} from '../interfaces/user-limits.repository.interface';

/** One raw resolution row: the three cap columns as Postgres returns them (bigint → string). */
interface ResolvedLimitsRow {
  per_transaction_max: string | null;
  daily_max: string | null;
  monthly_max: string | null;
}

/** TypeORM implementation of {@link IUserLimitsRepository}, bound to
 * `USER_LIMITS_REPOSITORY` in {@link PersistenceModule}. */
@Injectable()
export class UserLimitsRepository implements IUserLimitsRepository {
  constructor(@InjectRepository(UserLimits) private readonly repo: Repository<UserLimits>) {}

  findById(id: string): Promise<UserLimits | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(data: DeepPartial<UserLimits>): Promise<UserLimits> {
    return this.repo.save(this.repo.create(data));
  }

  findByOwner(ownerId: string): Promise<UserLimits[]> {
    return this.repo.find({ where: { ownerId } });
  }

  async resolveInTx(
    queryRunner: QueryRunner,
    ownerId: string,
    currency: string,
  ): Promise<ResolvedLimits | null> {
    // Customer override wins wholesale when present; else the global baseline; else uncapped.
    const customer = await this.selectCaps(queryRunner, 'customer', ownerId, currency);
    if (customer) {
      return customer;
    }
    return this.selectCaps(queryRunner, 'global', null, currency);
  }

  private async selectCaps(
    queryRunner: QueryRunner,
    scope: 'customer' | 'global',
    ownerId: string | null,
    currency: string,
  ): Promise<ResolvedLimits | null> {
    // A global row has `owner_id` NULL, so `owner_id = $2` cannot match it; `$2 IS NULL` selects
    // it explicitly. All params bound — no interpolation.
    const rows: ResolvedLimitsRow[] = await queryRunner.query(
      `SELECT "per_transaction_max", "daily_max", "monthly_max"
         FROM "user_limits"
        WHERE "scope" = $1
          AND ("owner_id" = $2 OR ($2 IS NULL AND "owner_id" IS NULL))
          AND "currency" = $3
        LIMIT 1`,
      [scope, ownerId, currency],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      perTransactionMax: row.per_transaction_max,
      dailyMax: row.daily_max,
      monthlyMax: row.monthly_max,
    };
  }
}
