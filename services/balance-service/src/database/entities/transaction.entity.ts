import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TransactionStatus, TransactionType } from './enums';

/**
 * The header grouping a set of balancing ledger legs into one money movement. The
 * denormalized `debit_account_id` / `credit_account_id` FKs are an authz/query
 * convenience; the ledger entries remain authoritative. Reversals are new compensating
 * transactions (`reverses_transaction_id`), never mutations.
 *
 * `amount` is the positive `bigint` magnitude in minor units; TypeORM surfaces `bigint`
 * as a JS `string` to preserve full int64 precision. All FKs (accounts, payee, self,
 * currency) and the `idx_tx_account` index are defined by the CreateBalanceCore migration.
 */
@Entity('transaction')
export class Transaction {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ name: 'type', type: 'enum', enum: TransactionType, enumName: 'transaction_type' })
  type!: TransactionType;

  @Column({
    name: 'status',
    type: 'enum',
    enum: TransactionStatus,
    enumName: 'transaction_status',
  })
  status!: TransactionStatus;

  @Column({ name: 'amount', type: 'bigint' })
  amount!: string;

  @Column({ name: 'currency', type: 'char', length: 3 })
  currency!: string;

  @Column({ name: 'debit_account_id', type: 'uuid', nullable: true })
  debitAccountId!: string | null;

  @Column({ name: 'credit_account_id', type: 'uuid', nullable: true })
  creditAccountId!: string | null;

  @Column({ name: 'payee_id', type: 'uuid', nullable: true })
  payeeId!: string | null;

  @Column({ name: 'reverses_transaction_id', type: 'uuid', nullable: true })
  reversesTransactionId!: string | null;

  @Column({ name: 'initiated_by', type: 'varchar' })
  initiatedBy!: string;

  @Column({ name: 'failure_reason', type: 'varchar', nullable: true })
  failureReason!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'posted_at', type: 'timestamptz', nullable: true })
  postedAt!: Date | null;

  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt!: Date | null;

  /** The 2-minute pending-authorization deadline (`created_at` + 2 min, set from the DB clock
   * at initiate). Nullable — only a user-initiated PENDING transfer carries one; posted-directly
   * movements leave it NULL. Once `now() >= expires_at` the transfer is no longer valid and
   * lazily transitions to EXPIRED on the next access (confirm / read / next initiate). */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;
}
