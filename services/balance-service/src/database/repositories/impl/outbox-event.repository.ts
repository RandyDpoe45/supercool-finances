import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryRunner, Repository } from 'typeorm';
import { OutboxEvent } from '../../entities/outbox-event.entity';
import { IOutboxEventRepository } from '../interfaces/outbox-event.repository.interface';

/** TypeORM implementation of {@link IOutboxEventRepository}, bound to
 * `OUTBOX_EVENT_REPOSITORY` in {@link PersistenceModule}. */
@Injectable()
export class OutboxEventRepository implements IOutboxEventRepository {
  constructor(@InjectRepository(OutboxEvent) private readonly repo: Repository<OutboxEvent>) {}

  findById(id: string): Promise<OutboxEvent | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(data: DeepPartial<OutboxEvent>): Promise<OutboxEvent> {
    return this.repo.save(this.repo.create(data));
  }

  insertInTx(queryRunner: QueryRunner, data: DeepPartial<OutboxEvent>): Promise<OutboxEvent> {
    // save() joins the queryRunner's transaction via its manager; the row's DB-generated
    // id/created_at are returned merged onto the entity. The PK is DB-generated (never
    // preset), so this is always a straight INSERT.
    return queryRunner.manager.save(queryRunner.manager.create(OutboxEvent, data));
  }

  pollUnpublished(queryRunner: QueryRunner, limit: number): Promise<OutboxEvent[]> {
    // `pessimistic_write` + `skip_locked` render `... FOR UPDATE SKIP LOCKED` on Postgres, so a
    // second relay instance polling at the same instant claims the NEXT unlocked rows instead of
    // blocking — disjoint claims, never a double-publish. `.limit()` (not `.take()`) emits a plain
    // `LIMIT n` with no wrapping subquery, keeping the row-level lock on the base rows. Oldest
    // first (`created_at ASC`), served by the partial index `idx_outbox_unpublished`.
    return queryRunner.manager
      .createQueryBuilder(OutboxEvent, 'outbox')
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .where('outbox.publishedAt IS NULL')
      .orderBy('outbox.createdAt', 'ASC')
      .limit(limit)
      .getMany();
  }

  async markPublished(queryRunner: QueryRunner, ids: string[]): Promise<void> {
    // No-op on an empty batch — an `IN ()` predicate is invalid SQL and there is nothing to mark.
    if (ids.length === 0) {
      return;
    }
    // `published_at = now()` uses the DB clock (consistent with the other tx-aware writes). Runs on
    // the SAME queryRunner as pollUnpublished, so the mark commits with the claim. Ids are bound.
    await queryRunner.manager
      .createQueryBuilder()
      .update(OutboxEvent)
      .set({ publishedAt: () => 'now()' })
      .where('id IN (:...ids)', { ids })
      .execute();
  }
}
