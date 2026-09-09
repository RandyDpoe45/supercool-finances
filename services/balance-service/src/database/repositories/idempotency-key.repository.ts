import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryRunner, Repository } from 'typeorm';
import { IdempotencyStatus } from '../entities/enums';
import { IdempotencyKey } from '../entities/idempotency-key.entity';
import {
  IdempotencyClaim,
  IIdempotencyKeyRepository,
} from './idempotency-key.repository.interface';

/** TypeORM implementation of {@link IIdempotencyKeyRepository}, bound to
 * `IDEMPOTENCY_KEY_REPOSITORY` in {@link PersistenceModule}. Keyed on the composite PK. */
@Injectable()
export class IdempotencyKeyRepository implements IIdempotencyKeyRepository {
  constructor(
    @InjectRepository(IdempotencyKey) private readonly repo: Repository<IdempotencyKey>,
  ) {}

  findByOwnerAndKey(ownerId: string, key: string): Promise<IdempotencyKey | null> {
    return this.repo.findOne({ where: { ownerId, key } });
  }

  create(data: DeepPartial<IdempotencyKey>): Promise<IdempotencyKey> {
    return this.repo.save(this.repo.create(data));
  }

  findByOwnerAndKeyInTx(
    queryRunner: QueryRunner,
    ownerId: string,
    key: string,
  ): Promise<IdempotencyKey | null> {
    return queryRunner.manager.findOne(IdempotencyKey, { where: { ownerId, key } });
  }

  async claimInTx(queryRunner: QueryRunner, data: IdempotencyClaim): Promise<boolean> {
    // Explicit parameterized INSERT with ON CONFLICT DO NOTHING (NOT .save()/create, which
    // upserts on the client-supplied composite PK). `RETURNING "key"` yields the row only when
    // this statement actually inserted — a conflict skips it — so a returned row === we claimed.
    const inserted: unknown[] = await queryRunner.manager.query(
      `INSERT INTO "idempotency_key"
         ("owner_id", "key", "request_fingerprint", "status", "expires_at")
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("owner_id", "key") DO NOTHING
       RETURNING "key"`,
      [data.ownerId, data.key, data.requestFingerprint, data.status, data.expiresAt],
    );
    return inserted.length === 1;
  }

  async markCompletedInTx(
    queryRunner: QueryRunner,
    ownerId: string,
    key: string,
    transactionId: string,
  ): Promise<void> {
    await queryRunner.manager
      .createQueryBuilder()
      .update(IdempotencyKey)
      .set({ status: IdempotencyStatus.Completed, transactionId })
      .where('"owner_id" = :ownerId AND "key" = :key', { ownerId, key })
      .execute();
  }

  findRecentByFingerprintInTx(
    queryRunner: QueryRunner,
    ownerId: string,
    fingerprint: string,
    sinceEpochMs: number,
    excludeKey: string,
  ): Promise<IdempotencyKey | null> {
    return queryRunner.manager
      .createQueryBuilder(IdempotencyKey, 'idem')
      .where('idem.ownerId = :ownerId', { ownerId })
      .andWhere('idem.requestFingerprint = :fingerprint', { fingerprint })
      .andWhere('idem.createdAt > :since', { since: new Date(sinceEpochMs) })
      .andWhere('idem.key <> :excludeKey', { excludeKey })
      .orderBy('idem.createdAt', 'DESC')
      .limit(1)
      .getOne();
  }
}
