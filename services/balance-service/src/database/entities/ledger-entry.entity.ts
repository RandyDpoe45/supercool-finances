import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Append-only, double-entry ledger row — the SOURCE OF TRUTH for money movement. Each row
 * is one signed leg of a transaction plus the resulting `balance_after` (the running fold);
 * legs of a transaction sum to zero. Never updated or deleted — a reversal appends new rows.
 *
 * `delta` and `balance_after` are `bigint` minor units (TypeORM surfaces `bigint` as a JS
 * `string` to preserve int64 precision). `created_at` defaults to `clock_timestamp()` (the
 * real insert instant), NOT `now()`/transaction-start: it is the per-account reconstruction
 * ordering key, monotonic because posting holds the account `FOR UPDATE` (its entries are
 * serialized). FKs and `idx_ledger_account_created` are defined by the CreateBalanceCore
 * migration.
 *
 * NOTE: append-only is CONVENTION-enforced at this step. There is intentionally no DB-level
 * trigger/REVOKE guard yet (the service connects as the schema owner, so a REVOKE would be
 * meaningless here) — DB-level enforcement is a deliberately deferred hardening step, not an
 * oversight. See docs/persistence.md.
 */
@Entity('ledger_entry')
export class LedgerEntry {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ name: 'delta', type: 'bigint' })
  delta!: string;

  @Column({ name: 'balance_after', type: 'bigint' })
  balanceAfter!: string;

  @Column({ name: 'currency', type: 'char', length: 3 })
  currency!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'clock_timestamp()' })
  createdAt!: Date;
}
