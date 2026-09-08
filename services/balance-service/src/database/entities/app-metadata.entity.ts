import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Minimal foundation table. It exists to prove the migration/entity pipeline runs
 * against the `balance` database on boot; the money-domain entities arrive in
 * spec 04. Column names are set explicitly to keep snake_case without depending on
 * a global naming strategy.
 */
@Entity('app_metadata')
export class AppMetadata {
  @PrimaryColumn({ name: 'key', type: 'varchar' })
  key!: string;

  @Column({ name: 'value', type: 'varchar' })
  value!: string;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
