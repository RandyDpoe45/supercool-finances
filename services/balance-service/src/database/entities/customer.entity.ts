import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The balance-service's own representation of a customer (the money-domain user). Keycloak
 * holds only authentication; the human-facing profile a transfer needs to render lives here.
 *
 * The primary key `id` IS the Keycloak `sub` — the SAME value already stored in
 * `account.owner_id` (kept `varchar` so `owner_id` can FK to it without a type change). Only
 * the three profile fields a payee-confirmation flow needs are stored: `name` (masked before
 * it leaves the service — see the transfers `maskName` helper), `phone`, and `email`. Nothing
 * else — this is deliberately minimal.
 *
 * `phone` and `email` are UNIQUE (enforced at the DB level by the CreateCustomerAndAccountNumber
 * migration's `uq_customer_phone` / `uq_customer_email` indexes, not by ORM decorators — same as
 * `account`'s constraints).
 */
@Entity('customer')
export class Customer {
  @PrimaryColumn({ name: 'id', type: 'varchar' })
  id!: string;

  @Column({ name: 'name', type: 'varchar' })
  name!: string;

  @Column({ name: 'phone', type: 'varchar' })
  phone!: string;

  @Column({ name: 'email', type: 'varchar' })
  email!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
