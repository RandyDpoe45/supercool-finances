import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { IdempotencyKey } from '../entities/idempotency-key.entity';
import { IIdempotencyKeyRepository } from './idempotency-key.repository.interface';

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
}
