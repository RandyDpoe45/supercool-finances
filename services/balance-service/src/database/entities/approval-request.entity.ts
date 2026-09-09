import { Column, Entity, PrimaryColumn } from 'typeorm';
import { ApprovalAction, ApprovalStatus } from './enums';

/**
 * Persists maker-checker (four-eyes) for balance-affecting admin operations. A maker
 * submits a proposed action; a DIFFERENT checker approves/rejects; only an APPROVED
 * request may be EXECUTED, and execution performs the real operation and writes an audit
 * row. `checker_id <> maker_id` is guarded in the service and backstopped by a DB CHECK
 * (`checker_id IS NULL OR checker_id <> maker_id`); the DB check can only fire once a
 * checker is set. FK (target_transaction) and the CHECK are defined by the migration.
 */
@Entity('approval_request')
export class ApprovalRequest {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({
    name: 'action_type',
    type: 'enum',
    enum: ApprovalAction,
    enumName: 'approval_action',
  })
  actionType!: ApprovalAction;

  @Column({ name: 'payload', type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({
    name: 'status',
    type: 'enum',
    enum: ApprovalStatus,
    enumName: 'approval_status',
    default: ApprovalStatus.Pending,
  })
  status!: ApprovalStatus;

  @Column({ name: 'maker_id', type: 'varchar' })
  makerId!: string;

  @Column({ name: 'checker_id', type: 'varchar', nullable: true })
  checkerId!: string | null;

  @Column({ name: 'target_transaction_id', type: 'uuid', nullable: true })
  targetTransactionId!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ name: 'executed_at', type: 'timestamptz', nullable: true })
  executedAt!: Date | null;
}
