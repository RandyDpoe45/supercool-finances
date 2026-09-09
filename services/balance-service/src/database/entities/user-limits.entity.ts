import { Column, Entity, PrimaryColumn } from 'typeorm';
import { UserLimitsScope } from './enums';

/**
 * Configurable amount caps applied to transfers: a per-transaction cap plus fixed
 * calendar-window daily and monthly amount caps (never rolling; no count-based velocity).
 * A global baseline row (`scope='global'`, `owner_id` NULL) plus per-customer overrides
 * (`scope='customer'`); the customer row wins over global at resolution time.
 *
 * Uniqueness `uq_user_limits_scope (scope, owner_id)` is `NULLS NOT DISTINCT` (Postgres 16)
 * so the single global row (owner_id NULL) is actually enforced — a plain unique treats
 * NULLs as distinct and would allow multiple global rows. Enforced by the migration.
 *
 * Caps are `bigint` minor units (nullable = no cap); TypeORM surfaces `bigint` as a JS
 * `string`. Table name is `user_limits` to avoid the SQL reserved word LIMIT.
 */
@Entity('user_limits')
export class UserLimits {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({
    name: 'scope',
    type: 'enum',
    enum: UserLimitsScope,
    enumName: 'user_limits_scope',
  })
  scope!: UserLimitsScope;

  @Column({ name: 'owner_id', type: 'varchar', nullable: true })
  ownerId!: string | null;

  @Column({ name: 'currency', type: 'char', length: 3 })
  currency!: string;

  @Column({ name: 'per_transaction_max', type: 'bigint', nullable: true })
  perTransactionMax!: string | null;

  @Column({ name: 'daily_max', type: 'bigint', nullable: true })
  dailyMax!: string | null;

  @Column({ name: 'monthly_max', type: 'bigint', nullable: true })
  monthlyMax!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
