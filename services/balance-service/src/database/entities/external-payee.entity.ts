import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PayeeStatus } from './enums';

/**
 * An enrolled external beneficiary a customer can send money to. Metadata about the
 * destination (name, rail, masked account ref) — NOT a ledger account. A destination is
 * valid only when `status = 'active'` AND `now() >= cooling_off_until`. Uniqueness
 * `(owner_id, rail, destination_ref)` is enforced by the migration (uq_payee).
 */
@Entity('external_payee')
export class ExternalPayee {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ name: 'owner_id', type: 'varchar' })
  ownerId!: string;

  @Column({ name: 'display_name', type: 'varchar' })
  displayName!: string;

  @Column({ name: 'rail', type: 'varchar' })
  rail!: string;

  @Column({ name: 'destination_ref', type: 'varchar' })
  destinationRef!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: PayeeStatus,
    enumName: 'payee_status',
    default: PayeeStatus.Pending,
  })
  status!: PayeeStatus;

  @Column({ name: 'cooling_off_until', type: 'timestamptz' })
  coolingOffUntil!: Date;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt!: Date | null;
}
