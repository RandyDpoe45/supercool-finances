import { Column, Entity, PrimaryColumn } from 'typeorm';
import { AccountKind, AccountStatus } from './enums';

/**
 * A balance-bearing account: a customer account or an internal system (per-rail
 * clearing) account. Carries the materialized posted `balance`, the materialized `held`
 * total, and per-period fixed-window spend counters — all locked and updated together
 * by the posting operation. Available balance (`balance - held`) is derived, never stored.
 *
 * Money (`balance`, `held`, `spent_today`, `spent_month`) is `bigint` minor units. TypeORM
 * surfaces `bigint` as a JS `string` (a JS `number` cannot hold the full int64 range without
 * precision loss), so these fields are typed `string` — never do float arithmetic on them.
 *
 * Foreign keys (currency) and constraints (held >= 0, partial owner/system-key indexes) are
 * enforced at the DB level by the CreateBalanceCore migration, not by ORM relations.
 * There is deliberately NO blanket `balance >= 0` check: clearing accounts may go negative
 * (net in transit); customer overdraft is enforced at debit time via `available >= amount`.
 */
@Entity('account')
export class Account {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ name: 'owner_id', type: 'varchar', nullable: true })
  ownerId!: string | null;

  @Column({ name: 'kind', type: 'enum', enum: AccountKind, enumName: 'account_kind' })
  kind!: AccountKind;

  @Column({ name: 'system_key', type: 'varchar', nullable: true })
  systemKey!: string | null;

  @Column({ name: 'currency', type: 'char', length: 3 })
  currency!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: AccountStatus,
    enumName: 'account_status',
    default: AccountStatus.Active,
  })
  status!: AccountStatus;

  @Column({ name: 'balance', type: 'bigint', default: 0 })
  balance!: string;

  @Column({ name: 'held', type: 'bigint', default: 0 })
  held!: string;

  @Column({ name: 'spent_today', type: 'bigint', default: 0 })
  spentToday!: string;

  @Column({ name: 'spent_today_date', type: 'date' })
  spentTodayDate!: string;

  @Column({ name: 'spent_month', type: 'bigint', default: 0 })
  spentMonth!: string;

  @Column({ name: 'spent_month_date', type: 'date' })
  spentMonthDate!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
