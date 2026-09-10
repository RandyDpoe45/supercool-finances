import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryRunner, Repository } from 'typeorm';
import { HoldStatus } from '../../entities/enums';
import { Hold } from '../../entities/hold.entity';
import { IHoldRepository } from '../interfaces/hold.repository.interface';

/** TypeORM implementation of {@link IHoldRepository}, bound to `HOLD_REPOSITORY` in
 * {@link PersistenceModule}. No domain logic — persistence primitives only; the `held`
 * bookkeeping and lock ordering live in the transfers service that calls these. */
@Injectable()
export class HoldRepository implements IHoldRepository {
  constructor(@InjectRepository(Hold) private readonly repo: Repository<Hold>) {}

  findById(id: string): Promise<Hold | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(data: DeepPartial<Hold>): Promise<Hold> {
    return this.repo.save(this.repo.create(data));
  }

  insertInTx(queryRunner: QueryRunner, data: DeepPartial<Hold>): Promise<Hold> {
    // save() joins the queryRunner's transaction via its manager; the caller presets `id`, so
    // this can only ever INSERT. `created_at` defaults on the DB; `settled_at`/`released_at`
    // stay NULL until a terminal transition.
    return queryRunner.manager.save(queryRunner.manager.create(Hold, data));
  }

  findByTransactionInTx(queryRunner: QueryRunner, transactionId: string): Promise<Hold | null> {
    return queryRunner.manager.findOne(Hold, { where: { transactionId } });
  }

  async settleInTx(queryRunner: QueryRunner, id: string): Promise<boolean> {
    // Guarded UPDATE: the `status = PLACED` predicate is the atomic gate. affected === 1 means
    // THIS call settled it; 0 means it was already terminal (concurrently released/expired).
    const result = await queryRunner.manager
      .createQueryBuilder()
      .update(Hold)
      .set({ status: HoldStatus.Settled, settledAt: () => 'now()' })
      .where('id = :id AND status = :placed', { id, placed: HoldStatus.Placed })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async releaseInTx(
    queryRunner: QueryRunner,
    id: string,
    status: HoldStatus.Released | HoldStatus.Expired,
  ): Promise<boolean> {
    // Guarded UPDATE: `PLACED → RELEASED | EXPIRED` (+ released_at = now()). affected === 1 means
    // THIS call released it — the caller then decrements `account.held`; 0 means already terminal.
    const result = await queryRunner.manager
      .createQueryBuilder()
      .update(Hold)
      .set({ status, releasedAt: () => 'now()' })
      .where('id = :id AND status = :placed', { id, placed: HoldStatus.Placed })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async recordExternalRefInTx(
    queryRunner: QueryRunner,
    id: string,
    externalRef: string,
  ): Promise<boolean> {
    // Guarded UPDATE: the `external_ref IS NULL` predicate is the atomic idempotency gate for the
    // rail SUCCESS callback. affected === 1 means THIS call recorded the rail reference; 0 means
    // it was already set (a retried/duplicate success), so nothing is overwritten. No balance,
    // `held`, or ledger change — reconciliation only.
    const result = await queryRunner.manager
      .createQueryBuilder()
      .update(Hold)
      .set({ externalRef })
      .where('id = :id AND external_ref IS NULL', { id })
      .execute();
    return (result.affected ?? 0) > 0;
  }
}
