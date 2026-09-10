import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PayeeStatus } from './enums';

/**
 * An enrolled external beneficiary a customer can send money to. Metadata about the destination
 * (display name, rail, external account number in `destination_ref`) — NOT a ledger account.
 *
 * **Usability is date-gated, not status-driven:** a destination is valid from `cooling_off_until`
 * onward — `now() >= cooling_off_until` — set at enrollment to `now() + PAYEE_COOLING_OFF_SECONDS`
 * (DB clock). There is NO status lifecycle: `status` stays at its DB default (`pending`) and
 * `activated_at` stays NULL — both are RESERVED for a future admin/self-disable flow and are
 * UNUSED for now (do not read them as a usability gate). Uniqueness `(owner_id, rail,
 * destination_ref)` is enforced by the migration (uq_payee).
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
