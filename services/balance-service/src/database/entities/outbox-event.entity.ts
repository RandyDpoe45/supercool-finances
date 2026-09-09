import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The transactional outbox. One row is written in the SAME DB transaction as the ledger
 * change it describes; the relay worker polls unpublished rows
 * (`WHERE published_at IS NULL`, FOR UPDATE SKIP LOCKED), XADDs to the Redis stream, then
 * stamps `published_at` (at-least-once). The row `id` IS the `event_id` the analytics
 * consumer dedups on. FK (transaction) and the partial index
 * `idx_outbox_unpublished (created_at) WHERE published_at IS NULL` are set by the migration.
 */
@Entity('outbox_event')
export class OutboxEvent {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Column({ name: 'event_type', type: 'varchar' })
  eventType!: string;

  @Column({ name: 'payload', type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;
}
