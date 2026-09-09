import { Column, Entity, PrimaryColumn } from 'typeorm';
import { IdempotencyStatus } from './enums';

/**
 * Guarantees a money-moving request is applied at most once. The `key` is client-supplied
 * (the Idempotency-Key header); a server-computed `request_fingerprint` (hash of the
 * canonical business tuple) detects reuse of a key with different parameters. The linked
 * transaction is the source of truth for regenerating the reply on replay — no stored
 * response snapshot. Keys expire 24h after creation.
 *
 * PK is COMPOSITE `(owner_id, key)` — a key is unique per caller, not globally, so callers
 * cannot collide or probe each other. `idx_idem_expires (expires_at)` backs the cleanup
 * sweep; `idx_idem_fingerprint (owner_id, request_fingerprint, created_at)` backs the soft
 * duplicate-suppression lookup. FK (transaction) and indexes are defined by the migration.
 */
@Entity('idempotency_key')
export class IdempotencyKey {
  @PrimaryColumn({ name: 'owner_id', type: 'varchar' })
  ownerId!: string;

  @PrimaryColumn({ name: 'key', type: 'varchar' })
  key!: string;

  @Column({ name: 'request_fingerprint', type: 'varchar' })
  requestFingerprint!: string;

  @Column({ name: 'transaction_id', type: 'uuid', nullable: true })
  transactionId!: string | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: IdempotencyStatus,
    enumName: 'idempotency_status',
  })
  status!: IdempotencyStatus;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;
}
