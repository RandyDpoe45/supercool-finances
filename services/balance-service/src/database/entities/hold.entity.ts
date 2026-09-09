import { Column, Entity, PrimaryColumn } from 'typeorm';
import { HoldStatus } from './enums';

/**
 * One row of the reservation ledger — funds reserved on an account for an in-flight
 * external outbound transfer but not yet posted. Append-only lifecycle
 * PLACED -> SETTLED | RELEASED | EXPIRED. Only PLACED holds count toward `account.held`:
 * `SUM(amount) WHERE status = 'PLACED'` per account == `account.held` (reconciliation).
 * The destination payee is reachable via the backing transaction (no direct payee FK).
 *
 * `amount` is `bigint` minor units, positive (CHECK amount > 0); TypeORM surfaces `bigint`
 * as a JS `string` to preserve int64 precision. FKs (account, transaction) are enforced by
 * the CreateBalanceSatellites migration.
 */
@Entity('hold')
export class Hold {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Column({ name: 'amount', type: 'bigint' })
  amount!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: HoldStatus,
    enumName: 'hold_status',
    default: HoldStatus.Placed,
  })
  status!: HoldStatus;

  @Column({ name: 'rail', type: 'varchar' })
  rail!: string;

  @Column({ name: 'external_ref', type: 'varchar', nullable: true })
  externalRef!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'settled_at', type: 'timestamptz', nullable: true })
  settledAt!: Date | null;

  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt!: Date | null;
}
