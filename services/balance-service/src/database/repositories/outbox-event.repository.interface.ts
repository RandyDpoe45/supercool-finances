import { DeepPartial } from 'typeorm';
import { OutboxEvent } from '../entities/outbox-event.entity';

/** DI token for {@link IOutboxEventRepository}. */
export const OUTBOX_EVENT_REPOSITORY = Symbol('OUTBOX_EVENT_REPOSITORY');

/** Persistence port for {@link OutboxEvent}. The relay poll (`pollUnpublished` with
 * FOR UPDATE SKIP LOCKED) and `markPublished` are deferred to the relay-worker step. */
export interface IOutboxEventRepository {
  findById(id: string): Promise<OutboxEvent | null>;
  create(data: DeepPartial<OutboxEvent>): Promise<OutboxEvent>;
}
