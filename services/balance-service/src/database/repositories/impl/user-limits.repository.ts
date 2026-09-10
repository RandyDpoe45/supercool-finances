import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, IsNull, QueryRunner, Repository } from 'typeorm';
import { UserLimitsScope } from '../../entities/enums';
import { UserLimits } from '../../entities/user-limits.entity';
import {
  IUserLimitsRepository,
  ResolvedLimits,
  UpsertUserLimitsData,
} from '../interfaces/user-limits.repository.interface';

/** One raw resolution row: the three cap columns as Postgres returns them (bigint → string). */
interface ResolvedLimitsRow {
  per_transaction_max: string | null;
  daily_max: string | null;
  monthly_max: string | null;
}

/** One raw `user_limits` row as Postgres returns it from `RETURNING *` (snake_case columns;
 * bigint → string, timestamptz → Date). */
interface UserLimitsRow {
  id: string;
  scope: UserLimitsScope;
  owner_id: string | null;
  currency: string;
  per_transaction_max: string | null;
  daily_max: string | null;
  monthly_max: string | null;
  created_at: Date;
  updated_at: Date;
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

  findExactInTx(
    queryRunner: QueryRunner,
    scope: UserLimitsScope,
    ownerId: string | null,
    currency: string,
  ): Promise<UserLimits | null> {
    // A global row has owner_id NULL; `IsNull()` selects it explicitly (a plain `ownerId` equality
    // would never match NULL). A customer row matches on the exact owner id. Runs on the caller's
    // manager so it participates in the open upsert transaction.
    return queryRunner.manager.findOne(UserLimits, {
      where: { scope, ownerId: ownerId === null ? IsNull() : ownerId, currency },
    });
  }

  async upsertInTx(queryRunner: QueryRunner, data: UpsertUserLimitsData): Promise<UserLimits> {
    // Explicit parameterized upsert (as in the idempotency claim / pending insert) so the
    // `ON CONFLICT ON CONSTRAINT` clause and `updated_at = now()` (DB clock) stay precise without a
    // client-side upsert. Conflict target is (scope, owner_id) — one row per scope/owner. Every
    // value is bound.
    const rows: UserLimitsRow[] = await queryRunner.query(
      `INSERT INTO "user_limits"
         ("scope", "owner_id", "currency", "per_transaction_max", "daily_max", "monthly_max")
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ON CONSTRAINT "uq_user_limits_scope"
       DO UPDATE SET "per_transaction_max" = EXCLUDED."per_transaction_max",
                     "daily_max" = EXCLUDED."daily_max",
                     "monthly_max" = EXCLUDED."monthly_max",
                     "currency" = EXCLUDED."currency",
                     "updated_at" = now()
       RETURNING *`,
      [
        data.scope,
        data.ownerId,
        data.currency,
        data.perTransactionMax,
        data.dailyMax,
        data.monthlyMax,
      ],
    );
    return mapRow(rows[0]);
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

/** Hydrate a raw `RETURNING *` row into a {@link UserLimits} entity. Bigints arrive as strings
 * (entity types match); timestamps are wrapped with `new Date(...)` so the result is a real Date
 * regardless of whether the driver returned a Date or an ISO string. */
function mapRow(row: UserLimitsRow): UserLimits {
  const entity = new UserLimits();
  entity.id = row.id;
  entity.scope = row.scope;
  entity.ownerId = row.owner_id;
  entity.currency = row.currency;
  entity.perTransactionMax = row.per_transaction_max;
  entity.dailyMax = row.daily_max;
  entity.monthlyMax = row.monthly_max;
  entity.createdAt = new Date(row.created_at);
  entity.updatedAt = new Date(row.updated_at);
  return entity;
}
