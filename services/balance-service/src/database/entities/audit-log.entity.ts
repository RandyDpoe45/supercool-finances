import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Immutable, append-only record of privileged /admin-plane actions (freeze/unfreeze, limit
 * change, reversal approval/execution, simulated inbound). Ordinary customer transactions
 * are NOT written here — the ledger is their audit trail. One row per admin action.
 *
 * `id` is `bigint GENERATED ALWAYS AS IDENTITY` (DB-generated append-only order); TypeORM
 * surfaces `bigint` as a JS `string`. `(target_type, target_id)` is a polymorphic pointer,
 * intentionally NOT an FK. Metadata carries before/after values, approval ids, etc.
 *
 * NOTE: append-only is CONVENTION-enforced at this step — no DB-level trigger/REVOKE guard
 * (the service connects as the schema owner, so a REVOKE would be meaningless here). Same
 * deferred-hardening posture as `ledger_entry`; see docs/persistence.md.
 */
@Entity('audit_log')
export class AuditLog {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id!: string;

  @Column({ name: 'actor_id', type: 'varchar' })
  actorId!: string;

  @Column({ name: 'action', type: 'varchar' })
  action!: string;

  @Column({ name: 'target_type', type: 'varchar', nullable: true })
  targetType!: string | null;

  @Column({ name: 'target_id', type: 'varchar', nullable: true })
  targetId!: string | null;

  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
