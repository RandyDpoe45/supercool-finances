import { DeepPartial, QueryRunner } from 'typeorm';
import { OutboxEvent } from '../../entities/outbox-event.entity';

/** DI token for {@link IOutboxEventRepository}. */
export const OUTBOX_EVENT_REPOSITORY = Symbol('OUTBOX_EVENT_REPOSITORY');

/** Persistence port for {@link OutboxEvent}. The relay-worker poll (`pollUnpublished`, claimed
 * `FOR UPDATE SKIP LOCKED`) and `markPublished` back the in-process relay (spec 04 step 6). */
export interface IOutboxEventRepository {
  findById(id: string): Promise<OutboxEvent | null>;
  create(data: DeepPartial<OutboxEvent>): Promise<OutboxEvent>;
  /** Write the outbox row inside the given queryRunner's transaction — the SAME tx as the
   * ledger change it describes (transactional outbox, ADR-5). Returns the inserted row with
   * any DB-generated columns filled. */
  insertInTx(queryRunner: QueryRunner, data: DeepPartial<OutboxEvent>): Promise<OutboxEvent>;
  /** Claim up to `limit` unpublished rows (`published_at IS NULL`), oldest first, on the
   * given queryRunner's transaction with `FOR UPDATE SKIP LOCKED` — so two relay instances
   * polling concurrently claim DISJOINT rows and never double-publish. The rows stay locked
   * for the life of that transaction (the relay marks them published + commits in the same
   * tx). */
  pollUnpublished(queryRunner: QueryRunner, limit: number): Promise<OutboxEvent[]>;
  /** Stamp `published_at = now()` on the given ids inside the queryRunner's transaction — the
   * relay calls this AFTER the XADD, in the same tx as {@link pollUnpublished}, so a claimed
   * row is marked published exactly when its event is on the stream. No-op on an empty list. */
  markPublished(queryRunner: QueryRunner, ids: string[]): Promise<void>;
}
