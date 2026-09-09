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
}
