import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { OutboxEvent } from '../entities/outbox-event.entity';
import { IOutboxEventRepository } from './outbox-event.repository.interface';

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
}
